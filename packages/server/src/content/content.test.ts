import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { defaultPuzzlesDir, loadPuzzleFiles, REQUIRED_PUZZLE_KEYS } from "./puzzles.js";

// Placeholder for the real tool registry, which the coach tools replace.
const COACH_TOOL_ALLOWLIST = [
  "get_game",
  "show_position",
  "make_move",
  "analyze",
  "new_game",
  "resign_game",
  "create_srs_cards",
  "add_srs_card",
  "explain_card",
  "get_due_cards",
  "get_puzzles",
  "read_routine",
  "write_routine",
  "get_progress",
  "read_reference",
  "serve_puzzle",
  "serve_card",
];

const puzzlesDir = defaultPuzzlesDir();
const puzzleFiles = loadPuzzleFiles(puzzlesDir);
const allPuzzles = [...puzzleFiles.entries()].flatMap(([file, list]) =>
  list.map((puzzle, index) => ({ file, index, puzzle })),
);

describe("puzzle files", () => {
  it("holds nine files and 238 puzzles", () => {
    expect(puzzleFiles.size).toBe(9);
    expect(allPuzzles).toHaveLength(238);
  });

  it("gives every entry the required keys", () => {
    for (const { file, index, puzzle } of allPuzzles) {
      for (const key of REQUIRED_PUZZLE_KEYS) {
        expect(puzzle, `${file}[${index}] missing ${key}`).toHaveProperty(key);
      }
    }
  });

  it("has FENs chess.js parses and solutions that play legally", () => {
    for (const { file, index, puzzle } of allPuzzles) {
      const game = new Chess(puzzle.fen);
      for (const uci of puzzle.solution_moves) {
        const promotion = uci.slice(4);
        const move = game.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          ...(promotion ? { promotion } : {}),
        });
        expect(move, `${file}[${index}] illegal ${uci}`).toBeTruthy();
      }
    }
  });
});

describe("coach prompt", () => {
  const promptPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../content/prompts/coach.md",
  );
  const prompt = readFileSync(promptPath, "utf8");

  it("names only allowlisted tools", () => {
    const toolLike = /`([a-z]+(?:_[a-z]+)+|[a-z]+(?=\())/g;
    const mentioned = new Set([...prompt.matchAll(toolLike)].map((m) => m[1] ?? ""));
    const unknown = [...mentioned].filter((name) => !COACH_TOOL_ALLOWLIST.includes(name));
    expect(unknown).toEqual([]);
    for (const tool of COACH_TOOL_ALLOWLIST) expect(mentioned.has(tool)).toBe(true);
  });

  it("does not mention removed mechanics", () => {
    for (const removed of [
      "evaluate_move",
      "set_position",
      "get_board",
      "set_difficulty",
      "save_session",
      "identify_opening",
      "routine.md",
      "dashboard",
      "current_game.json",
    ]) {
      expect(prompt).not.toContain(removed);
    }
  });
});
