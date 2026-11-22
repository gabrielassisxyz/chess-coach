import type { RepertoireOrigin } from "@chess-coach/shared";
import type { Database } from "./open.js";
import { deleteRepertoireCardsNoVariationPlays } from "./repertoire-cards.js";
import { endTrainingRun } from "./training.js";

export type RepertoireSide = "white" | "black";
/**
 * How a move entered a variation: fixed by the opening, popular in the explorer, the engine's, a
 * reply stored past the coverage goal because it is the most played one there, added by a game the
 * student played, or read from a PGN file. The column has no check, so this union is the one list of
 * the values; `CoverageSourceSchema` in shared names the same six, and a test holds them together.
 */
export type RepertoireMoveSource = "setup" | "explorer" | "engine" | "mainline" | "game" | "pgn";

export interface RepertoireRow {
  id: number;
  side: RepertoireSide;
  group_name: string;
  variation_name: string;
}

/** The style points a variation was built with; the generator's own type has the same shape. */
export interface StoredRepertoirePoints {
  effectiveness: number;
  soundness: number;
  learnability: number;
}

export interface NewRepertoire {
  side: RepertoireSide;
  groupName: string;
  variationName: string;
  /** What the run weighed White's candidates by; left out, the unit keeps none, as one built before they were stored. */
  points?: StoredRepertoirePoints | null;
  /** The line of the Italian a variation is built at, ending on White's forced move; null for any other unit. */
  branch?: readonly string[] | null;
}

/** What a stored variation was built with: each is null for a unit built before they were stored. */
export interface StoredRepertoireBuild {
  points: StoredRepertoirePoints | null;
  branch: string[] | null;
}

/** Where a row sits: the same position reached by a likelier line replaces these fields only. */
export interface RepertoireRowPlace {
  repertoireId: number;
  positionKey: string;
  ply: number;
  line: string[];
  reach: number;
  openingName: string | null;
}

export interface NewRepertoireMove extends RepertoireRowPlace {
  uci: string;
  san: string;
  share: number | null;
  source: RepertoireMoveSource;
}

export interface RepertoireResultCounts {
  wins: number;
  draws: number;
  losses: number;
}

export interface NewRepertoireOwnMove extends NewRepertoireMove {
  /** Centipawns lost against the engine's best; null for a move no engine measured, as one read from a PGN file. */
  cpLoss: number | null;
  /** The position after the move, in centipawns from White's side; a mate is 10000. Null where no engine measured it. */
  evalCp: number | null;
  /** How deep the engine looked for `evalCp` and `cpLoss`; null, or left out, when it is not known. */
  evalDepth?: number | null;
  results: RepertoireResultCounts | null;
}

export interface StoredRepertoireOwnMove {
  id: number;
  move_uci: string;
  move_san: string;
}

/** A reply stored past the coverage goal, read back so a rerun follows it instead of choosing again. */
export interface StoredRepertoireContinuation {
  move_uci: string;
  share: number | null;
  source: "mainline" | "engine";
}

export interface RepertoireCounts {
  ownMoves: number;
  replies: number;
  /** Replies stored past the coverage goal as the most played one. */
  mainlineReplies: number;
  /** Replies stored past the coverage goal as the engine's best, where the explorer had too few games. */
  engineReplies: number;
  deepestPly: number;
  total: number;
}

/**
 * A rebuild walks its new rows into a copy of the unit, kept under the unit's group with this suffix
 * until one transaction moves them onto the unit. Only the rebuild reads the copy: every query that
 * lists or finds units for the rest of the app leaves it out with `repertoireRebuildCopySql`.
 */
export const REPERTOIRE_REBUILD_GROUP_SUFFIX = " (rebuilding)";

/** The SQL condition that the group named in `groupColumn` is a rebuild's copy. */
export function repertoireRebuildCopySql(groupColumn: string): string {
  return `(${groupColumn} LIKE '%${REPERTOIRE_REBUILD_GROUP_SUFFIX}')`;
}

