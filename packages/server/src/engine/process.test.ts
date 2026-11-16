import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stockfishCommand } from "./process.js";

describe("stockfishCommand", () => {
  it("runs the engine itself when no niceness is asked for", () => {
    expect(stockfishCommand("/usr/bin/stockfish")).toEqual({
      command: "/usr/bin/stockfish",
      args: [],
    });
  });

  it("runs the engine under nice at the level asked for, which replaces itself with the engine", () => {
    expect(stockfishCommand("/usr/bin/stockfish", 19)).toEqual({
      command: "nice",
      args: ["-n", "19", "--", "/usr/bin/stockfish"],
    });
  });

  it("keeps a path that starts with a dash from being read as an option of nice", () => {
    const { args } = stockfishCommand("-n", 19);
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("-n", 2));
    expect(args.at(-1)).toBe("-n");
  });
});

// The one place the command is run for real: nice has to hand its niceness to the program it
// replaces itself with, whatever program that is, or a background engine would compete at full
// priority with the engines of the game.
describe.skipIf(process.platform !== "linux")("stockfishCommand under nice", () => {
  const niceness = (level?: number): number => {
    const { command, args } = stockfishCommand("sh", level);
    const field19 = "awk '{ print $19 }' /proc/self/stat";
    return Number(execFileSync(command, [...args, "-c", field19], { encoding: "utf8" }).trim());
  };

  // nice adds to the niceness it inherited, so the expectation is relative to the caller's own.
  it("gives the program it runs the niceness asked for", () => {
    expect(niceness(19)).toBe(19);
    expect(niceness(10)).toBe(Math.min(19, niceness() + 10));
  });

  it("leaves the niceness of the caller when none is asked for", () => {
    expect(niceness()).toBe(niceness(0));
  });
});
