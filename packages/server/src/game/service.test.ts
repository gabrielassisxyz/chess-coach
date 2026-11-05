import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMoves } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import { EngineFault } from "../engine/errors.js";
import type { PlayerMoveEvaluation } from "../engine/evaluate.js";
import type { PlayChoice } from "../engine/play.js";
import { importFinishedGame } from "../import/pgn.js";
import { RecordingLog } from "../log.js";
import type { GameEngine } from "./engine.js";
import { GameError } from "./errors.js";
import { GameService, type TurnReport } from "./service.js";
import type { GameSnapshot } from "./snapshot.js";

const EVALUATION: PlayerMoveEvaluation = {
  evalBeforeCp: 20,
  evalAfterCp: -10,
  cpLoss: 30,
  classification: "great",
  bestMoveUci: "d2d4",
  bestMoveSan: "d4",
};

class ScriptedEngine implements GameEngine {
  readonly evaluated: string[] = [];
  readonly planned: string[] = [];
  gate: Promise<void> | null = null;
  constructor(private replies: string[]) {}

  async evaluate(_fenBefore: string, moveUci: string): Promise<PlayerMoveEvaluation> {
    this.evaluated.push(moveUci);
    await this.gate;
    return EVALUATION;
  }

  async play(fen: string): Promise<PlayChoice> {
    this.planned.push(fen);
    await this.gate;
    const moveUci = this.replies.shift();
    if (!moveUci) throw new Error("the scripted engine ran out of replies");
    return { moveUci, source: "engine" };
  }
}

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-game-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const IMPORTED_PGN = '[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1';
const serviceWith = (engine: GameEngine) => new GameService({ db, engine });
const move = (from: string, to: string) => ({ from, to });
const plies = (gameId: number) => listMoves(db, gameId);

function collect(service: GameService): GameSnapshot[] {
  const seen: GameSnapshot[] = [];
  service.onSnapshot((snapshot) => seen.push(snapshot));
  return seen;
}

describe("new game", () => {
  it("opens a white game ready for the student", async () => {
    const service = serviceWith(new ScriptedEngine([]));
    const snapshot = await service.newGame({ color: "white", elo: 1200 });
    expect(snapshot.phase).toBe("player_turn");
    expect(snapshot.legalMoves).toHaveLength(20);
    expect(snapshot.material).toEqual({ white: 39, black: 39 });
  });

  it("persists the engine's first ply before a black game resolves", async () => {
    const service = serviceWith(new ScriptedEngine(["e2e4"]));
    const snapshot = await service.newGame({ color: "black", elo: 1200 });
    const gameId = snapshot.gameId;
    expect(plies(gameId).map((m) => [m.uci, m.isPlayer, m.evalBeforeCp])).toEqual([
      ["e2e4", false, null],
    ]);
    expect(snapshot.phase).toBe("player_turn");
    expect(snapshot.turn).toBe("black");
  });

  it("refuses a second game while one is unfinished and bad inputs", async () => {
    const service = serviceWith(new ScriptedEngine([]));
    await service.newGame({ color: "white", elo: 1200 });
    await expect(service.newGame({ color: "white", elo: 1200 })).rejects.toMatchObject({
      code: "game_in_progress",
    });
    await service.abort();
    await expect(service.newGame({ color: "white", elo: 50 })).rejects.toMatchObject({
      code: "invalid_elo",
    });
    await expect(
      service.newGame({ color: "white", elo: 1200, fen: "not a fen" }),
    ).rejects.toMatchObject({ code: "invalid_position" });
  });

  it("collapses the four promotions of one square into one legal move", async () => {
    const service = serviceWith(new ScriptedEngine([]));
    const snapshot = await service.newGame({
      color: "white",
      elo: 1200,
      fen: "8/P6k/8/8/8/8/8/K7 w - - 0 1",
    });
    const pawn = snapshot.legalMoves.filter((m) => m.from === "a7");
    expect(pawn).toEqual([{ from: "a7", to: "a8", promotions: ["q", "r", "b", "n"] }]);
  });
});

