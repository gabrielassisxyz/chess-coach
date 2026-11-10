import type { Database } from "./open.js";

export type RepertoireSide = "white" | "black";
/**
 * How a move entered a variation: fixed by the opening, popular in the explorer, the engine's, or
 * a reply stored past the coverage goal because it is the most played one there.
 */
export type RepertoireMoveSource = "setup" | "explorer" | "engine" | "mainline";

export interface RepertoireRow {
  id: number;
  side: RepertoireSide;
  group_name: string;
  variation_name: string;
}

export interface NewRepertoire {
  side: RepertoireSide;
  groupName: string;
  variationName: string;
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
  cpLoss: number;
  /** The position after the move, in centipawns from White's side; a mate is 10000. */
  evalCp: number;
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
// since and today's answer to 3...Bc5 would be named differently.
export function findFirstRepertoireVariation(
  db: Database,
  side: RepertoireSide,
  groupName: string,
): RepertoireRow | undefined {
  return db
    .prepare("SELECT * FROM repertoires WHERE side = ? AND group_name = ? ORDER BY id LIMIT 1")
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
    .prepare("SELECT * FROM repertoires WHERE side = ? AND group_name = ? AND variation_name = ?")
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
      `SELECT r.* FROM repertoires r JOIN repertoire_positions p ON p.repertoire_id = r.id
       WHERE r.side = ? AND r.group_name = ? AND p.kind = 'own' AND p.position_key = ?
         AND p.move_uci = ?
       ORDER BY r.id LIMIT 1`,
    )
    .get(side, groupName, move.positionKey, move.uci) as RepertoireRow | undefined;
}

export function createRepertoireVariation(db: Database, repertoire: NewRepertoire): RepertoireRow {
  const inserted = db
    .prepare("INSERT INTO repertoires (side, group_name, variation_name) VALUES (?, ?, ?)")
    .run(repertoire.side, repertoire.groupName, repertoire.variationName);
  return {
    id: Number(inserted.lastInsertRowid),
    side: repertoire.side,
    group_name: repertoire.groupName,
    variation_name: repertoire.variationName,
  };
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
// meets earliest with an idea already, and a rerun carries on from the rest.
export function listWhiteMovesLackingIdea(db: Database): RepertoireIdeaTarget[] {
  const rows = db
    .prepare(
      `SELECT p.id, r.variation_name, p.ply, p.line_san, p.move_san, p.move_uci, p.eval_cp
       FROM repertoire_positions p JOIN repertoires r ON r.id = p.repertoire_id
       WHERE r.side = 'white' AND p.kind = 'own' AND p.idea IS NULL
       ORDER BY p.repertoire_id, p.ply, p.id`,
    )
    .all() as Array<{
    id: number;
    variation_name: string;
    ply: number;
    line_san: string;
    move_san: string;
    move_uci: string;
    eval_cp: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    variationName: row.variation_name,
    ply: row.ply,
    line: JSON.parse(row.line_san) as string[],
    san: row.move_san,
    uci: row.move_uci,
    evalCp: row.eval_cp,
  }));
}

// Never overwrites: a text already stored stays, whoever wrote it. Returns whether this call wrote.
export function setRepertoireIdea(db: Database, positionId: number, idea: string): boolean {
  const result = db
    .prepare("UPDATE repertoire_positions SET idea = ? WHERE id = ? AND idea IS NULL")
    .run(idea, positionId);
  return result.changes > 0;
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
// wins if two ever share a root.
function unitsByLastRootMove(db: Database): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT p.repertoire_id, p.position_key, p.move_uci
       FROM repertoire_positions p JOIN repertoires r ON r.id = p.repertoire_id
       WHERE r.side = 'white' AND p.kind = 'reply' AND p.source = 'setup'
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
