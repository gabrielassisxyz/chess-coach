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

  it("carries the SDK's is_error flag on a tool result, and stores it only when set", () => {
    const result = (isError?: true) =>
      mapSdkMessage({
        type: "user",
        parent_tool_use_id: null,
        session_id: "s",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t9",
              content: [{ type: "text", text: "MCP error -32602: Invalid arguments" }],
              ...(isError ? { is_error: true } : {}),
            },
          ],
        },
      } as never);
    const failed = result(true);
    expect(failed.events).toEqual([
      {
        kind: "tool_result",
        toolUseId: "t9",
        output: [{ type: "text", text: "MCP error -32602: Invalid arguments" }],
        isError: true,
      },
    ]);
    expect(failed.finalized[0]?.content).toMatchObject({ toolUseId: "t9", isError: true });
    const fine = result();
    expect(fine.events[0]).toMatchObject({ kind: "tool_result", isError: false });
    expect(fine.finalized[0]?.content).not.toHaveProperty("isError");
  });

  it("turns an error result into turn_error", () => {
    const [result] = loadRecordedTurns()[0]?.slice(-1) ?? [];
    if (result?.type !== "result" || result.subtype !== "success") throw new Error("fixture shape");
    const failed = mapSdkMessage({ ...result, is_error: true, result: "rate limited" });
    expect(failed.events).toEqual([{ kind: "turn_error", message: "rate limited" }]);
  });
});