/**
 * The SQL condition that the unit whose origin is in `originColumn` was walked by the generator.
 * Every query through which the app picks units by itself, to write reasons into them, review games
 * against them, rebuild them or name them as the unit of an opening, takes this: a line read from a
 * PGN file is the student's, and only importing its file again changes it. Drills and listings do
 * not take it, since an imported unit is practised like any other.
 */
export function repertoireGeneratedSql(originColumn: string): string {
  return `(${originColumn} = 'generated')`;
}

/** A White move with no idea yet, carrying what its text is written from. */
export interface RepertoireIdeaTarget {
  id: number;
  variationName: string;
  ply: number;
  /** The moves played before this one, in SAN. */
  line: string[];
  san: string;
  uci: string;
  /** The position after the move, in centipawns from White's side; a mate is 10000. */
  evalCp: number;
}

// The oldest of the group: a rerun must land on the variation it built, even if the data has moved
// since and today's answer to 3...Bc5 would be named differently. Only the generator's own: a rebuild,
// the Italian's branch list and the review's fallback unit must never land on an imported one, whose
// id may be the lower.
export function findFirstRepertoireVariation(
  db: Database,
  side: RepertoireSide,
  groupName: string,
): RepertoireRow | undefined {
  return db
    .prepare(
      `SELECT id, side, group_name, variation_name FROM repertoires
       WHERE side = ? AND group_name = ? AND ${repertoireGeneratedSql("origin")}
       ORDER BY id LIMIT 1`,
    )
    .get(side, groupName) as RepertoireRow | undefined;
}

/** The variation of a group with this name: a variation built at a branch point is found by it. */
export function findRepertoireVariationByName(
  db: Database,
  side: RepertoireSide,
  groupName: string,
  variationName: string,
): RepertoireRow | undefined {
  return db
    .prepare(
      "SELECT id, side, group_name, variation_name FROM repertoires WHERE side = ? AND group_name = ? AND variation_name = ?",
    )
    .get(side, groupName, variationName) as RepertoireRow | undefined;
}

/** The oldest variation of a group that expects this move in this position, if any does. */
export function findRepertoireVariationPlaying(
  db: Database,
  side: RepertoireSide,
  groupName: string,
  move: { positionKey: string; uci: string },
): RepertoireRow | undefined {
  return db
    .prepare(
      `SELECT r.id, r.side, r.group_name, r.variation_name
       FROM repertoires r JOIN repertoire_positions p ON p.repertoire_id = r.id
       WHERE r.side = ? AND r.group_name = ? AND p.kind = 'own' AND p.position_key = ?
         AND p.move_uci = ?
       ORDER BY r.id LIMIT 1`,
    )
    .get(side, groupName, move.positionKey, move.uci) as RepertoireRow | undefined;
}