describe("player turn", () => {
  it("emits the applied move first, then the evaluation with the engine reply", async () => {
    const service = serviceWith(new ScriptedEngine(["e7e5"]));
    await service.newGame({ color: "white", elo: 1200 });
    const seen = collect(service);
    const reports: TurnReport[] = [];
    service.onTurn((report) => reports.push(report));

    const report = await service.playerMove(move("e2", "e4"));

    expect(seen).toHaveLength(2);
    expect(seen[0]?.phase).toBe("evaluating");
    expect(seen[0]?.moves.map((m) => [m.san, m.classification])).toEqual([["e4", null]]);
    expect(seen[0]?.legalMoves).toEqual([]);
    expect(seen[1]?.phase).toBe("player_turn");
    expect(seen[1]?.moves.map((m) => [m.san, m.classification])).toEqual([
      ["e4", "great"],
      ["e5", null],
    ]);
    expect(seen[1]?.lastMove).toMatchObject({ from: "e7", to: "e5", ply: 2 });
    expect(report.evaluation).toEqual(EVALUATION);
    expect(report.playerMove.cpLoss).toBe(30);
    expect(report.engineReply?.uci).toBe("e7e5");
    expect(reports).toEqual([report]);
  });

  it("rejects illegal moves with a typed error and leaves the game untouched", async () => {
    const service = serviceWith(new ScriptedEngine([]));
    const { gameId } = await service.newGame({ color: "white", elo: 1200 });
    const error = await service.playerMove(move("e2", "e5")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GameError);
    expect((error as GameError).code).toBe("illegal_move");
    expect(plies(gameId)).toEqual([]);
    expect(service.current()?.phase).toBe("player_turn");
  });

  it("applies two overlapping moves in order and rejects the second as out of turn", async () => {
    const engine = new ScriptedEngine(["e7e5"]);
    const service = serviceWith(engine);
    const { gameId } = await service.newGame({ color: "white", elo: 1200 });
    const first = service.playerMove(move("e2", "e4"));
    const second = service.playerMove(move("d2", "d4"));
    await expect(second).rejects.toMatchObject({ code: "not_player_turn" });
    await first;
    expect(plies(gameId).map((m) => m.uci)).toEqual(["e2e4", "e7e5"]);
  });

  it("rejects a move after the game is over", async () => {
    const service = serviceWith(new ScriptedEngine([]));
    await service.newGame({ color: "white", elo: 1200 });
    await service.resign();
    await expect(service.playerMove(move("e2", "e4"))).rejects.toMatchObject({
      code: "game_finished",
    });
  });
});

describe("undo", () => {
  it("is rejected while the move is still being graded", async () => {
    const engine = new ScriptedEngine(["e7e5"]);
    const service = serviceWith(engine);
    await service.newGame({ color: "white", elo: 1200 });
    let release = () => {};
    engine.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = service.playerMove(move("e2", "e4"));
    await expect(service.undo()).rejects.toMatchObject({ code: "not_player_turn" });
    release();
    await pending;
  });

  it("removes both plies and restores the earlier position", async () => {
    const service = serviceWith(new ScriptedEngine(["e7e5", "b8c6"]));
    const start = await service.newGame({ color: "white", elo: 1200 });
    await service.playerMove(move("e2", "e4"));
    const afterFirst = service.snapshot();
    await service.playerMove(move("g1", "f3"));
    expect(plies(start.gameId)).toHaveLength(4);

    const seen = collect(service);
    const snapshot = await service.undo();

    expect(plies(start.gameId)).toHaveLength(2);
    expect(snapshot).toEqual(afterFirst);
    expect(seen).toEqual([afterFirst]);
    const pgn = service.current()?.pgn ?? "";
    expect(pgn).toContain("1. e4 e5");
    expect(pgn).not.toContain("Nf3");
  });

  it("is rejected when there is no engine ply to take back", async () => {
    const service = serviceWith(new ScriptedEngine(["e2e4"]));
    await service.newGame({ color: "black", elo: 1200 });
    await expect(service.undo()).rejects.toMatchObject({ code: "nothing_to_undo" });
  });
});

