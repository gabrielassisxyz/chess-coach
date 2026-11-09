import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGame, getIdsBySource, listMoves } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  assertLichessUsername,
  httpLichessGamesFetcher,
  LICHESS_EXPORT_MAX_BYTES,
  LICHESS_RATE_LIMIT_WAIT_MS,
  LichessError,
  type LichessGame,
  lichessGamesUrl,
  lichessImportRequest,
  parseLichessGames,
} from "./lichess.js";
import { importFinishedGame, PgnImportError } from "./pgn.js";

const EXPORT_2026_10 = readFileSync(
  new URL("../../test/fixtures/lichess/2026-10.ndjson", import.meta.url),
  "utf8",
);
// The fixture streams newest first; the parser hands the importable ones back oldest first.
const IMPORTABLE_OLDEST_FIRST = ["Hj3uBw2C", "Zb6yHs1N", "Wm4cTe9R", "kP2dQv7x"];
const STUDENT = "fixture-student";

// Stands in for fetch and for the wait between two attempts; remembers both.
class FakeLichessHttp {
  readonly calls: { url: string; init: RequestInit | undefined }[] = [];
  readonly waits: number[] = [];
  responses: Response[] = [];
  failure: Error | null = null;

  fetch: typeof fetch = async (input, init) => {
    this.calls.push({ url: String(input), init });
    if (this.failure) throw this.failure;
    return this.responses.shift() ?? new Response(EXPORT_2026_10);
  };

  sleep = async (ms: number): Promise<void> => {
    this.waits.push(ms);
  };

  fetcher(token: () => string | undefined = () => undefined) {
    return httpLichessGamesFetcher(token, this.fetch, this.sleep);
  }
}

const failureOf = async (attempt: Promise<unknown>): Promise<LichessError> => {
  try {
    await attempt;
  } catch (error) {
    return error as LichessError;
  }
  throw new Error("expected the call to fail");
};

const gameById = (games: LichessGame[], id: string): LichessGame => {
  const game = games.find((candidate) => candidate.id === id);
  if (!game) throw new Error(`the fixture has no game ${id}`);
  return game;
};

describe("parseLichessGames", () => {
  it("keeps finished standard games, oldest first, and drops variants and unfinished games", () => {
    expect(parseLichessGames(EXPORT_2026_10).map((game) => game.id)).toEqual(
      IMPORTABLE_OLDEST_FIRST,
    );
  });

  it("ignores blank lines and CRLF line ends, and reads a quiet account as no games", () => {
    const text = EXPORT_2026_10.trim().split("\n").join("\r\n\r\n");
    expect(parseLichessGames(`\r\n${text}\r\n\r\n`)).toHaveLength(IMPORTABLE_OLDEST_FIRST.length);
    expect(parseLichessGames("")).toEqual([]);
    expect(parseLichessGames("\n")).toEqual([]);
  });

  it("drops a game that came without a PGN", () => {
    const line = JSON.parse(EXPORT_2026_10.split("\n")[0] as string);
    delete line.pgn;
    expect(parseLichessGames(JSON.stringify(line))).toEqual([]);
  });

  it.each([
    ["text that is not NDJSON", "<html>502</html>", /not NDJSON/],
    ["a half-delivered last line", `${EXPORT_2026_10}{"id":"Wm4c`, /not NDJSON/],
    ["a line that is not a game", '{"id":"broken"}', /unexpected shape/],
    [
      "an id that cannot be a Lichess game",
      EXPORT_2026_10.replace("kP2dQv7x", "../x"),
      /unexpected shape/,
    ],
  ])("refuses %s instead of reading it as an empty account", (_name, text, message) => {
    expect(() => parseLichessGames(text)).toThrow(message);
    try {
      parseLichessGames(text);
    } catch (error) {
      expect(error).toMatchObject({ code: "upstream" });
    }
  });
});

