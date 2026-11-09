import { describe, expect, it } from "vitest";
import {
  ExplorerError,
  explorerUrl,
  httpExplorerFetcher,
  ITALIAN_WHITE_BAND_LABEL,
  ITALIAN_WHITE_RATINGS,
  MAX_RESPONSE_BYTES,
  parsePosition,
} from "./explorer-client.js";

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function answering(
  status: number,
  body = "{}",
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}

describe("explorer client", () => {
  it("builds the query from constants and the encoded position", () => {
    const url = new URL(explorerUrl(FEN));
    expect(url.origin).toBe("https://explorer.lichess.org");
    expect(url.searchParams.get("ratings")).toBe("0,1000");
    expect(url.searchParams.get("speeds")).toBe("rapid,blitz");
    expect(url.searchParams.get("fen")).toBe(FEN);
  });

  it("accepts a rating band per call for the Italian walk", () => {
    const low = new URL(explorerUrl(FEN, "0,1000"));
    expect(low.searchParams.get("ratings")).toBe("0,1000");
    const high = new URL(explorerUrl(FEN, "1800,2000,2200"));
    expect(high.searchParams.get("ratings")).toBe("1800,2000,2200");
    expect(high.searchParams.get("fen")).toBe(FEN);
  });

  it("keeps the White Italian band on the groups it covers", () => {
    expect(ITALIAN_WHITE_RATINGS).toBe("1800,2000,2200");
    expect(ITALIAN_WHITE_BAND_LABEL).toBe("1800-2499");
  });

  it("requests the given band from the network", async () => {
    let seenUrl = "";
    const spy = (async (url: string) => {
      seenUrl = url;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await httpExplorerFetcher("secret", spy).fetch(FEN, "1800,2000,2200");
    expect(new URL(seenUrl).searchParams.get("ratings")).toBe("1800,2000,2200");
    await httpExplorerFetcher("secret", spy).fetch(FEN);
    expect(new URL(seenUrl).searchParams.get("ratings")).toBe("0,1000");
  });

  it("names the app and sends the token when there is one", async () => {
    let seen: Headers | undefined;
    const spy = (async (_url: string, init: RequestInit) => {
      seen = new Headers(init.headers);
      return new Response("{}");
    }) as unknown as typeof fetch;
    await httpExplorerFetcher("secret", spy).fetch(FEN);
    expect(seen?.get("user-agent")).toContain("chess-coach");
    expect(seen?.get("authorization")).toBe("Bearer secret");
    await httpExplorerFetcher(undefined, spy).fetch(FEN);
    expect(seen?.get("authorization")).toBeNull();
  });

  it("reports a missing token as unauthorized and an oversized answer as upstream", async () => {
    await expect(httpExplorerFetcher(undefined, answering(401)).fetch(FEN)).rejects.toMatchObject({
      code: "unauthorized",
    });
    const huge = "x".repeat(MAX_RESPONSE_BYTES + 1);
    await expect(httpExplorerFetcher("t", answering(200, huge)).fetch(FEN)).rejects.toMatchObject({
      code: "upstream",
    });
    await expect(
      httpExplorerFetcher(
        "t",
        answering(200, "{}", { "content-length": String(MAX_RESPONSE_BYTES + 1) }),
      ).fetch(FEN),
    ).rejects.toMatchObject({ code: "upstream" });
  });

  it("rejects an answer that is not the expected shape", () => {
    expect(() => parsePosition("nope")).toThrow(ExplorerError);
    expect(() => parsePosition('{"white":1}')).toThrow(ExplorerError);
  });
});
