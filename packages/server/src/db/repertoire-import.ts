import type { RepertoireOrigin } from "@chess-coach/shared";
import type { Database } from "./open.js";
import { deleteRepertoireCardsNoVariationPlays } from "./repertoire-cards.js";
import {
  deleteRepertoireUnit,
  listRepertoireOwnMoveKeys,
  openRunsOfRepertoireUnit,
  REPERTOIRE_REBUILD_GROUP_SUFFIX,
  type RepertoireSide,
  repertoireGeneratedSql,
} from "./repertoires.js";

/**
 * Brings a unit read from a PGN file in line with the file as it reads now, and removes one. The
 * student imports the same file again and again while the repertoire settles, so a sync changes only
 * what the file changed: a move still in it keeps its row id, its schedule and its reason, a move it
 * dropped leaves the drill, and a new move arrives as new. Each operation is one transaction, refuses
 * while a drill uses the unit, and can run as a dry run that returns the summary of a real run and
 * writes nothing.
 */

/** One move of the unit in the shape the PGN reader returns it, which fits this type as it is. */
export interface ImportedRepertoireMove {
  kind: "own" | "reply";
  position_key: string;
  ply: number;
  /** The SAN moves played before this one, from move 1. */
  line_san: readonly string[];
  move_uci: string;
  move_san: string;
  reach: number;
  /** The student's reason for an own move; none, or blank, leaves the reason already stored. */
  reason?: string | null;
  cp_loss?: number | null;
}

export interface ImportedUnitName {
  side: RepertoireSide;
  group: string;
  variation: string;
}

/** A reason that went with a row the file no longer holds, so the student can write it back. */
export interface ImportedUnitRemovedReason {
  /** The SAN moves played before the move, from move 1. */
  line: string[];
  move: string;
  text: string;
}

export interface ImportedUnitSyncSummary {
  repertoire_id: number;
  created: boolean;
  own_added: number;
  own_removed: number;
  own_kept: number;
  replies_added: number;
  replies_removed: number;
  replies_kept: number;
  /** Own moves, new or kept, whose reason the file gave. */
  reasons_from_file: number;
  /** Kept own moves whose file gave no reason and whose stored one stayed. */
  reasons_kept: number;
  cards_deleted: number;
  reasons_removed: ImportedUnitRemovedReason[];
}

export interface ImportedUnitDeleteSummary {
  repertoire_id: number;
  own_removed: number;
  replies_removed: number;
  /** The reasons that go with the unit, which the student may want to keep in the file. */
  reasons_removed: ImportedUnitRemovedReason[];
  cards_deleted: number;
  /** Cards of the unit's moves that another unit still stores, schedule untouched. */
  cards_kept: number;
}

export type ImportedUnitSyncRefusalCode =
  | "not_imported"
  | "group_taken"
  | "invalid_name"
  | "empty"
  | "drill_open";

export type ImportedUnitDeleteRefusalCode = "not_found" | "not_imported" | "drill_open";

type ImportedUnitOutcome<Summary, Code extends string> =
  | { ok: true; summary: Summary }
  | { ok: false; code: Code; message: string };

export type ImportedUnitSyncResult = ImportedUnitOutcome<
  ImportedUnitSyncSummary,
  ImportedUnitSyncRefusalCode
>;
export type ImportedUnitDeleteResult = ImportedUnitOutcome<
  ImportedUnitDeleteSummary,
  ImportedUnitDeleteRefusalCode
>;

const refuse = <Code extends string>(
  code: Code,
  message: string,
): { ok: false; code: Code; message: string } => ({ ok: false, code, message });

// A dry run does the real work and takes it back, so the summary it returns is the one a real run
// would give, the card sweep included, which no read of the rows could count without repeating it.
class DryRunUndo extends Error {
  constructor(readonly outcome: unknown) {
    super("dry run");
  }
}

function runInOneTransaction<Outcome>(db: Database, dryRun: boolean, work: () => Outcome): Outcome {
  try {
    return db.transaction((): Outcome => {
      const outcome = work();
      if (dryRun) throw new DryRunUndo(outcome);
      return outcome;
    })();
  } catch (error) {
    if (error instanceof DryRunUndo) return error.outcome as Outcome;
    throw error;
  }
}

// ---------------------------------------------------------------- what is stored