export function createRepertoireVariation(db: Database, repertoire: NewRepertoire): RepertoireRow {
  const inserted = db
    .prepare(
      `INSERT INTO repertoires
         (side, group_name, variation_name, points_effectiveness, points_soundness,
          points_learnability, branch_san)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repertoire.side,
      repertoire.groupName,
      repertoire.variationName,
      repertoire.points?.effectiveness ?? null,
      repertoire.points?.soundness ?? null,
      repertoire.points?.learnability ?? null,
      repertoire.branch ? JSON.stringify(repertoire.branch) : null,
    );
  return {
    id: Number(inserted.lastInsertRowid),
    side: repertoire.side,
    group_name: repertoire.groupName,
    variation_name: repertoire.variationName,
  };
}

/** Every variation of a group, oldest first. */
export function listRepertoireGroupVariations(
  db: Database,
  side: RepertoireSide,
  groupName: string,
): RepertoireRow[] {
  return db
    .prepare("SELECT * FROM repertoires WHERE side = ? AND group_name = ? ORDER BY id")
    .all(side, groupName) as RepertoireRow[];
}

/** Every variation of a group goes, with its positions: a rebuild's rows are kept under one apart. */
export function deleteRepertoireGroupVariations(
  db: Database,
  side: RepertoireSide,
  groupName: string,
): void {
  db.prepare("DELETE FROM repertoires WHERE side = ? AND group_name = ?").run(side, groupName);
}

/** A rebuild's copy found in the database: its group and the rows it held. */
export interface RepertoireRebuildCopy {
  side: RepertoireSide;
  groupName: string;
  rows: number;
}

/**
 * Removes every rebuild's copy with its rows, oldest first. No rebuild outlives the process that
 * ran it, so at boot a copy is what a rebuild left when its process died; the unit it was rebuilding
 * is another group, which this never touches.
 */
export function removeRepertoireRebuildCopies(db: Database): RepertoireRebuildCopy[] {
  return db.transaction((): RepertoireRebuildCopy[] => {
    const copies = db
      .prepare(
        `SELECT r.side, r.group_name, COUNT(p.id) AS position_rows
         FROM repertoires r LEFT JOIN repertoire_positions p ON p.repertoire_id = r.id
         WHERE ${repertoireRebuildCopySql("r.group_name")}
         GROUP BY r.side, r.group_name ORDER BY MIN(r.id)`,
      )
      .all() as Array<{ side: RepertoireSide; group_name: string; position_rows: number }>;
    for (const copy of copies) deleteRepertoireGroupVariations(db, copy.side, copy.group_name);
    return copies.map((copy) => ({
      side: copy.side,
      groupName: copy.group_name,
      rows: copy.position_rows,
    }));
  })();
}

export function renameRepertoireVariation(
  db: Database,
  repertoireId: number,
  variationName: string,
): void {
  db.prepare("UPDATE repertoires SET variation_name = ? WHERE id = ?").run(
    variationName,
    repertoireId,
  );
}

/**
 * Puts the positions of one variation in place of another's, which go, and deletes the variation
 * they came from. Row ids stay, so whatever points at a moved row keeps pointing at it.
 */
export function moveRepertoirePositionsOnto(
  db: Database,
  targetId: number,
  sourceId: number,
): void {
  db.prepare("DELETE FROM repertoire_positions WHERE repertoire_id = ?").run(targetId);
  db.prepare("UPDATE repertoire_positions SET repertoire_id = ? WHERE repertoire_id = ?").run(
    targetId,
    sourceId,
  );
  db.prepare("DELETE FROM repertoires WHERE id = ?").run(sourceId);
}

/** The position and move of each White move of a variation, which is what a review card is keyed by. */
export function listRepertoireOwnMoveKeys(
  db: Database,
  repertoireId: number,
): Array<{ positionKey: string; uci: string }> {
  return db
    .prepare(
      `SELECT position_key AS positionKey, move_uci AS uci FROM repertoire_positions
       WHERE repertoire_id = ? AND kind = 'own' ORDER BY id`,
    )
    .all(repertoireId) as Array<{ positionKey: string; uci: string }>;
}

/** What deleting a unit removed, and the games whose review went with it. */
export interface RepertoireUnitDeletion {
  /** The unit's rows: its setup, White's answers and Black's replies. */
  positions: number;
  /** Cards of the unit's White moves that no unit stores any more. */
  cardsDeleted: number;
  /** Cards of the unit's White moves that another unit still stores, schedule and reviews untouched. */
  cardsKept: number;
  /** Open practice runs that pointed at the unit, ended as discarded. */
  runsEnded: number;
  /** The games whose review named the unit, by id: the cascade removed those rows. */
  gamesToReview: number[];
}

const gamesReviewedAgainstUnit = (db: Database, repertoireId: number): number[] =>
  (
    db
      .prepare(
        "SELECT game_id FROM repertoire_game_reviews WHERE repertoire_id = ? ORDER BY game_id",
      )
      .all(repertoireId) as Array<{ game_id: number }>
  ).map((row) => row.game_id);

// A run still open is on the board, or was left open by a server that died. One whose current item
// names the unit, or whose queue holds the unit's rows among other units' (a drill over a group, a
// side or the units found in games), would serve rows that are gone, from a merge that no longer
// exists. Only a drill's queue holds repertoire rows; a card or a puzzle id in another run can carry
// the same number.
export function openRunsOfRepertoireUnit(db: Database, repertoireId: number): number[] {
  const rows = db
    .prepare(
      `SELECT r.id FROM training_runs r
       WHERE r.ended_at IS NULL
         AND (json_extract(r.current_json, '$.repertoire_id') = @unit
              OR EXISTS (SELECT 1 FROM json_each(r.items_json) AS item
                         JOIN repertoire_positions p ON p.id = json_extract(item.value, '$.id')
                         WHERE json_extract(item.value, '$.kind') = 'repertoire'
                           AND p.repertoire_id = @unit))
       ORDER BY r.id`,
    )
    .all({ unit: repertoireId }) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/**
 * Deletes one unit and what would dangle after it, in one transaction: a failure leaves the unit,
 * its cards and the runs as they were. Its positions, its games' reviews and the drill's first
 * attempts under it go through the cascade, a card goes once no unit stores its move, and an open
 * run that points at the unit is discarded.
 * Reviewing those games again is the caller's, after the commit: a review can wait on the explorer
 * and the engine.
 */
export function deleteRepertoireUnit(
  db: Database,
  repertoireId: number,
  at: string,
): RepertoireUnitDeletion {
  return db.transaction((): RepertoireUnitDeletion => {
    const ownMoves = listRepertoireOwnMoveKeys(db, repertoireId);
    const positions = repertoireCounts(db, repertoireId).total;
    const gamesToReview = gamesReviewedAgainstUnit(db, repertoireId);
    const runIds = openRunsOfRepertoireUnit(db, repertoireId);
    for (const runId of runIds) endTrainingRun(db, runId, "discarded", at);
    if (db.prepare("DELETE FROM repertoires WHERE id = ?").run(repertoireId).changes === 0) {
      throw new Error(`repertoire ${repertoireId} does not exist`);
    }
    const cards = deleteRepertoireCardsNoVariationPlays(db, ownMoves);
    return {
      positions,
      cardsDeleted: cards.deleted,
      cardsKept: cards.kept,
      runsEnded: runIds.length,
      gamesToReview,
    };
  })();
}

/** How many of a variation's White moves are written with each SAN. */
export function countRepertoireOwnMovesBySan(
  db: Database,
  repertoireId: number,
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT move_san, COUNT(*) AS uses FROM repertoire_positions
       WHERE repertoire_id = ? AND kind = 'own' GROUP BY move_san`,
    )
    .all(repertoireId) as Array<{ move_san: string; uses: number }>;
  return new Map(rows.map((row) => [row.move_san, row.uses]));
}

