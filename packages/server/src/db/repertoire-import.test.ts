import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PgnRepertoireMove,
  type PgnRepertoireSide,
  readPgnRepertoire,
} from "../openings/pgn-repertoire.js";
import { type Database, openDatabase } from "./open.js";
import {
  findRepertoireCard,
  insertRepertoireFirstAttempt,
  introduceRepertoireCard,
  saveRepertoireCardReview,
} from "./repertoire-cards.js";
import {
  deleteImportedRepertoireUnit,
  type ImportedRepertoireMove,
  type ImportedUnitDeleteSummary,
  type ImportedUnitName,
  type ImportedUnitSyncResult,
  type ImportedUnitSyncSummary,
  syncImportedRepertoireUnit,
} from "./repertoire-import.js";
import { createRepertoireVariation, insertRepertoireOwnMove } from "./repertoires.js";
import { endTrainingRun, insertTrainingRun } from "./training.js";

const AT = "2026-11-21T20:00:00.000Z";
const LONDON: ImportedUnitName = { side: "white", group: "London System", variation: "Main line" };

// White's London as a file: the student's reason follows two of the moves, as a comment.
const FILE = [
  "1. d4 d5",
  "2. Bf4 {Develops outside the pawn chain before ...e6 closes it in.} Nf6",
  "3. e3 {Opens a retreat for the bishop.} e6",
  "4. Nf3 *",
].join(" ");
const BF4_REASON = "Develops outside the pawn chain before ...e6 closes it in.";
const E3_REASON = "Opens a retreat for the bishop.";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-import-"));
  db = openDatabase(tmp);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// The reader's own output, so the sync is held to what it is really handed.
function read(
  pgn: string,
  side: PgnRepertoireSide = "white",
  weights?: string,
): PgnRepertoireMove[] {
  const result = readPgnRepertoire(pgn, side, weights);
  if (!result.moves) throw new Error(`the fixture does not read: ${JSON.stringify(result.errors)}`);
  return result.moves;
}

function moveAt(
  moves: readonly PgnRepertoireMove[],
  line: string[],
  san: string,
): PgnRepertoireMove {
  const found = moves.find(
    (move) => move.move_san === san && move.line_san.join(" ") === line.join(" "),
  );
  if (!found) throw new Error(`the fixture has no ${san} after ${line.join(" ") || "the start"}`);
  return found;
}

const sync = (
  moves: readonly ImportedRepertoireMove[],
  unit: ImportedUnitName = LONDON,
  dryRun = false,
): ImportedUnitSyncResult => syncImportedRepertoireUnit(db, unit, moves, AT, dryRun);

function summaryOf(result: ImportedUnitSyncResult): ImportedUnitSyncSummary {
  if (!result.ok) throw new Error(`the sync refused: ${result.code}, ${result.message}`);
  return result.summary;
}

const syncOk = (moves: readonly ImportedRepertoireMove[], unit?: ImportedUnitName) =>
  summaryOf(sync(moves, unit));

interface RowView {
  id: number;
  kind: string;
  san: string;
  ply: number;
  line: string[];
  reach: number;
  cp_loss: number | null;
  eval_cp: number | null;
  idea: string | null;
  source: string;
}

function rowsOf(repertoireId: number): RowView[] {
  const rows = db
    .prepare(
      `SELECT id, kind, move_san, ply, line_san, reach, cp_loss, eval_cp, idea, source
       FROM repertoire_positions WHERE repertoire_id = ? ORDER BY id`,
    )
    .all(repertoireId) as Array<
    Omit<RowView, "san" | "line"> & { move_san: string; line_san: string }
  >;
  return rows.map(({ move_san: san, line_san: line, ...rest }) => ({
    ...rest,
    san,
    line: JSON.parse(line) as string[],
  }));
}

function rowAt(repertoireId: number, line: string[], san: string): RowView {
  const found = rowsOf(repertoireId).find(
    (row) => row.san === san && row.line.join(" ") === line.join(" "),
  );
  if (!found) throw new Error(`no row for ${san} after ${line.join(" ") || "the start"}`);
  return found;
}

