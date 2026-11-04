import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderNotifications } from "../coach/notify.js";
import { createCoachSession, listChatTail } from "../db/chat.js";
import { completeTurn, getGame, listMoves, recordPlayerMove } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import { EngineFault } from "../engine/errors.js";
import { classifyCpLoss, type PlayerMoveEvaluation } from "../engine/evaluate.js";
import type { PlayChoice } from "../engine/play.js";
import type { GameEngine } from "./engine.js";
import type { GameEndNotification, TurnNotification } from "./notifications.js";
import { GameService } from "./service.js";

class GradedEngine implements GameEngine {
  fault: EngineFault | null = null;
  constructor(
    private readonly replies: string[],
    private readonly cpLosses: number[],
  ) {}

  async evaluate(): Promise<PlayerMoveEvaluation> {
    if (this.fault) throw this.fault;
    const cpLoss = this.cpLosses.shift() ?? 0;
    return {
      evalBeforeCp: 0,
      evalAfterCp: -cpLoss,
      cpLoss,
      classification: classifyCpLoss(cpLoss),
      bestMoveUci: "d2d4",
      bestMoveSan: "d4",
    };
  }

  async play(): Promise<PlayChoice> {
    const moveUci = this.replies.shift();
    if (!moveUci) throw new Error("the scripted engine ran out of replies");
    return { moveUci, source: "engine" };
  }
}

let tmp: string;
let db: Database;
let sessionId: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-notify-"));
  db = openDatabase(tmp);
  sessionId = createCoachSession(db, { promptVersion: "v" }).id;
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const service = (engine: GameEngine, id: () => number = () => sessionId) =>
  new GameService({ db, engine, notifications: { sessionId: id } });
const move = (from: string, to: string) => ({ from, to });
const rows = () => listChatTail(db, sessionId, 50);
const contents = () => rows().map((row) => JSON.parse(row.contentJson));

describe("turn notification", () => {
  it("writes one undelivered user row with the structured report", async () => {
    const game = service(new GradedEngine(["e7e5"], [120]));
    await game.newGame({ color: "white", elo: 800 });
    await game.playerMove(move("e2", "e4"));

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ role: "user", kind: "notification", delivered: false });
    const content = contents()[0] as TurnNotification;
    expect(content).toMatchObject({
      type: "turn",
      move_number: 1,
      ply: 1,
      player_san: "e4",
      player_uci: "e2e4",
      cp_loss: 120,
      classification: "inaccuracy",
      best_san: "d4",
      engine_reply_san: "e5",
    });
    expect(content.fen).toBe(listMoves(db, content.game_id).at(-1)?.fenAfter);
  });

  it("tells the listeners once the row is committed", async () => {
    const game = service(new GradedEngine(["e7e5"], [0]));
    const seen: number[] = [];
    game.onNotification(() => seen.push(rows().length));
    await game.newGame({ color: "white", elo: 800 });
    expect(seen).toEqual([]);
    await game.playerMove(move("e2", "e4"));
    expect(seen).toEqual([1]);
  });

  it("writes no row for a game started as black before the student has moved", async () => {
    await service(new GradedEngine(["e2e4"], [])).newGame({ color: "black", elo: 800 });
    expect(rows()).toEqual([]);
  });
});

describe("atomicity", () => {
  it("rolls the turn back when the notification write fails inside the transaction", async () => {
    const game = service(new GradedEngine(["e7e5"], [120]), () => sessionId + 99);
    const { gameId } = await game.newGame({ color: "white", elo: 800 });
    await expect(game.playerMove(move("e2", "e4"))).rejects.toThrow(/FOREIGN KEY/);

    expect(getGame(db, gameId)?.phase).toBe("evaluating");
    const plies = listMoves(db, gameId);
    expect(plies.map((m) => [m.ply, m.cpLoss])).toEqual([[1, null]]);
    expect(rows()).toEqual([]);
  });

  it("leaves neither the turn nor the row when the callback throws after the writes", async () => {
    const game = service(new GradedEngine([], []));
    const { gameId } = await game.newGame({ color: "white", elo: 800 });
    recordPlayerMove(
      db,
      gameId,
      { ply: 1, san: "e4", uci: "e2e4", fenBefore: "a", fenAfter: "b", isPlayer: true },
      "",
    );
    expect(() =>
      completeTurn(db, {
        gameId,
        evaluation: {
          ply: 1,
          value: {
            evalBeforeCp: 0,
            evalAfterCp: 0,
            cpLoss: 7,
            classification: "great",
            bestMoveUci: null,
            bestMoveSan: null,
          },
        },
        engineMove: null,
        pgn: "p",
        finish: null,
        notify: (inner) => {
          inner
            .prepare(
              "INSERT INTO chat_messages (coach_session_id, seq, role, kind, content_json, created_at) VALUES (?, 1, 'user', 'notification', '{}', 't')",
            )
            .run(sessionId);
          throw new Error("injected");
        },
      }),
    ).toThrow("injected");
    expect(listMoves(db, gameId)[0]?.cpLoss).toBeNull();
    expect(getGame(db, gameId)?.phase).toBe("evaluating");
    expect(rows()).toEqual([]);
  });
});