interface StoredUnit {
  id: number;
  origin: RepertoireOrigin;
}

interface StoredPositionRow {
  id: number;
  kind: "own" | "reply";
  position_key: string;
  move_uci: string;
  move_san: string;
  /** JSON, as the generator and this module store it. */
  line_san: string;
  idea: string | null;
}

const findStoredUnitByName = (db: Database, unit: ImportedUnitName): StoredUnit | undefined =>
  db
    .prepare(
      "SELECT id, origin FROM repertoires WHERE side = ? AND group_name = ? AND variation_name = ?",
    )
    .get(unit.side, unit.group, unit.variation) as StoredUnit | undefined;

const findStoredUnitById = (db: Database, repertoireId: number): StoredUnit | undefined =>
  db.prepare("SELECT id, origin FROM repertoires WHERE id = ?").get(repertoireId) as
    | StoredUnit
    | undefined;

const groupHoldsGeneratedUnit = (db: Database, side: RepertoireSide, group: string): boolean =>
  db
    .prepare(
      `SELECT 1 FROM repertoires
       WHERE side = ? AND group_name = ? AND ${repertoireGeneratedSql("origin")} LIMIT 1`,
    )
    .get(side, group) !== undefined;

const listStoredPositionRows = (db: Database, repertoireId: number): StoredPositionRow[] =>
  db
    .prepare(
      `SELECT id, kind, position_key, move_uci, move_san, line_san, idea
       FROM repertoire_positions WHERE repertoire_id = ? ORDER BY id`,
    )
    .all(repertoireId) as StoredPositionRow[];

const hasText = (text: string | null | undefined): text is string =>
  text !== null && text !== undefined && text.trim() !== "";

const removedReasonsOf = (rows: readonly StoredPositionRow[]): ImportedUnitRemovedReason[] =>
  rows.flatMap((row) =>
    hasText(row.idea)
      ? [{ line: JSON.parse(row.line_san) as string[], move: row.move_san, text: row.idea }]
      : [],
  );

const countOwn = (items: ReadonlyArray<{ kind: "own" | "reply" }>): number =>
  items.filter((item) => item.kind === "own").length;

// ---------------------------------------------------------------- the sync

// The SQL that hides a rebuild's working copy compares without regard to case (`LIKE`), and a server
// start deletes every group it hides. A name that differs from the suffix only in case would be
// hidden and then deleted with the student's moves, so it is refused like the suffix itself.
const hidesAsRebuildCopy = (name: string): boolean =>
  name.toLowerCase().endsWith(REPERTOIRE_REBUILD_GROUP_SUFFIX);

function refuseUnusableInput(
  unit: ImportedUnitName,
  moves: readonly ImportedRepertoireMove[],
): ImportedUnitSyncResult | null {
  if (hidesAsRebuildCopy(unit.group) || hidesAsRebuildCopy(unit.variation)) {
    return refuse(
      "invalid_name",
      `the group and the variation may not end in "${REPERTOIRE_REBUILD_GROUP_SUFFIX}", which names the working copy of a rebuild`,
    );
  }
  if (countOwn(moves) === 0) {
    return refuse(
      "empty",
      "the moves hold no move of the student's, so there is nothing to import",
    );
  }
  return null;
}

function refuseStoredState(
  db: Database,
  unit: ImportedUnitName,
  stored: StoredUnit | undefined,
): ImportedUnitSyncResult | null {
  if (stored && stored.origin !== "pgn") {
    return refuse(
      "not_imported",
      `the line "${unit.variation}" of "${unit.group}" was built by the app, and only an imported line can be synced`,
    );
  }
  if (groupHoldsGeneratedUnit(db, unit.side, unit.group)) {
    return refuse(
      "group_taken",
      `the group "${unit.group}" already holds a line built by the app, and an imported line needs a group of its own`,
    );
  }
  if (stored && openRunsOfRepertoireUnit(db, stored.id).length > 0) {
    return refuse("drill_open", "a drill is using this line, so end the drill first");
  }
  return null;
}

// The origin goes in with the row: the column defaults to generated, so creating the unit through
// `createRepertoireVariation` would leave it one forgotten write away from the app's own unit.
function insertImportedUnit(db: Database, unit: ImportedUnitName): number {
  const inserted = db
    .prepare(
      "INSERT INTO repertoires (side, group_name, variation_name, origin) VALUES (?, ?, ?, 'pgn')",
    )
    .run(unit.side, unit.group, unit.variation);
  return Number(inserted.lastInsertRowid);
}