function tablesSnapshot() {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    repertoires: all("SELECT * FROM repertoires ORDER BY id"),
    positions: all("SELECT * FROM repertoire_positions ORDER BY id"),
    cards: all("SELECT * FROM repertoire_cards ORDER BY id"),
    reviews: all("SELECT * FROM drill_reviews ORDER BY id"),
    attempts: all("SELECT * FROM repertoire_first_attempts ORDER BY id"),
    runs: all("SELECT * FROM training_runs ORDER BY id"),
  };
}

const count = (sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

// A card the drill has rated twice, so a card that is kept shows its schedule and reviews unchanged.
function rateCard(move: PgnRepertoireMove): void {
  const key = { positionKey: move.position_key, uci: move.move_uci };
  introduceRepertoireCard(db, key, "2026-11-10T10:00:00.000Z");
  const card = findRepertoireCard(db, key);
  if (!card) throw new Error(`no card for ${move.move_san}`);
  for (const reviewedAt of ["2026-11-11T10:00:00.000Z", "2026-11-12T10:00:00.000Z"]) {
    saveRepertoireCardReview(db, {
      cardId: card.id,
      move: key,
      grade: 3,
      schedule: {
        fsrs_state: 2,
        stability: 3,
        difficulty: 2.1181,
        learning_step: 0,
        lapses: 0,
        interval_hours: 72,
        last_reviewed_at: reviewedAt,
        next_review_at: "2026-11-25T10:00:00.000Z",
      },
    });
  }
}

const cardOf = (move: PgnRepertoireMove) =>
  findRepertoireCard(db, { positionKey: move.position_key, uci: move.move_uci });

// A unit the app's generator built, whose group is not the student's.
function addGeneratedUnit(
  groupName: string,
  variationName: string,
  ownMoves: readonly PgnRepertoireMove[],
  side: PgnRepertoireSide = "white",
): number {
  const { id } = createRepertoireVariation(db, { side, groupName, variationName });
  for (const move of ownMoves) {
    insertRepertoireOwnMove(db, {
      repertoireId: id,
      positionKey: move.position_key,
      ply: move.ply,
      line: [...move.line_san],
      reach: move.reach,
      openingName: null,
      uci: move.move_uci,
      san: move.move_san,
      share: null,
      source: "engine",
      cpLoss: 0,
      evalCp: 20,
      results: null,
    });
  }
  return id;
}

// Rows of another unit above the stored one's, so that a row deleted and inserted again could not
// take its old id back, which the lowest free id would otherwise hand it.
function occupyLaterRowIds(moves: readonly PgnRepertoireMove[]): void {
  addGeneratedUnit("Other opening", "Other line", [moveAt(moves, [], "d4")]);
}

// A drill of the unit as the line drill stores it: the rows it serves and the unit it is on.
function openDrill(currentUnit: number, rowIds: readonly number[]): number {
  return insertTrainingRun(db, {
    mode: "repertoire",
    motif: null,
    color: "white",
    size: rowIds.length,
    items: rowIds.map((id) => ({ kind: "repertoire", id })),
    position: 0,
    solved: 0,
    failed: 0,
    outcomes: [],
    currentJson: JSON.stringify({
      repertoire_id: currentUnit,
      scope: "all",
      level: "variation",
      pass_index: 0,
      pass: { variation_id: currentUnit },
    }),
    startedAt: "2026-11-21T19:00:00.000Z",
  });
}

// An own move at a position, which a second own move there would contradict.
const ownMoveAt = (positionKey: string, uci: string, san: string): ImportedRepertoireMove => ({
  kind: "own",
  position_key: positionKey,
  ply: 9,
  line_san: ["a3", "a6", "b3", "b6"],
  move_uci: uci,
  move_san: san,
  reach: 1,
  reason: null,
  cp_loss: null,
});

describe("syncImportedRepertoireUnit: a unit that is new", () => {
  it("creates it as imported, stores every row as pgn in the order given and reports what it added", () => {
    const given = [...read(FILE)].reverse();

    const result = sync(given);

    const summary = summaryOf(result);
    expect(summary).toEqual({
      repertoire_id: summary.repertoire_id,
      created: true,
      own_added: 4,
      own_removed: 0,
      own_kept: 0,
      replies_added: 3,
      replies_removed: 0,
      replies_kept: 0,
      reasons_from_file: 2,
      reasons_kept: 0,
      cards_deleted: 0,
      reasons_removed: [],
    });
    expect(
      db
        .prepare(
          `SELECT side, group_name, variation_name, origin, points_effectiveness, points_soundness,
                  points_learnability, branch_san FROM repertoires`,
        )
        .all(),
    ).toEqual([
      {
        side: "white",
        group_name: "London System",
        variation_name: "Main line",
        origin: "pgn",
        points_effectiveness: null,
        points_soundness: null,
        points_learnability: null,
        branch_san: null,
      },
    ]);
    const rows = rowsOf(summary.repertoire_id);
    expect(rows.map((row) => `${row.kind} ${row.san}`)).toEqual(
      given.map((move) => `${move.kind} ${move.move_san}`),
    );
    expect(rows.every((row) => row.source === "pgn")).toBe(true);
    expect(rows.every((row) => row.eval_cp === null && row.cp_loss === null)).toBe(true);
    expect(rowAt(summary.repertoire_id, ["d4", "d5"], "Bf4").idea).toBe(BF4_REASON);
    expect(rowAt(summary.repertoire_id, ["d4", "d5", "Bf4", "Nf6"], "e3").idea).toBe(E3_REASON);
    expect(rows.filter((row) => row.idea !== null)).toHaveLength(2);
  });

  it("stores a Black unit the same way, its own moves being Black's", () => {
    const moves = read("1. d4 d5 2. c4 c6 *", "black");

    const summary = summaryOf(sync(moves, { side: "black", group: "Slav", variation: "Main" }));

    expect(summary).toMatchObject({ created: true, own_added: 2, replies_added: 2 });
    expect(db.prepare("SELECT side, origin FROM repertoires").all()).toEqual([
      { side: "black", origin: "pgn" },
    ]);
    expect(rowsOf(summary.repertoire_id).map((row) => `${row.kind} ${row.san}`)).toEqual(
      moves.map((move) => `${move.kind} ${move.move_san}`),
    );
  });

  it("stores the centipawn loss and the reach the weights gave, and no evaluation", () => {
    const weights = "reach\tloss_cp\tline\n0.7\t12\t1. d4 d5 2. Bf4\n";

    const { repertoire_id: unit } = syncOk(read(FILE, "white", weights));

    const bf4 = rowAt(unit, ["d4", "d5"], "Bf4");
    expect(bf4).toMatchObject({ cp_loss: 12, reach: 0.7, eval_cp: null });
  });

  it("stores no reason and no centipawn loss on a reply, whatever the move says", () => {
    const moves = read(FILE).map((move) =>
      move.kind === "reply" ? { ...move, reason: "A reason nobody asked for.", cp_loss: 40 } : move,
    );

    const { repertoire_id: unit } = syncOk(moves);

    const replies = rowsOf(unit).filter((row) => row.kind === "reply");
    expect(replies).toHaveLength(3);
    expect(replies.every((row) => row.idea === null && row.cp_loss === null)).toBe(true);
  });

  it("lets two imported variations share a group", () => {
    const first = syncOk(read(FILE));

    const second = syncOk(read("1. d4 Nf6 2. Bf4 *"), { ...LONDON, variation: "vs Nf6" });

    expect(second).toMatchObject({ created: true, own_added: 2 });
    expect(second.repertoire_id).not.toBe(first.repertoire_id);
  });
});

describe("syncImportedRepertoireUnit: a unit that is stored", () => {
  it("reports nothing added or removed the second time the same moves are synced", () => {
    const moves = read(FILE);
    const first = syncOk(moves);
    occupyLaterRowIds(moves);
    const rowsAfterFirst = rowsOf(first.repertoire_id);
    const snapshot = tablesSnapshot();

    const second = syncOk(moves);

    expect(second).toEqual({
      repertoire_id: first.repertoire_id,
      created: false,
      own_added: 0,
      own_removed: 0,
      own_kept: 4,
      replies_added: 0,
      replies_removed: 0,
      replies_kept: 3,
      reasons_from_file: 2,
      reasons_kept: 0,
      cards_deleted: 0,
      reasons_removed: [],
    });
    expect(rowsOf(first.repertoire_id)).toEqual(rowsAfterFirst);
    expect(tablesSnapshot()).toEqual(snapshot);
  });

  it("keeps the id of a row that stays and takes its new line, ply, reach and centipawn loss", () => {
    const moves = read(FILE);
    const { repertoire_id: unit } = syncOk(moves);
    occupyLaterRowIds(moves);
    const before = rowAt(unit, ["d4", "d5", "Bf4", "Nf6"], "e3");
    const changed = moves.map((move) =>
      move.move_san === "e3"
        ? { ...move, ply: 7, line_san: ["d4", "Nf6", "Bf4", "d5"], reach: 0.25, cp_loss: 33 }
        : move,
    );

    syncOk(changed);

    const after = rowsOf(unit).find((row) => row.id === before.id);
    expect(after).toMatchObject({
      san: "e3",
      ply: 7,
      line: ["d4", "Nf6", "Bf4", "d5"],
      reach: 0.25,
      cp_loss: 33,
      idea: E3_REASON,
    });
    expect(rowsOf(unit)).toHaveLength(7);
  });

  it("deletes the rows that left the file, inserts the new ones and re-lines the ones a transposition reaches", () => {
    const { repertoire_id: unit } = syncOk(read(FILE));
    occupyLaterRowIds(read(FILE));
    const before = rowsOf(unit);
    const e3Before = rowAt(unit, ["d4", "d5", "Bf4", "Nf6"], "e3");
    // The same position after 3.e3 by another move order, 2.Bf4 now played against 1...Nf6.
    const transposed = read(
      "1. d4 Nf6 2. Bf4 {Develops outside the pawn chain.} d5 3. e3 e6 4. Nf3 *",
    );

    const summary = syncOk(transposed);

    expect(summary).toMatchObject({
      repertoire_id: unit,
      created: false,
      own_added: 1,
      own_removed: 1,
      own_kept: 3,
      replies_added: 2,
      replies_removed: 2,
      replies_kept: 1,
    });
    const after = rowsOf(unit);
    expect(after).toHaveLength(before.length);
    // d4, e3, 4.Nf3 and 3...e6 are the same moves in the same positions: same rows, same ids.
    const keptIds = ["d4", "e3", "Nf3", "e6"].map((san) => before.find((r) => r.san === san)?.id);
    expect(keptIds.every((id) => after.some((row) => row.id === id))).toBe(true);
    const e3After = after.find((row) => row.id === e3Before.id);
    expect(e3After?.line).toEqual(["d4", "Nf6", "Bf4", "d5"]);
    // The old 2.Bf4 against 1...d5 is gone and the new one has an id above every earlier one.
    expect(after.some((row) => row.san === "Bf4" && row.line.join(" ") === "d4 d5")).toBe(false);
    const arrived = rowAt(unit, ["d4", "Nf6"], "Bf4");
    expect(arrived.id).toBeGreaterThan(Math.max(...before.map((row) => row.id)));
  });

  it("deletes the old answer to a position before it inserts the new one", () => {
    const { repertoire_id: unit } = syncOk(read(FILE));

    const summary = syncOk(read("1. d4 d5 2. Nc3 *"));

    expect(summary).toMatchObject({ own_added: 1, own_removed: 3, own_kept: 1 });
    expect(rowsOf(unit).map((row) => `${row.kind} ${row.san}`)).toEqual([
      "own d4",
      "reply d5",
      "own Nc3",
    ]);
  });

  it("takes a null centipawn loss and the reach of the line when a later file has no weights", () => {
    const weights = "reach\tloss_cp\tline\n0.7\t12\t1. d4 d5 2. Bf4\n";
    const { repertoire_id: unit } = syncOk(read(FILE, "white", weights));
    expect(rowAt(unit, ["d4", "d5"], "Bf4")).toMatchObject({ cp_loss: 12, reach: 0.7 });

    syncOk(read(FILE));

    expect(rowAt(unit, ["d4", "d5"], "Bf4")).toMatchObject({ cp_loss: null, reach: 1 });
  });
});

describe("syncImportedRepertoireUnit: the student's reasons", () => {
  it("keeps the stored reason of a move the file gives none for, and takes the file's when it gives one", () => {
    const { repertoire_id: unit } = syncOk(read(FILE));
    const reworded = read(
      "1. d4 d5 2. Bf4 Nf6 3. e3 {Prepares Bd3 and a quiet development.} e6 4. Nf3 *",
    );

    const summary = syncOk(reworded);

    expect(summary).toMatchObject({ reasons_from_file: 1, reasons_kept: 1, reasons_removed: [] });
    expect(rowAt(unit, ["d4", "d5"], "Bf4").idea).toBe(BF4_REASON);
    expect(rowAt(unit, ["d4", "d5", "Bf4", "Nf6"], "e3").idea).toBe(
      "Prepares Bd3 and a quiet development.",
    );
  });

  it("keeps the stored reason when the reason is blank or absent", () => {
    const moves = read(FILE);
    const { repertoire_id: unit } = syncOk(moves);
    const blanked = moves.map((move): ImportedRepertoireMove => {
      if (move.move_san === "Bf4") return { ...move, reason: "   " };
      if (move.move_san !== "e3") return move;
      const { reason: _absent, ...withoutReason } = move;
      return withoutReason;
    });

    const summary = syncOk(blanked);

    expect(summary).toMatchObject({ reasons_from_file: 0, reasons_kept: 2 });
    expect(rowAt(unit, ["d4", "d5"], "Bf4").idea).toBe(BF4_REASON);
    expect(rowAt(unit, ["d4", "d5", "Bf4", "Nf6"], "e3").idea).toBe(E3_REASON);
  });

  it("lists the reason of a row the file dropped, with its line and move, and none for a row that held no reason", () => {
    const { repertoire_id: unit } = syncOk(read(FILE));

    const summary = syncOk(read("1. d4 d5 2. Bf4 Nf6 *"));

    expect(summary).toMatchObject({ own_removed: 2, reasons_from_file: 0, reasons_kept: 1 });
    // 3.e3 and 4.Nf3 left, and only 3.e3 held a reason.
    expect(summary.reasons_removed).toEqual([
      { line: ["d4", "d5", "Bf4", "Nf6"], move: "e3", text: E3_REASON },
    ]);
    expect(rowsOf(unit).filter((row) => row.idea !== null)).toHaveLength(1);
  });

  it("gives a new move no reason until its file does, and counts it when it does", () => {
    const { repertoire_id: unit } = syncOk(read("1. d4 d5 *"));

    const summary = syncOk(read(FILE));

    expect(summary).toMatchObject({ own_added: 3, reasons_from_file: 2, reasons_kept: 0 });
    expect(rowAt(unit, ["d4", "d5", "Bf4", "Nf6"], "e3").idea).toBe(E3_REASON);
  });
});

describe("syncImportedRepertoireUnit: the cards", () => {
  it("deletes the card of a move no unit stores any more and keeps the others with their schedule", () => {
    const moves = read(FILE);
    const e3 = moveAt(moves, ["d4", "d5", "Bf4", "Nf6"], "e3");
    const { repertoire_id: unit } = syncOk(moves);
    // Another unit, the app's own, plays 3.e3 there too; nothing else is shared.
    addGeneratedUnit("Other opening", "Other line", [e3]);
    const cards = {
      d4: moveAt(moves, [], "d4"),
      bf4: moveAt(moves, ["d4", "d5"], "Bf4"),
      e3,
      nf3: moveAt(moves, ["d4", "d5", "Bf4", "Nf6", "e3", "e6"], "Nf3"),
    };
    for (const move of Object.values(cards)) rateCard(move);
    const kept = [cards.d4, cards.bf4, cards.e3].map(cardOf);
    const reviewsBefore = count("SELECT COUNT(*) AS n FROM drill_reviews");

    // The file now stops after 2.Bf4: 3.e3 and 4.Nf3 leave this unit, and only 3.e3 is another's.
    const summary = syncOk(read("1. d4 d5 2. Bf4 *"));

    expect(summary).toMatchObject({ repertoire_id: unit, own_removed: 2, cards_deleted: 1 });
    expect(cardOf(cards.nf3)).toBeUndefined();
    expect([cards.d4, cards.bf4, cards.e3].map(cardOf)).toEqual(kept);
    for (const card of kept) {
      expect(card).toMatchObject({ fsrs_state: 2, stability: 3, difficulty: 2.1181, reviews: 2 });
    }
    expect(count("SELECT COUNT(*) AS n FROM drill_reviews")).toBe(reviewsBefore);
  });

  it("leaves every card as it was when no move leaves the unit", () => {
    const moves = read(FILE);
    syncOk(moves);
    for (const move of moves.filter((candidate) => candidate.kind === "own")) rateCard(move);
    const cardsBefore = tablesSnapshot().cards;

    const summary = syncOk(moves);

    expect(summary.cards_deleted).toBe(0);
    expect(tablesSnapshot().cards).toEqual(cardsBefore);
  });
});

describe("syncImportedRepertoireUnit: what it refuses", () => {
  it("refuses a unit the app built, with not_imported, and changes nothing", () => {
    const moves = read(FILE);
    addGeneratedUnit(LONDON.group, LONDON.variation, [moveAt(moves, [], "d4")]);
    const before = tablesSnapshot();

    const result = sync(moves);

    expect(result).toMatchObject({ ok: false, code: "not_imported" });
    expect(tablesSnapshot()).toEqual(before);
  });

  it("refuses a group that holds a unit the app built, with group_taken, and changes nothing", () => {
    const moves = read(FILE);
    addGeneratedUnit(LONDON.group, "Built by the app", [moveAt(moves, [], "d4")]);
    const before = tablesSnapshot();

    const result = sync(moves);

    expect(result).toMatchObject({ ok: false, code: "group_taken" });
    expect(tablesSnapshot()).toEqual(before);
  });

  it("refuses to sync an imported unit whose group gained a unit the app built", () => {
    const moves = read(FILE);
    syncOk(moves);
    addGeneratedUnit(LONDON.group, "Built by the app", [moveAt(moves, [], "d4")]);
    const before = tablesSnapshot();

    expect(sync(read("1. d4 d5 *"))).toMatchObject({ ok: false, code: "group_taken" });
    expect(tablesSnapshot()).toEqual(before);
  });

  it("is not stopped by a unit the app built in the same group on the other side", () => {
    const moves = read(FILE);
    addGeneratedUnit(LONDON.group, "Built by the app", [moveAt(moves, [], "d4")], "black");

    expect(sync(moves)).toMatchObject({ ok: true });
  });

  it.each([
    ["a group", { ...LONDON, group: "London System (rebuilding)" }],
    ["a variation", { ...LONDON, variation: "Main line (rebuilding)" }],
    ["a group in capitals", { ...LONDON, group: "London System (REBUILDING)" }],
  ])(
    "refuses %s that names a rebuild's working copy, with invalid_name, and creates nothing",
    (_, unit) => {
      const before = tablesSnapshot();

      const result = sync(read(FILE), unit);

      expect(result).toMatchObject({ ok: false, code: "invalid_name" });
      expect(tablesSnapshot()).toEqual(before);
    },
  );

  it("accepts a name that holds the suffix without ending in it", () => {
    expect(sync(read(FILE), { ...LONDON, group: "London (rebuilding) System" })).toMatchObject({
      ok: true,
    });
  });

  it("refuses moves that hold no move of the student's, with empty, and leaves a stored unit as it is", () => {
    const moves = read(FILE);
    syncOk(moves);
    const before = tablesSnapshot();

    expect(sync([])).toMatchObject({ ok: false, code: "empty" });
    expect(sync(moves.filter((move) => move.kind === "reply"))).toMatchObject({
      ok: false,
      code: "empty",
    });
    expect(tablesSnapshot()).toEqual(before);
  });

  it("refuses a unit a drill is using, with drill_open, whichever way the run names it", () => {
    const moves = read(FILE);
    const { repertoire_id: unit } = syncOk(moves);
    const other = addGeneratedUnit("Other opening", "Other line", [moveAt(moves, [], "d4")]);
    const rowIds = rowsOf(unit).map((row) => row.id);
    const changed = read("1. d4 d5 2. Bf4 *");

    const named = openDrill(unit, []);
    expect(sync(changed)).toMatchObject({ ok: false, code: "drill_open" });
    endTrainingRun(db, named, "ended", AT);
    // The run's current item is another unit's, and the unit's rows are among its queue's.
    const holding = openDrill(other, rowIds.slice(0, 2));
    const before = tablesSnapshot();

    expect(sync(changed)).toMatchObject({ ok: false, code: "drill_open" });
    expect(sync(changed, LONDON, true)).toMatchObject({ ok: false, code: "drill_open" });
    expect(tablesSnapshot()).toEqual(before);
    endTrainingRun(db, holding, "ended", AT);
    expect(sync(changed)).toMatchObject({ ok: true });
  });

  it("is not stopped by a run of another unit or by one whose queue holds only a number like a row's", () => {
    const moves = read(FILE);
    const { repertoire_id: unit } = syncOk(moves);
    const other = addGeneratedUnit("Other opening", "Other line", [moveAt(moves, [], "d4")]);
    const otherRows = (
      db
        .prepare("SELECT id FROM repertoire_positions WHERE repertoire_id = ?")
        .all(other) as Array<{
        id: number;
      }>
    ).map((row) => row.id);
    openDrill(other, otherRows);
    insertTrainingRun(db, {
      mode: "srs",
      motif: null,
      color: null,
      size: 1,
      items: rowsOf(unit).map((row) => ({ kind: "card", id: row.id })),
      position: 0,
      solved: 0,
      failed: 0,
      outcomes: [],
      currentJson: "{}",
      startedAt: "2026-11-21T19:00:00.000Z",
    });

    expect(sync(moves)).toMatchObject({ ok: true });
  });
});

describe("syncImportedRepertoireUnit: a dry run", () => {
  it("returns the summary of a real run for a unit that is new and writes nothing", () => {
    const before = tablesSnapshot();

    const dry = sync(read(FILE), LONDON, true);

    expect(summaryOf(dry).created).toBe(true);
    expect(tablesSnapshot()).toEqual(before);
    expect(sync(read(FILE), LONDON, false)).toEqual(dry);
  });

  it("returns the summary of a real run for a stored unit, cards swept and reasons listed, and writes nothing", () => {
    const moves = read(FILE);
    syncOk(moves);
    for (const move of moves.filter((candidate) => candidate.kind === "own")) rateCard(move);
    const before = tablesSnapshot();
    const smaller = read("1. d4 d5 2. Bf4 *");

    const dry = sync(smaller, LONDON, true);

    expect(summaryOf(dry)).toMatchObject({ cards_deleted: 2, own_removed: 2 });
    expect(summaryOf(dry).reasons_removed).toHaveLength(1);
    expect(tablesSnapshot()).toEqual(before);
    expect(sync(smaller, LONDON, false)).toEqual(dry);
  });
});

describe("syncImportedRepertoireUnit: a failure in the middle", () => {
  it("leaves no unit behind when the last insert of a first import breaks a unique index", () => {
    const moves = read(FILE);
    const before = tablesSnapshot();
    const contradicting = [
      ...moves,
      ownMoveAt("a position", "a2a3", "a3"),
      ownMoveAt("a position", "h2h3", "h3"),
    ];

    expect(() => sync(contradicting)).toThrow(/UNIQUE constraint failed/);

    expect(tablesSnapshot()).toEqual(before);
  });

  it("restores the rows it deleted, updated and inserted when the last insert breaks a unique index", () => {
    const moves = read(FILE);
    syncOk(moves);
    rateCard(moveAt(moves, ["d4", "d5", "Bf4", "Nf6", "e3", "e6"], "Nf3"));
    const before = tablesSnapshot();
    const smaller = read("1. d4 d5 2. Bf4 {A new reason.} Nf6 3. e3 *");
    const contradicting = [
      ...smaller,
      ownMoveAt("a position", "a2a3", "a3"),
      ownMoveAt("a position", "h2h3", "h3"),
    ];

    expect(() => sync(contradicting)).toThrow(/UNIQUE constraint failed/);

    expect(tablesSnapshot()).toEqual(before);
  });

  it("restores the rows when the sweep of the cards fails after them", () => {
    const moves = read(FILE);
    syncOk(moves);
    rateCard(moveAt(moves, ["d4", "d5", "Bf4", "Nf6", "e3", "e6"], "Nf3"));
    const before = tablesSnapshot();
    db.exec(`CREATE TRIGGER forced_failure BEFORE DELETE ON repertoire_cards
             BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);

    expect(() => sync(read("1. d4 d5 2. Bf4 *"))).toThrow("forced failure");

    expect(tablesSnapshot()).toEqual(before);
  });
});

describe("deleteImportedRepertoireUnit", () => {
  function seedWithSharedCard() {
    const moves = read(FILE);
    const e3 = moveAt(moves, ["d4", "d5", "Bf4", "Nf6"], "e3");
    const { repertoire_id: unit } = syncOk(moves);
    const other = addGeneratedUnit("Other opening", "Other line", [e3]);
    for (const move of moves.filter((candidate) => candidate.kind === "own")) rateCard(move);
    insertRepertoireFirstAttempt(
      db,
      { positionKey: e3.position_key, uci: e3.move_uci, repertoireId: unit, correct: true },
      "2026-11-13T10:00:00.000Z",
    );
    return { moves, e3, unit, other };
  }

  const deleteOk = (repertoireId: number): ImportedUnitDeleteSummary => {
    const result = deleteImportedRepertoireUnit(db, repertoireId, AT, false);
    if (!result.ok) throw new Error(`the delete refused: ${result.code}`);
    return result.summary;
  };

  it("deletes the unit with its rows, and the cards no other unit stores, and counts them", () => {
    const { moves, e3, unit, other } = seedWithSharedCard();
    const reviewsBefore = count("SELECT COUNT(*) AS n FROM drill_reviews");
    const otherRowsBefore = rowsOf(other);
    const e3CardBefore = cardOf(e3);

    const summary = deleteOk(unit);

    expect(summary).toEqual({
      repertoire_id: unit,
      own_removed: 4,
      replies_removed: 3,
      reasons_removed: [
        { line: ["d4", "d5"], move: "Bf4", text: BF4_REASON },
        { line: ["d4", "d5", "Bf4", "Nf6"], move: "e3", text: E3_REASON },
      ],
      cards_deleted: 3,
      cards_kept: 1,
    });
    expect(count("SELECT COUNT(*) AS n FROM repertoires WHERE id = ?", unit)).toBe(0);
    expect(rowsOf(unit)).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM repertoire_first_attempts")).toBe(0);
    expect(cardOf(moveAt(moves, [], "d4"))).toBeUndefined();
    expect(cardOf(e3)).toEqual(e3CardBefore);
    expect(count("SELECT COUNT(*) AS n FROM drill_reviews")).toBe(reviewsBefore);
    expect(rowsOf(other)).toEqual(otherRowsBefore);
  });

  it("refuses an id that is not stored, with not_found", () => {
    const { unit } = seedWithSharedCard();
    const before = tablesSnapshot();

    expect(deleteImportedRepertoireUnit(db, unit + 100, AT, false)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(tablesSnapshot()).toEqual(before);
  });

  it("refuses a unit the app built, with not_imported", () => {
    const { other } = seedWithSharedCard();
    const before = tablesSnapshot();

    expect(deleteImportedRepertoireUnit(db, other, AT, false)).toMatchObject({
      ok: false,
      code: "not_imported",
    });
    expect(tablesSnapshot()).toEqual(before);
  });

  it("refuses a unit a drill is using, with drill_open, whichever way the run names it", () => {
    const { unit, other } = seedWithSharedCard();
    const rowIds = rowsOf(unit).map((row) => row.id);

    const named = openDrill(unit, []);
    expect(deleteImportedRepertoireUnit(db, unit, AT, false)).toMatchObject({
      ok: false,
      code: "drill_open",
    });
    endTrainingRun(db, named, "ended", AT);
    openDrill(other, rowIds.slice(0, 1));
    const before = tablesSnapshot();

    expect(deleteImportedRepertoireUnit(db, unit, AT, false)).toMatchObject({
      ok: false,
      code: "drill_open",
    });
    expect(deleteImportedRepertoireUnit(db, unit, AT, true)).toMatchObject({
      ok: false,
      code: "drill_open",
    });
    expect(tablesSnapshot()).toEqual(before);
  });

  it("returns the summary of a real run in a dry run and writes nothing", () => {
    const { unit } = seedWithSharedCard();
    const before = tablesSnapshot();

    const dry = deleteImportedRepertoireUnit(db, unit, AT, true);

    expect(dry).toMatchObject({ ok: true, summary: { cards_deleted: 3, cards_kept: 1 } });
    expect(tablesSnapshot()).toEqual(before);
    expect(deleteImportedRepertoireUnit(db, unit, AT, false)).toEqual(dry);
  });

  it("leaves everything as it was when the sweep of the cards fails", () => {
    const { unit } = seedWithSharedCard();
    const before = tablesSnapshot();
    db.exec(`CREATE TRIGGER forced_failure BEFORE DELETE ON repertoire_cards
             BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);

    expect(() => deleteImportedRepertoireUnit(db, unit, AT, false)).toThrow("forced failure");

    expect(tablesSnapshot()).toEqual(before);
  });
});