describe("game end", () => {
  const scripted = (): GradedEngine =>
    new GradedEngine(["e7e5", "b8c6", "g8f6", "d7d6"], [50, 200, 200, 10]);

  async function playFourMoves(game: GameService): Promise<void> {
    await game.newGame({ color: "white", elo: 800 });
    await game.playerMove(move("e2", "e4"));
    await game.playerMove(move("g1", "f3"));
    await game.playerMove(move("f1", "c4"));
    await game.playerMove(move("d2", "d3"));
  }

  it("resigning writes the result and the three costliest student moves, earlier ply on a tie", async () => {
    const game = service(scripted());
    await playFourMoves(game);
    const seen: number[] = [];
    game.onNotification(() => seen.push(1));
    await game.resign();

    const end = contents().at(-1) as GameEndNotification;
    expect(end).toMatchObject({ type: "game_end", result: "0-1", termination: "resign" });
    expect(end.costliest_moves.map((m) => [m.san, m.cp_loss, m.ply])).toEqual([
      ["Nf3", 200, 3],
      ["Bc4", 200, 5],
      ["e4", 50, 1],
    ]);
    expect(rows()).toHaveLength(5);
    expect(seen).toEqual([1]);
  });

  it("creates the cards in the finishing transaction and names three moves with three card ids", async () => {
    const game = service(new GradedEngine(["e7e5", "b8c6", "g8f6", "d7d6"], [150, 420, 300, 10]));
    await playFourMoves(game);
    await game.resign();

    const end = contents().at(-1) as GameEndNotification;
    expect(end.cards).toEqual({ created: 3, skipped: 0 });
    const ids = end.costliest_moves.map((m) => m.card_id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    const stored = db.prepare("SELECT id, source_move_id FROM srs_cards ORDER BY id").all();
    expect(stored).toHaveLength(3);
    const text = renderNotifications([end]);
    for (const move of end.costliest_moves) {
      expect(text).toContain(`card id ${move.card_id}`);
      expect(text).toContain(`position before (FEN): ${move.fen_before}`);
    }
    expect(end.costliest_moves.map((m) => m.san)).toEqual(["Nf3", "Bc4", "e4"]);
  });

  it("gives a move under the card threshold a null card id", async () => {
    const game = service(scripted());
    await playFourMoves(game);
    await game.resign();
    const end = contents().at(-1) as GameEndNotification;
    expect(end.costliest_moves.map((m) => [m.san, m.card_id === null])).toEqual([
      ["Nf3", false],
      ["Bc4", false],
      ["e4", true],
    ]);
    expect(end.cards.created).toBe(2);
  });

  it("rolls the finish back when the card batch fails", async () => {
    const game = service(scripted());
    await playFourMoves(game);
    db.exec("DROP TABLE srs_cards");
    await expect(game.resign()).rejects.toThrow(/srs_cards/);
    expect(getGame(db, game.current()?.id as number)?.finishedAt).toBeNull();
  });

  it("aborting writes no end notification", async () => {
    const game = service(scripted());
    await game.newGame({ color: "white", elo: 800 });
    await game.abort();
    expect(rows()).toEqual([]);
  });

  it("a checkmate writes the turn row and the end row together", async () => {
    const game = service(new GradedEngine(["f2f3", "g2g4"], [0, 0]));
    await game.newGame({ color: "black", elo: 800 });
    await game.playerMove(move("e7", "e5"));
    await game.playerMove(move("d8", "h4"));

    const kinds = contents().map((content) => content.type);
    expect(kinds).toEqual(["turn", "turn", "game_end"]);
    expect(contents().at(-1)).toMatchObject({ result: "0-1", termination: "checkmate" });
  });
});

describe("engine fault", () => {
  it("is reported once and leaves the turn open for the next boot", async () => {
    const engine = new GradedEngine(["e7e5"], [0]);
    const game = service(engine);
    const faults: string[] = [];
    game.onEngineFault((fault) => faults.push(fault.reason));
    const { gameId } = await game.newGame({ color: "white", elo: 800 });
    engine.fault = new EngineFault("exited", "gone");
    await expect(game.playerMove(move("e2", "e4"))).rejects.toThrow("gone");
    expect(faults).toEqual(["exited"]);
    expect(getGame(db, gameId)?.phase).toBe("evaluating");
    expect(rows()).toEqual([]);
  });
});
