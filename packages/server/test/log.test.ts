import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLog, MAX_FIELD_BYTES, pruneLogs, RecordingLog } from "../src/log.js";

const at = (iso: string) => ({ now: () => new Date(iso) });

function readLines(dir: string, day: string): Record<string, unknown>[] {
  return readFileSync(join(dir, `${day}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("createFileLog", () => {
  it("appends one JSON line per event to the UTC day's file and echoes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-"));
    const echoed: string[] = [];
    const log = createFileLog({
      dir,
      clock: at("2026-11-05T11:27:08.913Z"),
      echo: (l) => echoed.push(l),
    });
    log.info("game.player_move", { game_id: 16, san: "e5" });
    log.warn("ws.command_failed", { code: "demo_active" });
    const lines = readLines(dir, "2026-11-05");
    expect(lines).toEqual([
      {
        ts: "2026-11-05T11:27:08.913Z",
        level: "info",
        event: "game.player_move",
        game_id: 16,
        san: "e5",
      },
      {
        ts: "2026-11-05T11:27:08.913Z",
        level: "warn",
        event: "ws.command_failed",
        code: "demo_active",
      },
    ]);
    expect(echoed.map((line) => JSON.parse(line))).toEqual(lines);
  });

  it("records an error's name, message and stack", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-"));
    const log = createFileLog({ dir, clock: at("2026-11-05T12:00:00Z"), echo: () => {} });
    log.error("coach.turn_error", new TypeError("boom"), { turn: 3 });
    const [line] = readLines(dir, "2026-11-05");
    expect(line).toMatchObject({
      level: "error",
      turn: 3,
      error_name: "TypeError",
      error_message: "boom",
    });
    expect(String(line?.stack)).toContain("TypeError: boom");
  });

  it("cuts a string or object field over 8 KiB to 8 KiB and marks the line", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-"));
    const log = createFileLog({ dir, clock: at("2026-11-05T12:00:00Z"), echo: () => {} });
    log.info("coach.tool_result", { output: "x".repeat(MAX_FIELD_BYTES + 10), small: "ok" });
    log.info("coach.tool_call", { input: { text: "y".repeat(MAX_FIELD_BYTES) } });
    log.info("coach.tool_call", { input: { text: "fits" } });
    const [long, object, fits] = readLines(dir, "2026-11-05");
    expect(String(long?.output)).toHaveLength(MAX_FIELD_BYTES);
    expect(long).toMatchObject({ small: "ok", truncated: true });
    expect(typeof object?.input).toBe("string");
    expect(String(object?.input)).toHaveLength(MAX_FIELD_BYTES);
    expect(object?.truncated).toBe(true);
    expect(fits).toEqual(expect.objectContaining({ input: { text: "fits" } }));
    expect(fits).not.toHaveProperty("truncated");
  });
});

describe("pruneLogs", () => {
  it("deletes daily files older than 30 days and keeps the rest and anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-"));
    for (const name of ["2026-10-05.jsonl", "2026-10-07.jsonl", "2026-11-05.jsonl", "notes.txt"]) {
      writeFileSync(join(dir, name), "");
    }
    // 31 days before 2026-11-05 is 2026-10-05; 29 days before is 2026-10-07.
    expect(pruneLogs(dir, at("2026-11-05T12:00:00Z"))).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["2026-10-07.jsonl", "2026-11-05.jsonl", "notes.txt"]);
  });
});

describe("RecordingLog", () => {
  it("keeps events in order and finds them by name", () => {
    const log = new RecordingLog();
    log.info("a", { n: 1 });
    log.error("b", new Error("e"));
    expect(log.names()).toEqual(["a", "b"]);
    expect(log.named("b")[0]?.fields).toMatchObject({ error_message: "e" });
  });
});
