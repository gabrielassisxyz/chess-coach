import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../clock.js";
import { type Database, openDatabase } from "../db/open.js";
import { importFinishedGame } from "../import/pgn.js";
import { parseOpeningTable } from "./names.js";
import { listPlayedOpenings } from "./played.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const clock: Clock = { now: () => NOW };
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();

const fenKey = (fen: string): string => fen.split(" ").slice(0, 4).join(" ");

function fenAfter(...sans: string[]): string {
  const board = new Chess();
  for (const san of sans) board.move(san);
  return board.fen();
}

const names = parseOpeningTable(
  [
    "eco\tname\tpgn\tuci\tepd",
    `C50\tItalian Game\t1. e4 e5 2. Nf3 Nc6 3. Bc4\te2e4\t${fenKey(fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4"))}`,
    `C55\tItalian Game: Two Knights Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6\te2e4\t${fenKey(fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"))}`,
    `C50\tItalian Game: Giuoco Piano\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5\te2e4\t${fenKey(fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"))}`,
    `B01\tScandinavian Defense\t1. e4 d5\te2e4\t${fenKey(fenAfter("e4", "d5"))}`,
    `C00\tFrench Defense\t1. e4 e6\te2e4\t${fenKey(fenAfter("e4", "e6"))}`,
    `B10\tCaro-Kann Defense\t1. e4 c6\te2e4\t${fenKey(fenAfter("e4", "c6"))}`,
    `B02\tAlekhine Defense\t1. e4 Nf6\te2e4\t${fenKey(fenAfter("e4", "Nf6"))}`,
    "",
  ].join("\n"),
);

const ITALIAN_KNIGHTS = '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 1-0';
const ITALIAN_GIUOCO = '[Result "0-1"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 0-1';
const SCANDINAVIAN = '[Result "1/2-1/2"]\n\n1. e4 d5 1/2-1/2';
const UNNAMED_GAME = '[Result "1-0"]\n\n1. d4 d5 2. c4 e6 1-0';

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-played-"));
  db = openDatabase(tmp);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function addGame(
  pgn: string,
  color: "white" | "black",
  id: string,
  playedAt: string,
  source: "pgn" | "chesscom" | "lichess" = "pgn",
  practice = false,
): number {
  const gameId = importFinishedGame(db, {
    pgn,
    playerColor: color,
    source,
    sourceId: id,
    playedAt,
    practice,
  });
  if (gameId === null) throw new Error("fixture game was not imported");
  return gameId;
}

