import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoachSession, listChatTail } from "../db/chat.js";
import { type Database, openDatabase } from "../db/open.js";
import { getCurrentElo } from "../db/settings.js";
import type { PlayerMoveEvaluation } from "../engine/evaluate.js";
import type { PlayChoice } from "../engine/play.js";
import { importFinishedGame } from "../import/pgn.js";
import { type StudentOutcome, streakAdjustment } from "./difficulty.js";
import type { GameEngine } from "./engine.js";
import { GameService } from "./service.js";

describe("streakAdjustment", () => {
  const adjust = (elo: number, ...recent: StudentOutcome[]) => streakAdjustment(elo, recent);

  it("raises by 50 after two wins and lowers by 50 after two losses", () => {
    expect(adjust(600, "win", "win")).toEqual({ toElo: 650, reason: "streak_up" });
    expect(adjust(600, "loss", "loss")).toEqual({ toElo: 550, reason: "streak_down" });
  });

  it("needs two games and lets a draw break the streak", () => {
    expect(adjust(600, "win")).toBeNull();
    expect(adjust(600)).toBeNull();
    expect(adjust(600, "win", "draw")).toBeNull();
    expect(adjust(600, "draw", "win")).toBeNull();
    expect(adjust(600, "win", "loss")).toBeNull();
  });

  it("reads only the newest two games", () => {
    expect(adjust(600, "loss", "loss", "win", "win")).toEqual({
      toElo: 550,
      reason: "streak_down",
    });
  });

  it("stays within 100 to 3190 and reports no change at a bound", () => {
    expect(adjust(100, "loss", "loss")).toBeNull();
    expect(adjust(120, "loss", "loss")).toEqual({ toElo: 100, reason: "streak_down" });
    expect(adjust(3190, "win", "win")).toBeNull();
    expect(adjust(3170, "win", "win")).toEqual({ toElo: 3190, reason: "streak_up" });
  });
});

const GRADE: PlayerMoveEvaluation = {
  evalBeforeCp: 0,
  evalAfterCp: 0,
  cpLoss: 0,
  classification: "best",
  bestMoveUci: "e7e5",
  bestMoveSan: "e5",
};

// Plays White's side of the fool's mate every time it is asked, so any number of wins can be scripted.
class FoolsMateEngine implements GameEngine {
  async evaluate(): Promise<PlayerMoveEvaluation> {
    return GRADE;
  }

  async play(fen: string): Promise<PlayChoice> {
    const moveUci = fen.startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/") ? "f2f3" : "g2g4";
    return { moveUci, source: "engine" };
  }
}

let tmp: string;
let db: Database;
let service: GameService;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-difficulty-"));
  db = openDatabase(tmp);
  const sessionId = createCoachSession(db, { promptVersion: "test" }).id;
  service = new GameService({
    db,
    engine: new FoolsMateEngine(),
    notifications: { sessionId: () => sessionId },
  });
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// The student mates the scripted engine as black (fool's mate).
async function win(): Promise<void> {
  await service.newGame({ color: "black" });
  await service.playerMove({ from: "e7", to: "e5" });
  await service.playerMove({ from: "d8", to: "h4" });
}
const loss = async (): Promise<void> => {
  await service.newGame({ color: "white" });
  await service.resign();
};
// Qf1-f7 leaves the black king on h8 without a move and not in check.
async function draw(): Promise<void> {
  await service.newGame({ color: "white", fen: "7k/8/6K1/8/8/8/8/5Q2 w - - 0 1" });
  await service.playerMove({ from: "f1", to: "f7" });
}
const abort = async (): Promise<void> => {
  await service.newGame({ color: "white" });
  await service.abort();
};
const imported = (): void => {
  importFinishedGame(db, {
    pgn: '[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1',
    playerColor: "white",
    source: "pgn",
  });
  // Newer than every game the coach played, which is where an unfiltered query would read them.
  db.prepare("UPDATE games SET finished_at = '2999-01-01T00:00:00Z' WHERE source = 'pgn'").run();
};

const changes = () =>
  db.prepare("SELECT from_elo, to_elo, reason FROM difficulty_changes ORDER BY id").all();
const sequence = async (...steps: (() => Promise<void> | void)[]): Promise<void> => {
  for (const step of steps) await step();
};

describe("the level after finished games", () => {
  it("starts at 600 with an empty log", () => {
    expect(getCurrentElo(db)).toBe(600);
    expect(changes()).toEqual([]);
  });

  it("raises to 650 on the second win, with one log row and one notification", async () => {
    await sequence(win);
    expect(getCurrentElo(db)).toBe(600);
    await sequence(win);
    expect(getCurrentElo(db)).toBe(650);
    expect(changes()).toEqual([{ from_elo: 600, to_elo: 650, reason: "streak_up" }]);
    const rows = listChatTail(db, 1, 50)
      .map((row) => JSON.parse(row.contentJson) as { type: string })
      .filter((content) => content.type === "difficulty_change");
    expect(rows).toEqual([
      { type: "difficulty_change", from_elo: 600, to_elo: 650, reason: "streak_up", game_id: 2 },
    ]);
  });

  it("leaves 600 for win, draw, win", async () => {
    await sequence(win, draw, win);
    expect(getCurrentElo(db)).toBe(600);
  });

  it("lowers to 550 after two losses, and each further loss counts a new pair", async () => {
    await sequence(loss, loss);
    expect(getCurrentElo(db)).toBe(550);
    await sequence(loss);
    expect(getCurrentElo(db)).toBe(500);
    expect(changes()).toHaveLength(2);
  });

  it("counts a resignation as a loss and a stalemate as a draw", async () => {
    await sequence(loss, draw);
    expect(getCurrentElo(db)).toBe(600);
    await sequence(loss, loss);
    expect(getCurrentElo(db)).toBe(550);
  });

  it("counts an aborted game for nothing", async () => {
    await sequence(win, abort);
    expect(getCurrentElo(db)).toBe(600);
    await sequence(win);
    expect(getCurrentElo(db)).toBe(650);
  });

  it("counts an imported game for nothing, even one newer than the last game played here", async () => {
    await sequence(win, imported, imported);
    expect(getCurrentElo(db)).toBe(600);
    await sequence(win);
    expect(getCurrentElo(db)).toBe(650);
  });

  it("never goes below 100", async () => {
    db.prepare("UPDATE settings SET value = '100' WHERE key = 'current_elo'").run();
    await sequence(loss, loss, loss);
    expect(getCurrentElo(db)).toBe(100);
    expect(changes()).toEqual([]);
  });

  it("writes no notification row when no coach is attached, but still moves the level", async () => {
    const bare = new GameService({ db, engine: new FoolsMateEngine() });
    for (let n = 0; n < 2; n++) {
      await bare.newGame({ color: "white" });
      await bare.resign();
    }
    expect(getCurrentElo(db)).toBe(550);
  });

  it("starts the next game at the new level and keeps an explicit elo off the setting", async () => {
    await sequence(win, win);
    await service.newGame({ color: "white" });
    expect(service.current()?.targetElo).toBe(650);
    await service.abort();
    await service.newGame({ color: "white", elo: 1500 });
    expect(service.current()?.targetElo).toBe(1500);
    expect(getCurrentElo(db)).toBe(650);
  });
});