export function findRepertoireOwnMove(
  db: Database,
  repertoireId: number,
  positionKey: string,
): StoredRepertoireOwnMove | undefined {
  return db
    .prepare(
      `SELECT id, move_uci, move_san FROM repertoire_positions
       WHERE repertoire_id = ? AND position_key = ? AND kind = 'own'`,
    )
    .get(repertoireId, positionKey) as StoredRepertoireOwnMove | undefined;
}

/** Where a variation expects its move in a position: the likeliest line there and its reach. */
export interface StoredRepertoireOwnPlace {
  line: string[];
  reach: number;
  uci: string;
}

export function findRepertoireOwnPlace(
  db: Database,
  repertoireId: number,
  positionKey: string,
): StoredRepertoireOwnPlace | undefined {
  const row = db
    .prepare(
      `SELECT line_san, reach, move_uci FROM repertoire_positions
       WHERE repertoire_id = ? AND position_key = ? AND kind = 'own'`,
    )
    .get(repertoireId, positionKey) as
    | { line_san: string; reach: number; move_uci: string }
    | undefined;
  if (!row) return undefined;
  return { line: JSON.parse(row.line_san) as string[], reach: row.reach, uci: row.move_uci };
}

export function insertRepertoireOwnMove(db: Database, move: NewRepertoireOwnMove): void {
  db.prepare(
    `INSERT INTO repertoire_positions
       (repertoire_id, kind, position_key, ply, line_san, move_uci, move_san, share, reach,
        opening_name, source, cp_loss, eval_cp, eval_depth, wins, draws, losses)
     VALUES (?, 'own', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    move.repertoireId,
    move.positionKey,
    move.ply,
    JSON.stringify(move.line),
    move.uci,
    move.san,
    move.share,
    move.reach,
    move.openingName,
    move.source,
    move.cpLoss,
    move.evalCp,
    move.evalDepth ?? null,
    move.results?.wins ?? null,
    move.results?.draws ?? null,
    move.results?.losses ?? null,
  );
}

// The engine's answer is not repeatable and the explorer's moves with its cache, so a position that
// already has its reply past the goal keeps it: the student has memorized it by then.
export function findRepertoireContinuations(
  db: Database,
  repertoireId: number,
  positionKey: string,
): StoredRepertoireContinuation[] {
  return db
    .prepare(
      `SELECT move_uci, share, source FROM repertoire_positions
       WHERE repertoire_id = ? AND position_key = ? AND kind = 'reply'
         AND source IN ('mainline', 'engine')
       ORDER BY id`,
    )
    .all(repertoireId, positionKey) as StoredRepertoireContinuation[];
}

// One row per reply: a likelier line to the same position takes it over, and a rerun changes nothing.
export function upsertRepertoireReply(db: Database, reply: NewRepertoireMove): void {
  db.prepare(
    `INSERT INTO repertoire_positions
       (repertoire_id, kind, position_key, ply, line_san, move_uci, move_san, share, reach,
        opening_name, source)
     VALUES (?, 'reply', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repertoire_id, position_key, move_uci) WHERE kind = 'reply'
     DO UPDATE SET ply = excluded.ply, line_san = excluded.line_san, reach = excluded.reach,
       opening_name = excluded.opening_name
     WHERE excluded.reach > repertoire_positions.reach`,
  ).run(
    reply.repertoireId,
    reply.positionKey,
    reply.ply,
    JSON.stringify(reply.line),
    reply.uci,
    reply.san,
    reply.share,
    reply.reach,
    reply.openingName,
    reply.source,
  );
}

// Replies only: nothing points at a reply row, while a review card and an idea hang on a White move.
// Returns how many rows went.
export function deleteRepertoireRepliesAtPly(
  db: Database,
  repertoireId: number,
  ply: number,
): number {
  return db
    .prepare(
      "DELETE FROM repertoire_positions WHERE repertoire_id = ? AND kind = 'reply' AND ply = ?",
    )
    .run(repertoireId, ply).changes;
}

/** A stored own move keeps its move, scores and counts; only a likelier line moves its place. */
export function raiseRepertoireOwnMoveReach(
  db: Database,
  ownMoveId: number,
  place: RepertoireRowPlace,
): void {
  db.prepare(
    `UPDATE repertoire_positions
     SET ply = ?, line_san = ?, reach = ?, opening_name = ?
     WHERE id = ? AND reach < ?`,
  ).run(
    place.ply,
    JSON.stringify(place.line),
    place.reach,
    place.openingName,
    ownMoveId,
    place.reach,
  );
}

// Shallowest plies first: a run cut short by the subscription's limit leaves the moves the student
// meets earliest with an idea already, and a rerun carries on from the rest. A move with no stored
// evaluation, as one read from a PGN file has none, is no target: the text is written from it. An
// imported unit is left out whole, whatever its rows hold: its reasons are the student's to write.
export function listWhiteMovesLackingIdea(db: Database): RepertoireIdeaTarget[] {
  const rows = db
    .prepare(
      `SELECT p.id, r.variation_name, p.ply, p.line_san, p.move_san, p.move_uci, p.eval_cp
       FROM repertoire_positions p JOIN repertoires r ON r.id = p.repertoire_id
       WHERE r.side = 'white' AND p.kind = 'own' AND p.idea IS NULL
         AND NOT ${repertoireRebuildCopySql("r.group_name")}
         AND ${repertoireGeneratedSql("r.origin")}
       ORDER BY p.repertoire_id, p.ply, p.id`,
    )
    .all() as Array<{
    id: number;
    variation_name: string;
    ply: number;
    line_san: string;
    move_san: string;
    move_uci: string;
    eval_cp: number | null;
  }>;
  return rows.flatMap((row) =>
    row.eval_cp === null
      ? []
      : [
          {
            id: row.id,
            variationName: row.variation_name,
            ply: row.ply,
            line: JSON.parse(row.line_san) as string[],
            san: row.move_san,
            uci: row.move_uci,
            evalCp: row.eval_cp,
          },
        ],
  );
}

// Never overwrites: a text already stored stays, whoever wrote it. Returns whether this call wrote.
export function setRepertoireIdea(db: Database, positionId: number, idea: string): boolean {
  const result = db
    .prepare("UPDATE repertoire_positions SET idea = ? WHERE id = ? AND idea IS NULL")
    .run(idea, positionId);
  return result.changes > 0;
}

/** What saving a student note wrote across every unit outside rebuild copies. */
export interface SavedRepertoireIdea {
  positionKey: string;
  uci: string;
  rowsUpdated: number;
  idea: string;
}

// Replaces the stored note on every `own` row sharing the target row's position and move across
// every unit that is not a rebuild's working copy, since those rows share one review card. Returns
// null when no `own` row outside rebuild copies has `positionId`.
export function saveRepertoireIdea(
  db: Database,
  positionId: number,
  idea: string,
): SavedRepertoireIdea | null {
  return db.transaction((): SavedRepertoireIdea | null => {
    const target = db
      .prepare(
        `SELECT p.position_key, p.move_uci
         FROM repertoire_positions p JOIN repertoires r ON r.id = p.repertoire_id
         WHERE p.id = ? AND p.kind = 'own' AND NOT ${repertoireRebuildCopySql("r.group_name")}`,
      )
      .get(positionId) as { position_key: string; move_uci: string } | undefined;
    if (!target) return null;
    const result = db
      .prepare(
        `UPDATE repertoire_positions
         SET idea = ?
         WHERE kind = 'own' AND position_key = ? AND move_uci = ?
           AND repertoire_id IN (
             SELECT id FROM repertoires WHERE NOT ${repertoireRebuildCopySql("group_name")}
           )`,
      )
      .run(idea, target.position_key, target.move_uci);
    return {
      positionKey: target.position_key,
      uci: target.move_uci,
      rowsUpdated: result.changes,
      idea,
    };
  })();
}

export function repertoireCounts(db: Database, repertoireId: number): RepertoireCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(kind = 'own'), 0) AS own_moves,
              COALESCE(SUM(kind = 'reply'), 0) AS replies,
              COALESCE(SUM(kind = 'reply' AND source = 'mainline'), 0) AS mainline_replies,
              COALESCE(SUM(kind = 'reply' AND source = 'engine'), 0) AS engine_replies,
              COALESCE(MAX(ply), 0) AS deepest_ply
       FROM repertoire_positions WHERE repertoire_id = ?`,
    )
    .get(repertoireId) as {
    total: number;
    own_moves: number;
    replies: number;
    mainline_replies: number;
    engine_replies: number;
    deepest_ply: number;
  };
  return {
    ownMoves: row.own_moves,
    replies: row.replies,
    mainlineReplies: row.mainline_replies,
    engineReplies: row.engine_replies,
    deepestPly: row.deepest_ply,
    total: row.total,
  };
}

