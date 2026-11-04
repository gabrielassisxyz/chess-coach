import { describe, expect, it } from "vitest";
import { type CoachEvent, mapSdkMessage } from "../../src/coach/events.js";
import { loadRecordedTurns } from "../fakes/fake-sdk.js";

function mapTurn(index: number) {
  const turn = loadRecordedTurns()[index] ?? [];
  return turn.map(mapSdkMessage);
}

describe("mapSdkMessage over the recorded stream", () => {
  it("turns a plain reply into text deltas followed by turn_end", () => {
    const events = mapTurn(0).flatMap((m) => m.events);
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "turn_end"]);
    const end = events.at(-1);
    expect(end?.kind === "turn_end" && end.usage.outputTokens).toBeGreaterThan(0);
  });

  it("reports the model, session id and advertised tools from init", () => {
    const init = mapTurn(0).find((m) => m.init)?.init;
    expect(init?.sessionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(init?.tools).toEqual(["mcp__chess__get_progress", "mcp__chess__read_reference"]);
    expect(init?.apiKeySource).toBe("none");
  });

  it("maps a tool round trip to tool_use then tool_result then more text", () => {
    const events = mapTurn(1).flatMap((m) => m.events);
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "tool_use")).toHaveLength(1);
    expect(kinds.indexOf("tool_use")).toBeLessThan(kinds.indexOf("tool_result"));
    expect(kinds.at(-1)).toBe("turn_end");
    const use = events.find(
      (e): e is Extract<CoachEvent, { kind: "tool_use" }> => e.kind === "tool_use",
    );
    expect(use).toMatchObject({
      name: "mcp__chess__read_reference",
      input: { name: "curriculum" },
    });
  });

  it("finalizes one item per completed block and none per delta", () => {
    const finalized = mapTurn(1).flatMap((m) => m.finalized);
    expect(finalized.map((f) => `${f.role}:${f.kind}`)).toEqual([
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:text",
    ]);
  });

  it("turns an error result into turn_error", () => {
    const [result] = loadRecordedTurns()[0]?.slice(-1) ?? [];
    if (result?.type !== "result" || result.subtype !== "success") throw new Error("fixture shape");
    const failed = mapSdkMessage({ ...result, is_error: true, result: "rate limited" });
    expect(failed.events).toEqual([{ kind: "turn_error", message: "rate limited" }]);
  });
});