describe("Lichess usernames", () => {
  it("accepts every shape an account can have and returns the lower-cased id", () => {
    expect(assertLichessUsername("Fixture-Student")).toBe("fixture-student");
    expect(assertLichessUsername("--")).toBe("--");
    expect(assertLichessUsername("A_".repeat(15))).toBe("a_".repeat(15));
  });

  it.each([
    "",
    "a",
    "a".repeat(31),
    "../x",
    "a/b",
    "a?x=1",
    "a#b",
    "name\n",
    " name",
    "na me",
    "ünï",
  ])("refuses %j", (name) => {
    expect(() => assertLichessUsername(name)).toThrow(LichessError);
    expect(() => assertLichessUsername(name)).toThrow(/2 to 30/);
  });

  it("is checked before the fetcher touches the network", async () => {
    const http = new FakeLichessHttp();
    for (const name of ["a", "a".repeat(31), "../test", "a/b", "a?x=1", "name\n"]) {
      await expect(http.fetcher().games(name, "2026-10", "2026-10")).rejects.toMatchObject({
        code: "invalid_username",
      });
    }
    expect(http.calls).toHaveLength(0);
  });
});

describe("lichessGamesUrl", () => {
  it("asks for whole UTC months of the lower-cased account and finished games only", () => {
    const url = new URL(lichessGamesUrl("FIXTURE-Student", "2024-02", "2024-03"));
    expect(url.origin + url.pathname).toBe("https://lichess.org/api/games/user/fixture-student");
    expect(url.searchParams.get("since")).toBe(String(Date.parse("2024-02-01T00:00:00Z")));
    expect(url.searchParams.get("until")).toBe(String(Date.parse("2024-04-01T00:00:00Z") - 1));
    expect(url.searchParams.get("pgnInJson")).toBe("true");
    expect(url.searchParams.get("ongoing")).toBe("false");
  });

  it("closes December at the end of the year", () => {
    const url = new URL(lichessGamesUrl(STUDENT, "2025-12", "2025-12"));
    expect(url.searchParams.get("until")).toBe(String(Date.parse("2026-01-01T00:00:00Z") - 1));
  });

  it.each([
    ["2026-13", "2026-13"],
    ["2026-1", "2026-10"],
    ["2026-10", "2026-09"],
    ["2020-01", "2026-10"],
  ])("refuses the range %s to %s before fetching", async (from, to) => {
    const http = new FakeLichessHttp();
    await expect(http.fetcher().games(STUDENT, from, to)).rejects.toMatchObject({
      code: "invalid_range",
    });
    expect(http.calls).toHaveLength(0);
  });
});