/** A Black move that left the stored Italian line in reviewed games, and the games that played it. */
export interface MetOpeningRow {
  /** The line from move 1 through that move, read back from a game that played it. */
  root: string[];
  /** The opening of the position reached, as the review saw it; null where the book names none. */
  openingName: string | null;
  games: number;
  /** The unit already built from this root, if any. */
  repertoireId: number | null;
}

// A unit built from a root stores the root's last move, Black's, as the last of its setup rows. The
// Italian's own setup ends on a White move, so it never matches a Black departure. The oldest unit
// wins if two ever share a root. An imported unit is no unit of a root, and takes none from the
// generator's, whatever its id.
function unitsByLastRootMove(db: Database): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT p.repertoire_id, p.position_key, p.move_uci
       FROM repertoire_positions p JOIN repertoires r ON r.id = p.repertoire_id
       WHERE r.side = 'white' AND p.kind = 'reply' AND p.source = 'setup'
         AND NOT ${repertoireRebuildCopySql("r.group_name")}
         AND ${repertoireGeneratedSql("r.origin")}
         AND p.ply = (SELECT MAX(q.ply) FROM repertoire_positions q
                      WHERE q.repertoire_id = p.repertoire_id AND q.source = 'setup')
       ORDER BY p.repertoire_id`,
    )
    .all() as Array<{ repertoire_id: number; position_key: string; move_uci: string }>;
  const units = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.position_key}|${row.move_uci}`;
    if (!units.has(key)) units.set(key, row.repertoire_id);
  }
  return units;
}