const rowKeyOf = (kind: string, positionKey: string, uci: string): string =>
  `${kind}|${positionKey}|${uci}`;

interface SyncPlan {
  /** Stored rows the new set no longer holds. */
  leaving: StoredPositionRow[];
  /** Stored rows the new set holds, with the move that replaces their columns. */
  staying: Array<{ row: StoredPositionRow; move: ImportedRepertoireMove }>;
  /** Moves with no stored row, in the order given. */
  arriving: ImportedRepertoireMove[];
}

// A row is the same row when its kind, position and move are: nothing else about it identifies it,
// since the line it is reached by and its reach change whenever the file does. A key given twice is
// matched once and its second occurrence is inserted, where the unique index refuses it.
function planSync(
  stored: readonly StoredPositionRow[],
  moves: readonly ImportedRepertoireMove[],
): SyncPlan {
  const storedByKey = new Map(
    stored.map((row) => [rowKeyOf(row.kind, row.position_key, row.move_uci), row]),
  );
  const matched = new Set<number>();
  const staying: SyncPlan["staying"] = [];
  const arriving: ImportedRepertoireMove[] = [];
  for (const move of moves) {
    const row = storedByKey.get(rowKeyOf(move.kind, move.position_key, move.move_uci));
    if (row && !matched.has(row.id)) {
      matched.add(row.id);
      staying.push({ row, move });
    } else {
      arriving.push(move);
    }
  }
  return { leaving: stored.filter((row) => !matched.has(row.id)), staying, arriving };
}

const reasonOf = (move: ImportedRepertoireMove): string | null =>
  move.kind === "own" && hasText(move.reason) ? move.reason : null;

// A reply is nobody's to explain, and the figures of the engine belong to an own move.
const costOf = (move: ImportedRepertoireMove): number | null =>
  move.kind === "own" ? (move.cp_loss ?? null) : null;

// The rows that leave go first: a position whose answer changed frees the slot of the unique index
// that holds one own move per position before the new answer takes it.
function writePlan(db: Database, repertoireId: number, plan: SyncPlan): void {
  const remove = db.prepare("DELETE FROM repertoire_positions WHERE id = ?");
  for (const row of plan.leaving) remove.run(row.id);

  const update = db.prepare(
    `UPDATE repertoire_positions
     SET ply = @ply, line_san = @line_san, move_san = @move_san, reach = @reach,
         cp_loss = @cp_loss, idea = @idea, source = 'pgn'
     WHERE id = @id`,
  );
  for (const { row, move } of plan.staying) {
    update.run({
      id: row.id,
      ply: move.ply,
      line_san: JSON.stringify(move.line_san),
      move_san: move.move_san,
      reach: move.reach,
      cp_loss: costOf(move),
      idea: reasonOf(move) ?? row.idea,
    });
  }

  const insert = db.prepare(
    `INSERT INTO repertoire_positions
       (repertoire_id, kind, position_key, ply, line_san, move_uci, move_san, reach, idea, source,
        cp_loss)
     VALUES (@repertoire_id, @kind, @position_key, @ply, @line_san, @move_uci, @move_san, @reach,
             @idea, 'pgn', @cp_loss)`,
  );
  for (const move of plan.arriving) {
    insert.run({
      repertoire_id: repertoireId,
      kind: move.kind,
      position_key: move.position_key,
      ply: move.ply,
      line_san: JSON.stringify(move.line_san),
      move_uci: move.move_uci,
      move_san: move.move_san,
      reach: move.reach,
      idea: reasonOf(move),
      cp_loss: costOf(move),
    });
  }
}