describe("httpLichessGamesFetcher", () => {
  it("reads the export into games, identifying the app and never following a redirect", async () => {
    const http = new FakeLichessHttp();
    const games = await http.fetcher().games(STUDENT, "2026-10", "2026-10");
    expect(games.map((game) => game.id)).toEqual(IMPORTABLE_OLDEST_FIRST);
    const init = http.calls[0]?.init;
    expect(init?.headers).toMatchObject({
      Accept: "application/x-ndjson",
      "User-Agent": expect.stringContaining("chess-coach"),
    });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the token in the Authorization header only, read again on every call", async () => {
    const http = new FakeLichessHttp();
    let token: string | undefined = "lip_test-token";
    const fetcher = http.fetcher(() => token);
    await fetcher.games(STUDENT, "2026-10", "2026-10");
    expect(http.calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer lip_test-token" });
    expect(http.calls[0]?.url).not.toContain("lip_test-token");
    token = undefined;
    await fetcher.games(STUDENT, "2026-10", "2026-10");
    expect(http.calls[1]?.init?.headers).not.toHaveProperty("Authorization");
  });

  it("waits a full minute on a 429 and tries once more", async () => {
    const http = new FakeLichessHttp();
    http.responses = [new Response(null, { status: 429 })];
    const games = await http.fetcher().games(STUDENT, "2026-10", "2026-10");
    expect(games).toHaveLength(IMPORTABLE_OLDEST_FIRST.length);
    expect(LICHESS_RATE_LIMIT_WAIT_MS).toBe(60_000);
    expect(http.waits).toEqual([60_000]);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1]?.url).toBe(http.calls[0]?.url);
  });

  it("gives up after the second 429 and says Lichess is rate limiting", async () => {
    const http = new FakeLichessHttp();
    http.responses = [new Response(null, { status: 429 }), new Response(null, { status: 429 })];
    await expect(http.fetcher().games(STUDENT, "2026-10", "2026-10")).rejects.toMatchObject({
      code: "rate_limited",
      message: expect.stringMatching(/rate limiting/),
    });
    expect(http.waits).toEqual([60_000]);
    expect(http.calls).toHaveLength(2);
  });

  it("reports another failure after the wait without trying a third time", async () => {
    const http = new FakeLichessHttp();
    http.responses = [new Response(null, { status: 429 }), new Response(null, { status: 503 })];
    await expect(http.fetcher().games(STUDENT, "2026-10", "2026-10")).rejects.toMatchObject({
      code: "upstream",
      message: "Lichess answered 503",
    });
    expect(http.calls).toHaveLength(2);
  });

  it("neither waits nor retries for any other failure", async () => {
    const http = new FakeLichessHttp();
    http.responses = [new Response(null, { status: 500 })];
    await expect(http.fetcher().games(STUDENT, "2026-10", "2026-10")).rejects.toMatchObject({
      code: "upstream",
    });
    expect(http.waits).toEqual([]);
    expect(http.calls).toHaveLength(1);
  });

  it("says when the account does not exist", async () => {
    const http = new FakeLichessHttp();
    http.responses = [new Response('{"error":"Not found"}', { status: 404 })];
    await expect(http.fetcher().games(STUDENT, "2026-10", "2026-10")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("names the saved token when Lichess refuses it, without quoting it", async () => {
    const http = new FakeLichessHttp();
    http.responses = [new Response('{"error":"No such token"}', { status: 401 })];
    const failure = await failureOf(
      http.fetcher(() => "lip_test-secret").games(STUDENT, "2026-10", "2026-10"),
    );
    expect(failure).toMatchObject({ code: "upstream", message: expect.stringMatching(/token/) });
    expect(failure.message).not.toContain("lip_test-secret");
  });

  it("refuses an answer that declares more than the cap", async () => {
    const http = new FakeLichessHttp();
    http.responses = [
      new Response("", { headers: { "content-length": String(LICHESS_EXPORT_MAX_BYTES + 1) } }),
    ];
    await expect(http.fetcher().games(STUDENT, "2026-10", "2026-10")).rejects.toThrow(/too many/);
  });

  it("stops reading a stream at the cap instead of buffering the rest", async () => {
    const http = new FakeLichessHttp();
    const state = { pulls: 0, cancelled: false };
    const chunk = new Uint8Array(1_000_000).fill(120);
    http.responses = [
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            state.pulls += 1;
            controller.enqueue(chunk);
          },
          cancel() {
            state.cancelled = true;
          },
        }),
      ),
    ];
    await expect(http.fetcher().games(STUDENT, "2026-10", "2026-10")).rejects.toThrow(/too many/);
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThan(40);
  });

  it("does not repeat a secret from a failed fetch or a broken stream", async () => {
    const secret = "lip_test-secret";
    const http = new FakeLichessHttp();
    http.failure = new Error(`bad header Bearer ${secret}`);
    const unreachable = await failureOf(
      http.fetcher(() => secret).games(STUDENT, "2026-10", "2026-10"),
    );
    expect(unreachable).toMatchObject({
      code: "upstream",
      message: "Lichess could not be reached",
    });

    http.failure = null;
    http.responses = [
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`socket closed Bearer ${secret}`));
          },
        }),
      ),
    ];
    const broken = await failureOf(http.fetcher(() => secret).games(STUDENT, "2026-10", "2026-10"));
    expect(broken).toMatchObject({ code: "upstream" });
    expect(broken.message).not.toContain(secret);
  });
});

