import type { ChatEvent, CoachTab } from "@chess-coach/shared";
import type { CoachEvent } from "../coach/events.js";

// Deltas are not persisted, so the wire needs its own message identity: consecutive deltas share
// a message_id and everything else opens a new one. seq counts every chat event of this run.
export class ChatEventNumbering {
  private seq = 0;
  private messageId = 0;
  private lastWasDelta = false;

  next(event: CoachEvent, tab: CoachTab): ChatEvent {
    const isDelta = event.kind === "text_delta";
    if (!(isDelta && this.lastWasDelta)) this.messageId += 1;
    this.lastWasDelta = isDelta;
    this.seq += 1;
    return {
      type: "chat",
      tab,
      message_id: this.messageId,
      seq: this.seq,
      event: toPayload(event),
    };
  }
}

function toPayload(event: CoachEvent): ChatEvent["event"] {
  switch (event.kind) {
    case "text_delta":
      return event;
    case "tool_use":
      return {
        kind: "tool_use",
        tool_use_id: event.toolUseId,
        name: event.name,
        input: event.input,
      };
    case "tool_result":
      return {
        kind: "tool_result",
        tool_use_id: event.toolUseId,
        output: event.output,
        ...(event.isError ? { is_error: true } : {}),
      };
    case "turn_end":
      return {
        kind: "turn_end",
        usage: { input_tokens: event.usage.inputTokens, output_tokens: event.usage.outputTokens },
      };
    case "turn_error":
      return event;
  }
}