// A review with outcome 'not_reached' holds the move that took the game out of the line before the
// variation began. Only Black's move can start a unit: a departure on an even ply is the opponent's
// choice, while White's own is the student's. Grouped by the position the move was played from and
// the move, which is the position left to; the most met come first.
export function listMetOpenings(db: Database): MetOpeningRow[] {
  const groups = db
    .prepare(
      `SELECT left_position_key AS position_key, left_uci AS move_uci,
              MIN(game_id) AS sample_game_id, COUNT(*) AS games, MAX(opening_name) AS opening_name
       FROM repertoire_game_reviews
       WHERE outcome = 'not_reached' AND left_ply IS NOT NULL AND left_ply % 2 = 0
       GROUP BY left_position_key, left_uci
       ORDER BY games DESC, sample_game_id`,
    )
    .all() as Array<{
    position_key: string;
    move_uci: string;
    sample_game_id: number;
    games: number;
    opening_name: string | null;
  }>;
  const units = unitsByLastRootMove(db);
  const rootOf = db.prepare(
    `SELECT m.san FROM moves m JOIN repertoire_game_reviews r ON r.game_id = m.game_id
     WHERE m.game_id = ? AND m.ply <= r.left_ply ORDER BY m.ply`,
  );
  return groups.map((group) => ({
    root: (rootOf.all(group.sample_game_id) as Array<{ san: string }>).map((move) => move.san),
    openingName: group.opening_name,
    games: group.games,
    repertoireId: units.get(`${group.position_key}|${group.move_uci}`) ?? null,
  }));
}