describe("resign and abort", () => {
  it("resign gives the engine the win and freezes the game", async () => {
    const service = serviceWith(new ScriptedEngine(["e7e5"]));
    const { gameId } = await service.newGame({ color: "white", elo: 1200 });
    await service.playerMove(move("e2", "e4"));
    const snapshot = await service.resign();
    expect(snapshot).toMatchObject({ phase: "finished", result: "0-1", termination: "resign" });
    expect(snapshot.legalMoves).toEqual([]);
    await expect(service.undo()).rejects.toMatchObject({ code: "game_finished" });
    await expect(service.abort()).rejects.toMatchObject({ code: "game_finished" });
    expect(plies(gameId)).toHaveLength(2);
  });

  it("resigning a black game gives White the win", async () => {
    const service = serviceWith(new ScriptedEngine(["e2e4"]));
    await service.newGame({ color: "black", elo: 1200 });
    expect((await service.resign()).result).toBe("1-0");
  });

  it("abort records no result", async () => {
    const service = serviceWith(new ScriptedEngine([]));
    await service.newGame({ color: "white", elo: 1200 });
    const snapshot = await service.abort();
    expect(snapshot).toMatchObject({ phase: "finished", result: null, termination: "abort" });
    expect(service.current()?.finishedAt).not.toBeNull();
  });
});

describe("the log", () => {
  it("records the game, each ply with its grade and time, the undo and the finish", async () => {
    const log = new RecordingLog();
    const service = new GameService({ db, engine: new ScriptedEngine(["e7e5", "b8c6"]), log });
    const { gameId } = await service.newGame({ color: "white", elo: 1200 });
    await service.playerMove(move("e2", "e4"));
    await service.playerMove(move("g1", "f3"));
    await service.undo();
    await service.resign();

    expect(log.named("game.new")[0]?.fields).toMatchObject({
      game_id: gameId,
      color: "white",
      target_elo: 1200,
    });
    expect(log.named("game.player_move")[0]?.fields).toMatchObject({
      game_id: gameId,
      ply: 1,
      san: "e4",
      cp_loss: 30,
      classification: "great",
      best_san: "d4",
    });
    expect(log.named("game.engine_move").map((entry) => entry.fields.san)).toEqual(["e5", "Nc6"]);
    expect(log.named("game.undo")[0]?.fields).toEqual({
      game_id: gameId,
      removed: [
        { ply: 3, san: "Nf3" },
        { ply: 4, san: "Nc6" },
      ],
    });
    expect(log.named("game.finished")[0]?.fields).toMatchObject({
      result: "0-1",
      termination: "resign",
    });
    const stamped = db
      .prepare("SELECT created_at FROM moves WHERE game_id = ? ORDER BY ply")
      .all(gameId) as { created_at: string | null }[];
    expect(stamped.map((row) => row.created_at)).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    ]);
  });

  it("records a listener that throws instead of dropping it, and the turn still lands", async () => {
    const log = new RecordingLog();
    const service = new GameService({ db, engine: new ScriptedEngine(["e7e5"]), log });
    await service.newGame({ color: "white", elo: 1200 });
    service.onSnapshot(() => {
      throw new Error("listener broke");
    });
    await service.playerMove(move("e2", "e4"));
    expect(service.snapshot()?.moves).toHaveLength(2);
    expect(log.named("game.listener_failed")[0]?.fields).toMatchObject({
      error_message: "listener broke",
    });
  });
});

describe("the log's timings", () => {
  it("times the grade and the engine's reply apart", async () => {
    const log = new RecordingLog();
    const engine = new ScriptedEngine(["e7e5"]);
    const evaluate = engine.evaluate.bind(engine);
    engine.evaluate = async (fen, uci) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return evaluate(fen, uci);
    };
    const service = new GameService({ db, engine, log });
    await service.newGame({ color: "white", elo: 1200 });
    await service.playerMove(move("e2", "e4"));
    const graded = Number(log.named("game.player_move")[0]?.fields.duration_ms);
    const replied = Number(log.named("game.engine_move")[0]?.fields.duration_ms);
    expect(graded).toBeGreaterThanOrEqual(55);
    expect(replied).toBeLessThan(graded);
  });

  it("logs an engine fault with the game it hit", async () => {
    const log = new RecordingLog();
    const engine = new ScriptedEngine(["e7e5"]);
    engine.evaluate = async () => {
      throw new EngineFault("exited", "stockfish exited");
    };
    const service = new GameService({ db, engine, log });
    const { gameId } = await service.newGame({ color: "white", elo: 1200 });
    await expect(service.playerMove(move("e2", "e4"))).rejects.toBeInstanceOf(EngineFault);
    expect(log.named("engine.fault")[0]).toMatchObject({
      level: "error",
      fields: { game_id: gameId, reason: "exited", error_message: "stockfish exited" },
    });
  });
});

