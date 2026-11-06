import { ChatEventSchema } from "@chess-coach/shared";
import { describe, expect, it } from "vitest";
import { ChatEventNumbering } from "../../src/ws/chat-events.js";

describe("ChatEventNumbering", () => {
  it("puts is_error on the wire only for a failed tool result", () => {
    const numbering = new ChatEventNumbering();
    const failed = numbering.next(
      {
        kind: "tool_result",
        toolUseId: "t1",
        output: "x",
        isError: true,
      },
      "play",
    );
    const fine = numbering.next(
      {
        kind: "tool_result",
        toolUseId: "t2",
        output: "y",
        isError: false,
      },
      "play",
    );
    expect(failed.event).toEqual({
      kind: "tool_result",
      tool_use_id: "t1",
      output: "x",
      is_error: true,
    });
    expect(fine.event).toEqual({ kind: "tool_result", tool_use_id: "t2", output: "y" });
    // The browser parses frames with this schema, and zod drops keys it does not declare.
    const parsed = ChatEventSchema.parse(failed);
    expect(parsed.event).toMatchObject({ kind: "tool_result", is_error: true });
  });
});