/** The moves a unit was rooted at, in order: the setup rows of White and of Black. */
export function repertoireSetupLine(db: Database, repertoireId: number): string[] {
  const rows = db
    .prepare(
      "SELECT move_san FROM repertoire_positions WHERE repertoire_id = ? AND source = 'setup' ORDER BY ply",
    )
    .all(repertoireId) as Array<{ move_san: string }>;
  return rows.map((row) => row.move_san);
}

/**
 * The White move a variation stores right after a line, which is the answer the variation is named
 * after. Many White moves share a ply, so it is found by the line before it. Undefined where the
 * variation stores none, as in a run cut short before that move.
 */
export function findRepertoireAnswerAfter(
  db: Database,
  repertoireId: number,
  line: readonly string[],
): string | undefined {
  const row = db
    .prepare(
      `SELECT move_san FROM repertoire_positions
       WHERE repertoire_id = ? AND kind = 'own' AND ply = ? AND line_san = ?`,
    )
    .get(repertoireId, line.length + 1, JSON.stringify(line)) as { move_san: string } | undefined;
  return row?.move_san;
}

/** The games reviewed against a variation that stayed in its line, out of those that reached it. */
export interface RepertoireGamesInLine {
  stayed: number;
  of: number;
}

// A review row that never reached the variation (`not_reached`) or was played as the other colour
// (`other_side`) carries the Italian's id as a fallback, not the variation the game met, so neither
// is a game of this line, whichever way it is counted.
export function countRepertoireGamesInLine(
  db: Database,
  repertoireId: number,
): RepertoireGamesInLine {
  const counted = db
    .prepare(
      `SELECT COALESCE(SUM(outcome IN ('in_book', 'reply_added', 'reply_not_stored')), 0) AS stayed,
              COALESCE(SUM(outcome = 'departed'), 0) AS departed
       FROM repertoire_game_reviews WHERE repertoire_id = ?`,
    )
    .get(repertoireId) as { stayed: number; departed: number };
  return { stayed: counted.stayed, of: counted.stayed + counted.departed };
}