describe("lichessImportRequest", () => {
  const games = parseLichessGames(EXPORT_2026_10);

  it("takes the side, ratings, opponent and time control of a game the student won as white", () => {
    expect(lichessImportRequest(gameById(games, "Wm4cTe9R"), STUDENT)).toMatchObject({
      playerColor: "white",
      source: "lichess",
      sourceId: "Wm4cTe9R",
      sourceUrl: "https://lichess.org/Wm4cTe9R",
      opponent: "fixture-rival",
      studentRating: 1538,
      opponentRating: 1612,
      timeControl: "300+3",
      playedAt: "2026-10-21T12:03:40.000Z",
    });
  });

  it("names a computer opponent and leaves out a rating it does not have", () => {
    const request = lichessImportRequest(gameById(games, "kP2dQv7x"), STUDENT);
    expect(request).toMatchObject({ playerColor: "black", opponent: "Stockfish level 3" });
    expect(request).toMatchObject({ studentRating: 1544, timeControl: "600+0" });
    expect(request).not.toHaveProperty("opponentRating");
  });

  it("writes a correspondence game as Chess.com writes a daily one", () => {
    expect(lichessImportRequest(gameById(games, "Hj3uBw2C"), STUDENT).timeControl).toBe("1/259200");
  });

  it("matches the account whatever the case of the name", () => {
    expect(lichessImportRequest(gameById(games, "Zb6yHs1N"), "FIXTURE-STUDENT").playerColor).toBe(
      "black",
    );
  });

  it("refuses a game the account did not play", () => {
    expect(() => lichessImportRequest(gameById(games, "Wm4cTe9R"), "someone-else")).toThrow(
      PgnImportError,
    );
  });
});

describe("storing Lichess games", () => {
  let tmp: string;
  let db: Database;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cc-lichess-"));
    db = openDatabase(tmp);
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const importAll = (): (number | null)[] =>
    parseLichessGames(EXPORT_2026_10).map((game) =>
      importFinishedGame(db, lichessImportRequest(game, STUDENT)),
    );

  it("stores each game once: a second import adds nothing", () => {
    const first = importAll();
    expect(first.every((id) => id !== null)).toBe(true);
    expect(importAll()).toEqual(first.map(() => null));
    expect(db.prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: 4 });
    expect(getIdsBySource(db, "lichess", IMPORTABLE_OLDEST_FIRST)).toEqual(
      new Set(IMPORTABLE_OLDEST_FIRST),
    );
    expect(getIdsBySource(db, "chesscom", IMPORTABLE_OLDEST_FIRST).size).toBe(0);
  });

  it("keeps ids growing with the date and the student's plies on the right side", () => {
    importAll();
    const rows = db.prepare("SELECT id, source_id, source, grading FROM games ORDER BY id").all();
    expect(rows).toEqual(
      IMPORTABLE_OLDEST_FIRST.map((sourceId, index) => ({
        id: index + 1,
        source_id: sourceId,
        source: "lichess",
        grading: "pending",
      })),
    );
    const blackGame = getGame(db, 4);
    expect(blackGame).toMatchObject({ playerColor: "black", opponent: "Stockfish level 3" });
    const moves = listMoves(db, 4);
    expect(moves[0]).toMatchObject({ san: "e4", isPlayer: false });
    expect(moves[1]).toMatchObject({ san: "e5", isPlayer: true });
  });
});

// Opt-in: one real call to the public export, capped at one game. It asserts the shape the importer
// reads, never which games exist. A LICHESS_API_TOKEN is used when set; none is needed.
describe.skipIf(process.env.CHESS_COACH_LICHESS_GAMES !== "1")("real Lichess games", () => {
  it("reads one game of a busy public account in the shape the importer reads", async () => {
    // Only the speeds that are standard chess, so the newest game is never a variant the importer
    // drops, and one game back proves the reader still recognises what Lichess sends.
    const capped: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      url.searchParams.set("max", "1");
      url.searchParams.set("perfType", "bullet,blitz,rapid,classical");
      return fetch(url, init);
    };
    const now = new Date();
    const to = now.toISOString().slice(0, 7);
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 35, 1))
      .toISOString()
      .slice(0, 7);
    const games = await httpLichessGamesFetcher(
      () => process.env.LICHESS_API_TOKEN || undefined,
      capped,
    ).games("DrNykterstein", from, to);
    expect(games).toHaveLength(1);
    for (const game of games) {
      expect(game.id).toMatch(/^[A-Za-z0-9]{8}$/);
      expect(game.pgn).toContain('[Result "');
      expect(game.lastMoveAt).toBeGreaterThanOrEqual(game.createdAt);
      expect(typeof game.players.white).toBe("object");
      expect(lichessImportRequest(game, "drnykterstein").playerColor).toMatch(/^(white|black)$/);
    }
  }, 35_000);
});
