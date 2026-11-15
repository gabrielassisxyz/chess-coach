import { describe, expect, it } from "vitest";
import {
  lineCardsByAnchor,
  parseToolOutput,
  toolBaseName,
  toolSummary,
} from "../src/state/tool-summary.js";

// What the SDK hands the chat for a tool result: a list of text blocks carrying the tool's JSON.
const out = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];
const P = "mcp__chess__";

describe("toolBaseName", () => {
  it("drops the MCP server prefix and leaves other names alone", () => {
    expect(toolBaseName(`${P}analyze`)).toBe("analyze");
    expect(toolBaseName("Bash")).toBe("Bash");
  });
});

describe("parseToolOutput", () => {
  it("reads the text blocks, a bare JSON string, and nothing else", () => {
    expect(parseToolOutput(out({ a: 1 }))).toEqual({ a: 1 });
    expect(parseToolOutput('{"b":2}')).toEqual({ b: 2 });
    expect(parseToolOutput("+0.3")).toBeNull();
    expect(parseToolOutput(42)).toBeNull();
  });
});

describe("toolSummary", () => {
  const analysis = (score_cp: number, mate?: true) =>
    out({ lines: [{ score_cp, ...(mate ? { mate } : {}), pv: ["d4", "Bg4"] }] });

  it("gives the best move and the score of an analysis, signed, in pawns or as mate", () => {
    expect(toolSummary(`${P}analyze`, { fen: "x" }, analysis(39))).toBe(
      "Analysed the position: best d4, +0.39",
    );
    expect(toolSummary(`${P}analyze`, {}, analysis(-120))).toBe(
      "Analysed the position: best d4, -1.20",
    );
    expect(toolSummary(`${P}analyze`, {}, analysis(10000, true))).toBe(
      "Analysed the position: best d4, +mate",
    );
    expect(toolSummary(`${P}analyze`, {}, analysis(-10000, true))).toBe(
      "Analysed the position: best d4, -mate",
    );
  });

  it.each([
    ["get_progress", {}, "Read your progress"],
    ["read_reference", { name: "curriculum" }, "Read the curriculum reference"],
    ["get_game", {}, "Read the game"],
    ["show_position", { fen: "x" }, "Showed a position on the board"],
    ["make_move", { san: "Qxd5" }, "Played Qxd5 on the demo board"],
    ["new_game", { color: "black", elo: 600 }, "Started a new game as black against 600"],
    ["resign_game", {}, "Resigned the game"],
    ["create_srs_cards", { game_id: 16 }, "Created review cards from game 16"],
    ["add_srs_card", { fen: "x" }, "Saved a review card"],
    ["explain_card", { card_id: 7 }, "Explained review card 7"],
    ["get_puzzles", { motif: "fork", limit: 3 }, "Picked fork puzzles"],
    ["get_due_cards", { limit: 5 }, "Read the review cards due"],
    ["set_difficulty", { elo: 800, reason: "r" }, "Set the engine to 800"],
    ["read_routine", {}, "Read the weekly routine"],
    ["write_routine", { body: "b" }, "Saved the weekly routine"],
    ["serve_puzzle", { puzzle_id: "fk:0" }, "Put a puzzle on the board"],
    ["serve_card", { card_id: 3 }, "Put a review card on the board"],
  ])("words %s in plain English", (tool, input, line) => {
    expect(toolSummary(`${P}${tool}`, input, out({ ok: true }))).toBe(line);
  });

  it("names a refusal with its code, for any tool, flagged as an error the way it arrives", () => {
    const refused = out({ error: "live_game_active", message: "the student is playing" });
    expect(toolSummary(`${P}show_position`, { fen: "x" }, refused, true)).toBe(
      "show_position refused: live_game_active",
    );
    expect(toolSummary(`${P}show_position`, { fen: "x" }, refused)).toBe(
      "show_position refused: live_game_active",
    );
    expect(toolSummary(`${P}serve_card`, { card_id: 3 }, refused)).toBe(
      "serve_card refused: live_game_active",
    );
  });

  it("says a call failed when the SDK marked it, even if the text is not JSON", () => {
    const failed = [{ type: "text", text: "MCP error -32602: Invalid arguments" }];
    expect(toolSummary(`${P}show_position`, { fen: "x" }, failed, true)).toBe(
      "show_position failed",
    );
    // Plain text is a success when the flag is absent: read_reference answers in markdown.
    expect(toolSummary(`${P}read_reference`, { name: "curriculum" }, "# Curriculum")).toBe(
      "Read the curriculum reference",
    );
  });

  it("reads as in progress until the result arrives", () => {
    expect(toolSummary(`${P}make_move`, { san: "e5" })).toBe("Played e5 on the demo board…");
  });

  it("names an unknown tool without its prefix", () => {
    expect(toolSummary(`${P}teleport`, {}, out({}))).toBe("Used teleport");
  });
});