/** What a variation was built with, read back from its row; each is null for a unit built before they were stored. */
export function findRepertoireBuild(db: Database, repertoireId: number): StoredRepertoireBuild {
  const row = db
    .prepare(
      `SELECT points_effectiveness, points_soundness, points_learnability, branch_san
       FROM repertoires WHERE id = ?`,
    )
    .get(repertoireId) as
    | {
        points_effectiveness: number | null;
        points_soundness: number | null;
        points_learnability: number | null;
        branch_san: string | null;
      }
    | undefined;
  if (!row) return { points: null, branch: null };
  // The migration stores the three together or not at all, so one missing means the unit has none.
  const { points_effectiveness: effectiveness, points_soundness: soundness } = row;
  const { points_learnability: learnability } = row;
  const points =
    effectiveness === null || soundness === null || learnability === null
      ? null
      : { effectiveness, soundness, learnability };
  return {
    points,
    branch: row.branch_san === null ? null : (JSON.parse(row.branch_san) as string[]),
  };
}

/**
 * Where a variation came from, read back from its row. A unit nobody stored reads as generated,
 * which is what every unit was before the column existed.
 */
export function findRepertoireOrigin(db: Database, repertoireId: number): RepertoireOrigin {
  const row = db.prepare("SELECT origin FROM repertoires WHERE id = ?").get(repertoireId) as
    | { origin: RepertoireOrigin }
    | undefined;
  return row?.origin ?? "generated";
}

/** Gives one variation the points and branch of another: what a rebuild's new rows were built with. */
export function copyRepertoireBuild(db: Database, fromId: number, toId: number): void {
  db.prepare(
    `UPDATE repertoires AS target SET
       points_effectiveness = source.points_effectiveness,
       points_soundness = source.points_soundness,
       points_learnability = source.points_learnability,
       branch_san = source.branch_san
     FROM repertoires AS source
     WHERE source.id = ? AND target.id = ?`,
  ).run(fromId, toId);
}

/** Whether a run got past the root of a unit: a run cut short at the start stored only its setup. */
export function repertoireHoldsMovesBeyondSetup(db: Database, repertoireId: number): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM repertoire_positions WHERE repertoire_id = ? AND source <> 'setup' LIMIT 1",
      )
      .get(repertoireId) !== undefined
  );
}

/** A unit and the line it is rooted at, as UCI moves from the first ply. */
export interface RepertoireUnitRoot {
  repertoire: RepertoireRow;
  root: string[];
}

/**
 * The units of a side that games can be compared with, oldest first, each with its setup rows as the
 * root. A run cut short at the start stores only the start of its root, which would claim every game
 * that begins the same way, so a unit counts once a run got past its setup. A unit with no setup row
 * has no root to match. An imported unit is never compared with a game, whatever rows it stores: a
 * review would add a reply and an answer the engine chose into the student's own line.
 */
export function listRepertoireUnitRoots(db: Database, side: RepertoireSide): RepertoireUnitRoot[] {
  const units = db
    .prepare(
      `SELECT id, side, group_name, variation_name FROM repertoires
       WHERE side = ? AND NOT ${repertoireRebuildCopySql("group_name")}
         AND ${repertoireGeneratedSql("origin")}
       ORDER BY id`,
    )
    .all(side) as RepertoireRow[];
  const setup = db.prepare(
    "SELECT move_uci FROM repertoire_positions WHERE repertoire_id = ? AND source = 'setup' ORDER BY ply",
  );
  return units.flatMap((repertoire) => {
    if (!repertoireHoldsMovesBeyondSetup(db, repertoire.id)) return [];
    const root = (setup.all(repertoire.id) as Array<{ move_uci: string }>).map(
      (row) => row.move_uci,
    );
    return root.length === 0 ? [] : [{ repertoire, root }];
  });
}
