import { describe, expect, it } from "vitest";
import { FakeChessCom } from "../../test/fakes/fake-chesscom.js";
import {
  assertUsername,
  ChessComError,
  ChessComSource,
  httpFetcher,
  MAX_RANGE_MONTHS,
  MONTH_CACHE_MS,
  monthsBetween,
  parseMonth,
  USER_AGENT,
} from "./chesscom.js";

describe("assertUsername", () => {
  it("accepts the Chess.com alphabet and lowercases it for the URL", () => {
    expect(assertUsername("Dibitard49")).toBe("dibitard49");
    expect(assertUsername("a_b-c")).toBe("a_b-c");
  });

  it.each(["ab", "a".repeat(26), "a/b", "a b", "../x", "a?b=c", "a%2fb", "", "über"])(
    "rejects %j before it can reach a URL",
    (name) => {
      expect(() => assertUsername(name)).toThrow(ChessComError);
    },
  );
});

describe("monthsBetween", () => {
  it("walks across a year boundary inclusively", () => {
    expect(monthsBetween("2026-11", "2027-02")).toEqual([
      { year: 2026, month: 11 },
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
      { year: 2027, month: 2 },
    ]);
  });

  it("rejects bad shapes, a reversed range and one that is too long", () => {
    expect(() => monthsBetween("2026-13", "2026-12")).toThrow(/YYYY-MM/);
    expect(() => monthsBetween("2026-10", "2026-09")).toThrow(/after/);
    expect(() => monthsBetween("2020-01", "2026-12")).toThrow(String(MAX_RANGE_MONTHS));
  });
});

describe("parseMonth", () => {
  it("keeps standard chess games and drops variants and games without a PGN", () => {
    const side = { username: "a", result: "win" };
    const base = { url: "u", end_time: 1, white: side, black: side };
    const games = parseMonth(
      JSON.stringify({
        games: [
          { ...base, uuid: "1", pgn: "x", rules: "chess" },
          { ...base, uuid: "2", pgn: "x", rules: "chess960" },
          { ...base, uuid: "3" },
          { nonsense: true },
        ],
      }),
    );
    expect(games.map((game) => game.uuid)).toEqual(["1"]);
  });

  it("names a non-JSON answer as an upstream failure", () => {
    expect(() => parseMonth("<html>")).toThrow(/not JSON/);
  });
});

describe("ChessComSource", () => {
  it("fetches each month once inside ten minutes and again after", async () => {
    let now = 1_000_000;
    const fake = new FakeChessCom();
    const source = new ChessComSource(fake, { now: () => new Date(now) });
    await source.games("assiszzz", "2026-10", "2026-10");
    await source.games("AssisZZZ", "2026-10", "2026-10");
    expect(fake.asked).toEqual(["assiszzz/2026-10"]);
    now += MONTH_CACHE_MS + 1;
    await source.games("assiszzz", "2026-10", "2026-10");
    expect(fake.asked).toHaveLength(2);
  });

  it("returns newest first and finds listed games by uuid, but not unlisted ones", async () => {
    const source = new ChessComSource(new FakeChessCom());
    const games = await source.games("assiszzz", "2026-10", "2026-10");
    const times = games.map((game) => game.end_time);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(source.lookup("assiszzz", [games[0]?.uuid as string])).toHaveLength(1);
    expect(() => source.lookup("assiszzz", ["nope"])).toThrow(/list them again/);
    expect(() => source.lookup("someoneelse", [games[0]?.uuid as string])).toThrow(ChessComError);
  });
});

describe("httpFetcher", () => {
  const month = JSON.stringify({ games: [] });

  it("calls the lowercased profile URL with the app's User-Agent", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher = httpFetcher(async (url, init) => {
      calls.push([String(url), init]);
      return new Response(month);
    });
    await fetcher.month("AssisZZZ", 2026, 3);
    expect(calls[0]?.[0]).toBe("https://api.chess.com/pub/player/assiszzz/games/2026/03");
    const headers = (calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["User-Agent"]).toBe(USER_AGENT);
  });

  it("treats 404 as an empty month and other errors as upstream failures", async () => {
    expect(
      await httpFetcher(async () => new Response("", { status: 404 })).month("abc", 2026, 1),
    ).toEqual([]);
    await expect(
      httpFetcher(async () => new Response("", { status: 500 })).month("abc", 2026, 1),
    ).rejects.toThrow(/500/);
    await expect(
      httpFetcher(async () => Promise.reject(new Error("offline"))).month("abc", 2026, 1),
    ).rejects.toThrow(/could not be reached/);
  });

  it("refuses a bad username without making a request", async () => {
    let called = false;
    const fetcher = httpFetcher(async () => {
      called = true;
      return new Response(month);
    });
    await expect(fetcher.month("../etc", 2026, 1)).rejects.toThrow(ChessComError);
    expect(called).toBe(false);
  });
});