describe("lineCardsByAnchor", () => {
  const offer = (key: string, startFen: string) => ({
    type: "tool",
    key,
    name: `${P}show_position`,
    result: { output: JSON.stringify({ offered: true, start_fen: startFen, moves: [] }) },
  });
  const step = (key: string, startFen: string, moves: string[]) => ({
    type: "tool",
    key,
    name: `${P}make_move`,
    result: { output: JSON.stringify({ offered: true, start_fen: startFen, moves }) },
  });

  it("closes a notification-triggered turn on turn_start before the next turn's message", () => {
    const anchored = lineCardsByAnchor([
      { type: "turn_start", key: "ts1" },
      offer("s1", "f1"),
      step("m1", "f1", ["e4", "e5"]),
      { type: "text", key: "a1", role: "assistant" },
      { type: "turn_start", key: "ts2" },
      { type: "text", key: "a2", role: "assistant" },
    ]);
    expect([...anchored.keys()]).toEqual(["a1"]);
    expect(anchored.get("a1")).toEqual([{ key: "s1", fen: "f1", moves: ["e4", "e5"] }]);
  });

  it("keeps each turn's card under its own coach message across consecutive turns", () => {
    const anchored = lineCardsByAnchor([
      { type: "turn_start", key: "ts1" },
      offer("s1", "f1"),
      { type: "text", key: "a1", role: "assistant" },
      { type: "turn_start", key: "ts2" },
      offer("s2", "f2"),
      step("m2", "f2", ["d4"]),
      { type: "text", key: "a2", role: "assistant" },
    ]);
    expect([...anchored.keys()]).toEqual(["a1", "a2"]);
    expect(anchored.get("a1")).toEqual([{ key: "s1", fen: "f1", moves: [] }]);
    expect(anchored.get("a2")).toEqual([{ key: "s2", fen: "f2", moves: ["d4"] }]);
  });

  it("keeps a textless turn's line anchored to its tool card rather than leaking onto the next turn's message", () => {
    const anchored = lineCardsByAnchor([
      { type: "turn_start", key: "ts1" },
      offer("s1", "f1"),
      { type: "turn_start", key: "ts2" },
      { type: "text", key: "a2", role: "assistant" },
    ]);
    expect([...anchored.keys()]).toEqual(["s1"]);
    expect(anchored.has("a2")).toBe(false);
  });

  it("keeps legacy turns separated by user messages and dividers", () => {
    const anchored = lineCardsByAnchor([
      { type: "text", key: "u1", role: "user" },
      offer("s1", "f1"),
      { type: "text", key: "a1", role: "assistant" },
      { type: "divider", key: "d1" },
      { type: "text", key: "a2", role: "assistant" },
    ]);
    expect([...anchored.keys()]).toEqual(["a1"]);
  });

  it("keeps two offered lines from one turn in order", () => {
    const anchored = lineCardsByAnchor([
      { type: "turn_start", key: "ts1" },
      offer("s1", "f1"),
      step("m1", "f1", ["e4", "e5"]),
      offer("s2", "f2"),
      step("m2", "f2", ["d4", "d5"]),
      { type: "text", key: "a1", role: "assistant" },
    ]);
    expect([...anchored.keys()]).toEqual(["a1"]);
    expect(anchored.get("a1")).toEqual([
      { key: "s1", fen: "f1", moves: ["e4", "e5"] },
      { key: "s2", fen: "f2", moves: ["d4", "d5"] },
    ]);
  });
});