describe("restart recovery", () => {
  it("finishes a turn cut off after the player's ply was saved, exactly once", async () => {
    const stuck = new ScriptedEngine(["e7e5"]);
    stuck.gate = new Promise<void>(() => {});
    const before = serviceWith(stuck);
    const { gameId } = await before.newGame({ color: "white", elo: 1200 });
    void before.playerMove(move("e2", "e4")).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(before.current()?.phase).toBe("evaluating");
    expect(plies(gameId).map((m) => m.uci)).toEqual(["e2e4"]);

    const after = serviceWith(new ScriptedEngine(["e7e5"]));
    const reports: TurnReport[] = [];
    after.onTurn((report) => reports.push(report));
    expect(after.current()?.phase).toBe("evaluating");
    await after.recover();
    await after.recover();

    const rows = plies(gameId);
    expect(rows.map((m) => [m.uci, m.isPlayer, m.classification])).toEqual([
      ["e2e4", true, "great"],
      ["e7e5", false, null],
    ]);
    expect(after.current()?.phase).toBe("player_turn");
    expect(reports).toHaveLength(1);
  });

  it("keeps a game waiting for the player's move exactly as it was", async () => {
    const before = serviceWith(new ScriptedEngine(["e7e5"]));
    const { gameId } = await before.newGame({ color: "white", elo: 1200 });
    await before.playerMove(move("e2", "e4"));
    const seen = before.snapshot();
    expect(seen?.phase).toBe("player_turn");

    const idle = new ScriptedEngine([]);
    const after = serviceWith(idle);
    expect(after.snapshot()).toEqual(seen);
    await after.recover();
    expect(after.snapshot()).toEqual(seen);
    expect(idle.evaluated.concat(idle.planned)).toEqual([]);
    expect(plies(gameId)).toHaveLength(2);
  });

  it("retries after an engine failure instead of leaving the game wedged", async () => {
    const broken = serviceWith({
      evaluate: async () => EVALUATION,
      play: async () => {
        throw new Error("engine exited");
      },
    });
    const { gameId } = await broken.newGame({ color: "white", elo: 1200 });
    await expect(broken.playerMove(move("e2", "e4"))).rejects.toThrow("engine exited");
    expect(broken.current()?.phase).toBe("evaluating");
    await expect(broken.playerMove(move("d2", "d4"))).rejects.toMatchObject({
      code: "not_player_turn",
    });

    const fixed = serviceWith(new ScriptedEngine(["e7e5"]));
    await fixed.recover();
    expect(plies(gameId)).toHaveLength(2);
  });

  it("finishes a black game whose engine opening was never played", async () => {
    const broken = serviceWith({
      evaluate: async () => EVALUATION,
      play: async () => {
        throw new Error("engine exited");
      },
    });
    await expect(broken.newGame({ color: "black", elo: 1200 })).rejects.toThrow("engine exited");
    const gameId = broken.current()?.id ?? 0;
    expect(broken.current()?.phase).toBe("engine_turn");

    const fixed = serviceWith(new ScriptedEngine(["d2d4"]));
    await fixed.recover();
    expect(plies(gameId).map((m) => m.uci)).toEqual(["d2d4"]);
    expect(fixed.current()?.phase).toBe("player_turn");
  });

  it("keeps threefold repetition after a restart, which the last FEN alone would lose", async () => {
    const engineReplies = ["g8f6", "f6g8", "g8f6", "f6g8"];
    const playerMoves = [move("g1", "f3"), move("f3", "g1"), move("g1", "f3"), move("f3", "g1")];

    const straight = serviceWith(new ScriptedEngine([...engineReplies]));
    await straight.newGame({ color: "white", elo: 1200 });
    for (const m of playerMoves) await straight.playerMove(m);
    expect(straight.current()).toMatchObject({ termination: "draw", result: "1/2-1/2" });

    db.prepare("DELETE FROM games").run();
    const first = new ScriptedEngine(["g8f6", "f6g8", "g8f6"]);
    const before = serviceWith(first);
    await before.newGame({ color: "white", elo: 1200 });
    for (const m of playerMoves.slice(0, 3)) await before.playerMove(m);
    first.gate = new Promise<void>(() => {});
    void before.playerMove(playerMoves[3] as ReturnType<typeof move>).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(before.current()?.phase).toBe("evaluating");

    const after = serviceWith(new ScriptedEngine(["f6g8"]));
    await after.recover();
    expect(after.current()).toMatchObject({ termination: "draw", result: "1/2-1/2" });
    expect(after.snapshot()?.phase).toBe("finished");
  });

  it("keeps the fifty-move counter after a restart", async () => {
    const stuck = new ScriptedEngine(["e5d5"]);
    const before = serviceWith(stuck);
    await before.newGame({ color: "white", elo: 1200, fen: "8/8/8/4k3/8/8/4K3/7R w - - 98 100" });
    stuck.gate = new Promise<void>(() => {});
    void before.playerMove(move("h1", "h2")).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    const after = serviceWith(new ScriptedEngine(["e5d5"]));
    await after.recover();
    expect(after.current()).toMatchObject({ termination: "draw", result: "1/2-1/2" });
  });
});