describe("listPlayedOpenings", () => {
  it("counts the three games as White: Italian mine, Scandinavian against", () => {
    addGame(ITALIAN_KNIGHTS, "white", "w1", daysAgo(1));
    addGame(ITALIAN_GIUOCO, "white", "w2", daysAgo(2));
    addGame(SCANDINAVIAN, "white", "w3", daysAgo(3));
    const { white, black } = listPlayedOpenings(db, names, "30", clock);
    expect(white.games).toBe(3);
    expect(white.mine).toHaveLength(1);
    expect(white.against).toHaveLength(1);
    const [italian] = white.mine;
    expect(italian?.opening).toBe("Italian Game");
    expect(italian?.games).toBe(2);
    expect(italian?.wins).toBe(1);
    expect(italian?.losses).toBe(1);
    expect(italian?.draws).toBe(0);
    expect(italian?.line).toBe("1.e4 e5 2.Nf3 Nc6 3.Bc4");
    expect(italian?.variations).toHaveLength(2);
    expect(italian?.variations.map((row) => row.name).sort()).toEqual([
      "Giuoco Piano",
      "Two Knights Defense",
    ]);
    const knights = italian?.variations.find((row) => row.name === "Two Knights Defense");
    expect(knights).toMatchObject({
      full_name: "Italian Game: Two Knights Defense",
      games: 1,
      wins: 1,
      losses: 0,
      line: "1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6",
    });
    const [scandinavian] = white.against;
    expect(scandinavian?.opening).toBe("Scandinavian Defense");
    expect(scandinavian).toMatchObject({ games: 1, wins: 0, draws: 1, losses: 0 });
    expect(scandinavian?.line).toBe("1.e4 d5");
    expect(scandinavian?.variations).toEqual([
      {
        name: "Main line",
        full_name: "Scandinavian Defense",
        line: "1.e4 d5",
        games: 1,
        wins: 0,
        draws: 1,
        losses: 0,
      },
    ]);
    expect(black).toEqual({ games: 0, mine: [], against: [] });
  });

  it("counts the same three games as Black with the sides and results turned around", () => {
    addGame(ITALIAN_KNIGHTS, "black", "b1", daysAgo(1));
    addGame(ITALIAN_GIUOCO, "black", "b2", daysAgo(2));
    addGame(SCANDINAVIAN, "black", "b3", daysAgo(3));
    const { white, black } = listPlayedOpenings(db, names, "30", clock);
    expect(white).toEqual({ games: 0, mine: [], against: [] });
    expect(black.games).toBe(3);
    expect(black.mine).toHaveLength(1);
    expect(black.against).toHaveLength(1);
    const [scandinavian] = black.mine;
    expect(scandinavian?.opening).toBe("Scandinavian Defense");
    expect(scandinavian).toMatchObject({ games: 1, draws: 1 });
    const [italian] = black.against;
    expect(italian?.opening).toBe("Italian Game");
    expect(italian).toMatchObject({ games: 2, wins: 1, losses: 1 });
    // The 1-0 Two Knights game is a loss as Black and the 0-1 Giuoco Piano a win.
    expect(italian?.variations.find((row) => row.name === "Two Knights Defense")).toMatchObject({
      games: 1,
      wins: 0,
      losses: 1,
    });
    expect(italian?.variations.find((row) => row.name === "Giuoco Piano")).toMatchObject({
      games: 1,
      wins: 1,
      losses: 0,
    });
  });

  it("leaves out a game against the coach and a game with no result", () => {
    addGame(ITALIAN_KNIGHTS, "white", "w1", daysAgo(1));
    const coach = addGame(ITALIAN_GIUOCO, "white", "coach1", daysAgo(1));
    db.prepare("UPDATE games SET source = 'coach' WHERE id = ?").run(coach);
    const noResult = addGame(SCANDINAVIAN, "white", "noresult", daysAgo(1));
    db.prepare("UPDATE games SET result = NULL WHERE id = ?").run(noResult);
    const { white } = listPlayedOpenings(db, names, "30", clock);
    expect(white.games).toBe(1);
    expect(white.mine[0]?.games).toBe(1);
    expect(white.against).toEqual([]);
  });

  it("counts a game with no named position as an unnamed opening in mine, listed last", () => {
    addGame(UNNAMED_GAME, "white", "u1", daysAgo(1));
    addGame(ITALIAN_KNIGHTS, "white", "w1", daysAgo(2));
    const { white } = listPlayedOpenings(db, names, "30", clock);
    expect(white.games).toBe(2);
    expect(white.mine.map((entry) => entry.opening)).toEqual(["Italian Game", "Unnamed opening"]);
    const [unnamed] = white.mine.slice(-1);
    expect(unnamed).toMatchObject({ opening: "Unnamed opening", games: 1, wins: 1 });
    expect(unnamed?.variations).toHaveLength(1);
    expect(unnamed?.variations[0]).toMatchObject({
      name: "Unnamed opening",
      full_name: "Unnamed opening",
    });
  });

  it("keeps the coach game out even when it names an opening", () => {
    const coach = addGame(SCANDINAVIAN, "black", "coach1", daysAgo(1));
    db.prepare("UPDATE games SET source = 'coach' WHERE id = ?").run(coach);
    expect(listPlayedOpenings(db, names, "all", clock)).toEqual({
      white: { games: 0, mine: [], against: [] },
      black: { games: 0, mine: [], against: [] },
    });
  });

  it("filters by the window on COALESCE(played_at, started_at)", () => {
    addGame(ITALIAN_KNIGHTS, "white", "recent", daysAgo(6));
    addGame(ITALIAN_GIUOCO, "white", "month", daysAgo(20));
    addGame(SCANDINAVIAN, "white", "old", daysAgo(80));
    // A game with no played_at falls back to started_at, which the import sets to now.
    const started = importFinishedGame(db, {
      pgn: ITALIAN_KNIGHTS,
      playerColor: "white",
      source: "pgn",
      sourceId: "started",
    });
    if (started === null) throw new Error("fixture game was not imported");
    db.prepare("UPDATE games SET played_at = NULL, started_at = ? WHERE id = ?").run(
      daysAgo(2),
      started,
    );
    const week = listPlayedOpenings(db, names, "7", clock);
    expect(week.white.games).toBe(2);
    const month = listPlayedOpenings(db, names, "30", clock);
    expect(month.white.games).toBe(3);
    const quarter = listPlayedOpenings(db, names, "90", clock);
    expect(quarter.white.games).toBe(4);
    const all = listPlayedOpenings(db, names, "all", clock);
    expect(all.white.games).toBe(4);
  });

  it("orders openings and variations by games, then by name", () => {
    addGame(ITALIAN_KNIGHTS, "white", "w1", daysAgo(1));
    addGame(ITALIAN_GIUOCO, "white", "w2", daysAgo(1));
    addGame(SCANDINAVIAN, "white", "w3", daysAgo(1));
    addGame(UNNAMED_GAME, "white", "w4", daysAgo(1));
    const { white } = listPlayedOpenings(db, names, "30", clock);
    expect(white.mine.map((entry) => entry.opening)).toEqual(["Italian Game", "Unnamed opening"]);
    const [italian] = white.mine;
    expect(italian?.variations.map((row) => row.name)).toEqual([
      "Giuoco Piano",
      "Two Knights Defense",
    ]);
  });

  it("takes the line from the most recent game of each entry", () => {
    addGame(ITALIAN_KNIGHTS, "white", "w1", daysAgo(5));
    addGame(ITALIAN_GIUOCO, "white", "w2", daysAgo(1));
    const { white } = listPlayedOpenings(db, names, "30", clock);
    const [italian] = white.mine;
    // The most recent Italian game is the Giuoco Piano, so the opening line ends at 3.Bc4
    // and the variation line ends at the last named position of that game.
    expect(italian?.line).toBe("1.e4 e5 2.Nf3 Nc6 3.Bc4");
    expect(italian?.variations.find((row) => row.name === "Giuoco Piano")?.line).toBe(
      "1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5",
    );
  });

  it("separates the window from either date column alone", () => {
    // Played recently but started long ago: inside the week only when played_at leads.
    const playedRecently = addGame(ITALIAN_KNIGHTS, "white", "played-recent", daysAgo(2));
    db.prepare("UPDATE games SET started_at = ? WHERE id = ?").run(daysAgo(200), playedRecently);
    // Started recently but played long ago: outside the week, since played_at leads.
    const playedLongAgo = addGame(ITALIAN_GIUOCO, "white", "played-old", daysAgo(200));
    db.prepare("UPDATE games SET started_at = ? WHERE id = ?").run(daysAgo(2), playedLongAgo);
    const week = listPlayedOpenings(db, names, "7", clock);
    expect(week.white.games).toBe(1);
    expect(week.white.mine[0]?.variations.map((row) => row.name)).toEqual(["Two Knights Defense"]);
  });

  it("orders by games descending, then by name, for openings and for variations", () => {
    const fixtures: Array<[string, string]> = [
      ['[Result "1-0"]\n\n1. e4 d5 1-0', "s1"],
      ['[Result "1-0"]\n\n1. e4 e6 1-0', "f1"],
      ['[Result "1-0"]\n\n1. e4 e6 1-0', "f2"],
      ['[Result "1-0"]\n\n1. e4 c6 1-0', "c1"],
      ['[Result "1-0"]\n\n1. e4 c6 1-0', "c2"],
      ['[Result "1-0"]\n\n1. e4 Nf6 1-0', "a1"],
    ];
    for (const [pgn, id] of fixtures) addGame(pgn, "white", id, daysAgo(1));
    addGame(ITALIAN_KNIGHTS, "white", "k1", daysAgo(1));
    addGame(ITALIAN_KNIGHTS, "white", "k2", daysAgo(1));
    addGame(ITALIAN_GIUOCO, "white", "g1", daysAgo(1));
    const { white } = listPlayedOpenings(db, names, "30", clock);
    expect(white.against.map((entry) => entry.opening)).toEqual([
      "Caro-Kann Defense",
      "French Defense",
      "Alekhine Defense",
      "Scandinavian Defense",
    ]);
    expect(white.mine[0]?.variations.map((row) => row.name)).toEqual([
      "Two Knights Defense",
      "Giuoco Piano",
    ]);
  });

  it("takes the line from the most recent game when move orders differ", () => {
    const nf3First = '[Result "1-0"]\n\n1. Nf3 Nc6 2. e4 e5 3. Bc4 Nf6 1-0';
    // The newer game is stored first, so a rule that lets the last stored game win fails.
    addGame(nf3First, "white", "newer", daysAgo(1));
    addGame(ITALIAN_KNIGHTS, "white", "older", daysAgo(5));
    const [italian] = listPlayedOpenings(db, names, "30", clock).white.mine;
    expect(italian?.line).toBe("1.Nf3 Nc6 2.e4 e5 3.Bc4");
    expect(italian?.variations[0]?.line).toBe("1.Nf3 Nc6 2.e4 e5 3.Bc4 Nf6");
  });

  it("leaves practice games out while counting regular games", () => {
    addGame(ITALIAN_KNIGHTS, "white", "counted", daysAgo(1), "pgn", false);
    addGame(ITALIAN_GIUOCO, "white", "practice-same", daysAgo(1), "pgn", true);
    addGame(SCANDINAVIAN, "white", "practice-other", daysAgo(1), "pgn", true);
    const { white } = listPlayedOpenings(db, names, "30", clock);
    expect(white.games).toBe(1);
    expect(white.mine).toHaveLength(1);
    expect(white.mine[0]).toMatchObject({
      opening: "Italian Game",
      games: 1,
      wins: 1,
      losses: 0,
    });
    expect(white.against).toEqual([]);
  });
});
