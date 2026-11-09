import type { Database } from "./open.js";

export type RepertoireSide = "white" | "black";
/** How a move entered a variation: fixed by the opening, popular in the explorer, or the engine's. */
export type RepertoireMoveSource = "setup" | "explorer" | "engine";

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
  results: RepertoireResultCounts | null;
}

export interface StoredRepertoireOwnMove {
  id: number;
  move_uci: string;
  move_san: string;
}

export interface RepertoireCounts {
  ownMoves: number;
  replies: number;
  deepestPly: number;
  total: number;
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

export function insertRepertoireOwnMove(db: Database, move: NewRepertoireOwnMove): void {
  db.prepare(
    `INSERT INTO repertoire_positions
       (repertoire_id, kind, position_key, ply, line_san, move_uci, move_san, share, reach,
        opening_name, source, cp_loss, eval_cp, wins, draws, losses)
     VALUES (?, 'own', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    move.results?.wins ?? null,
    move.results?.draws ?? null,
    move.results?.losses ?? null,
  );
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

export function repertoireCounts(db: Database, repertoireId: number): RepertoireCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(kind = 'own'), 0) AS own_moves,
              COALESCE(SUM(kind = 'reply'), 0) AS replies,
              COALESCE(MAX(ply), 0) AS deepest_ply
       FROM repertoire_positions WHERE repertoire_id = ?`,
    )
    .get(repertoireId) as {
    total: number;
    own_moves: number;
    replies: number;
    deepest_ply: number;
  };
  return {
    ownMoves: row.own_moves,
    replies: row.replies,
    deepestPly: row.deepest_ply,
    total: row.total,
  };
}