describe("a full game", () => {
  it("plays to checkmate through the service and the PGN reproduces the final position", async () => {
    const service = serviceWith(new ScriptedEngine(["f2f3", "g2g4"]));
    const reports: TurnReport[] = [];
    service.onTurn((report) => reports.push(report));
    const { gameId } = await service.newGame({ color: "black", elo: 800 });
    await service.playerMove(move("e7", "e5"));
    const last = await service.playerMove(move("d8", "h4"));

    const game = service.current();
    expect(game).toMatchObject({
      phase: "finished",
      result: "0-1",
      termination: "checkmate",
    });
    expect(last.engineReply).toBeNull();
    expect(last.evaluation).toEqual(EVALUATION);
    expect(reports).toHaveLength(2);

    const finalFen = plies(gameId).at(-1)?.fenAfter;
    const parsed = new Chess();
    parsed.loadPgn(game?.pgn ?? "");
    expect(parsed.fen()).toBe(finalFen);
    expect(service.snapshot()?.fen).toBe(finalFen);
  });

  it("does not restore a finished game after a restart, so the board starts empty", async () => {
    const service = serviceWith(new ScriptedEngine([]));
    await service.newGame({ color: "white", elo: 1200 });
    await service.resign();
    const restored = serviceWith(new ScriptedEngine([]));
    expect(restored.current()).toBeNull();
    expect(restored.snapshot()).toBeNull();
    await restored.recover();
    expect(restored.current()).toBeNull();
  });

  it("ignores an imported game at boot: nothing is current and recovery does nothing", async () => {
    importFinishedGame(db, { pgn: IMPORTED_PGN, playerColor: "white", source: "pgn" });
    const booted = serviceWith(new ScriptedEngine([]));
    expect(booted.current()).toBeNull();
    expect(booted.snapshot()).toBeNull();
    await booted.recover();
    expect(booted.current()).toBeNull();
  });

  it("keeps the unfinished game current when a newer imported game exists", async () => {
    const service = serviceWith(new ScriptedEngine([]));
    const live = await service.newGame({ color: "white", elo: 1200 });
    importFinishedGame(db, { pgn: IMPORTED_PGN, playerColor: "white", source: "pgn" });
    expect(serviceWith(new ScriptedEngine([])).current()?.id).toBe(service.current()?.id);
    await service.resign();
    expect(service.current()?.termination).toBe("resign");
    expect(live.phase).toBe("player_turn");
  });
});