function summarizeSync(
  repertoireId: number,
  created: boolean,
  plan: SyncPlan,
  cardsDeleted: number,
): ImportedUnitSyncSummary {
  const stayingMoves = plan.staying.map(({ move }) => move);
  const keptOwn = plan.staying.filter(({ row }) => row.kind === "own");
  return {
    repertoire_id: repertoireId,
    created,
    own_added: countOwn(plan.arriving),
    own_removed: countOwn(plan.leaving),
    own_kept: keptOwn.length,
    replies_added: plan.arriving.length - countOwn(plan.arriving),
    replies_removed: plan.leaving.length - countOwn(plan.leaving),
    replies_kept: plan.staying.length - keptOwn.length,
    reasons_from_file: [...stayingMoves, ...plan.arriving].filter((move) => reasonOf(move) !== null)
      .length,
    reasons_kept: keptOwn.filter(({ row, move }) => reasonOf(move) === null && hasText(row.idea))
      .length,
    cards_deleted: cardsDeleted,
    reasons_removed: removedReasonsOf(plan.leaving),
  };
}

// The cards are swept from the keys the unit held before the rows changed, once they have: a card
// goes only when no unit stores its position and move any more, so the move of another unit or one
// that stayed keeps its schedule, and every rating ever given stays in `drill_reviews`.
function syncMovesInto(
  db: Database,
  repertoireId: number,
  created: boolean,
  moves: readonly ImportedRepertoireMove[],
): ImportedUnitSyncSummary {
  const keysBefore = listRepertoireOwnMoveKeys(db, repertoireId);
  const plan = planSync(listStoredPositionRows(db, repertoireId), moves);
  writePlan(db, repertoireId, plan);
  const swept = deleteRepertoireCardsNoVariationPlays(db, keysBefore);
  return summarizeSync(repertoireId, created, plan, swept.deleted);
}

/**
 * Makes the imported unit `unit` equal to `moves`, which are the PGN reader's output, creating the
 * unit when it is new. A refusal changes nothing, and so does a failure part way: the sync is one
 * transaction. `dryRun` returns the summary the real run would and leaves every table as it was.
 *
 * `at` is the clock the caller injects, as `deleteRepertoireUnit` takes it. Neither the unit nor
 * its rows carry a time, so a sync has nothing to stamp with it.
 */
export function syncImportedRepertoireUnit(
  db: Database,
  unit: ImportedUnitName,
  moves: readonly ImportedRepertoireMove[],
  _at: string,
  dryRun: boolean,
): ImportedUnitSyncResult {
  const unusable = refuseUnusableInput(unit, moves);
  if (unusable) return unusable;
  return runInOneTransaction(db, dryRun, (): ImportedUnitSyncResult => {
    const stored = findStoredUnitByName(db, unit);
    const refused = refuseStoredState(db, unit, stored);
    if (refused) return refused;
    const repertoireId = stored?.id ?? insertImportedUnit(db, unit);
    return { ok: true, summary: syncMovesInto(db, repertoireId, stored === undefined, moves) };
  });
}

// ---------------------------------------------------------------- the delete

function deleteStoredUnit(
  db: Database,
  repertoireId: number,
  at: string,
): ImportedUnitDeleteResult {
  const stored = findStoredUnitById(db, repertoireId);
  if (!stored) return refuse("not_found", `no line has the id ${repertoireId}`);
  if (stored.origin !== "pgn") {
    return refuse(
      "not_imported",
      `line ${repertoireId} was built by the app, and only an imported line can be removed here`,
    );
  }
  if (openRunsOfRepertoireUnit(db, repertoireId).length > 0) {
    return refuse("drill_open", "a drill is using this line, so end the drill first");
  }
  const rows = listStoredPositionRows(db, repertoireId);
  const deletion = deleteRepertoireUnit(db, repertoireId, at);
  return {
    ok: true,
    summary: {
      repertoire_id: repertoireId,
      own_removed: countOwn(rows),
      replies_removed: rows.length - countOwn(rows),
      reasons_removed: removedReasonsOf(rows),
      cards_deleted: deletion.cardsDeleted,
      cards_kept: deletion.cardsKept,
    },
  };
}

/**
 * Deletes the imported unit `repertoireId` with its rows and the cards no other unit stores. A
 * unit built by the app is refused, which `deleteRepertoireUnit` alone would not do, and so is one
 * a drill is using, where that function would end the drill under the student. The same `dryRun`
 * rule as the sync applies.
 */
export function deleteImportedRepertoireUnit(
  db: Database,
  repertoireId: number,
  at: string,
  dryRun: boolean,
): ImportedUnitDeleteResult {
  return runInOneTransaction(db, dryRun, () => deleteStoredUnit(db, repertoireId, at));
}
