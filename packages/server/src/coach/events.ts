import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type BetaRawMessageStreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
}

export type CoachEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use"; toolUseId: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; output: unknown; isError: boolean }
  | { kind: "turn_end"; usage: TurnUsage; answered?: string[] }
  | { kind: "turn_error"; message: string; answered?: string[] };

// A finalized item is what the transcript stores: one per completed block, never per delta.
export interface FinalizedItem {
  role: "assistant" | "user";
  kind: "text" | "tool_use" | "tool_result";
  content: unknown;
}

export interface SessionInit {
  sessionId: string;
  model: string;
  tools: string[];
  apiKeySource: string;
}

export interface MappedMessage {
  events: CoachEvent[];
  finalized: FinalizedItem[];
  init?: SessionInit;
}

const EMPTY: MappedMessage = { events: [], finalized: [] };

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

function blocksOf(message: { content?: unknown }): ContentBlock[] {
  return Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
}

function mapAssistant(blocks: ContentBlock[]): MappedMessage {
  const out: MappedMessage = { events: [], finalized: [] };
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
      out.finalized.push({ role: "assistant", kind: "text", content: { text: block.text } });
    }
    if (block.type === "tool_use") {
      const content = { toolUseId: String(block.id), name: String(block.name), input: block.input };
      out.events.push({ kind: "tool_use", ...content });
      out.finalized.push({ role: "assistant", kind: "tool_use", content });
    }
  }
  return out;
}

function mapToolResults(blocks: ContentBlock[]): MappedMessage {
  const out: MappedMessage = { events: [], finalized: [] };
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    // A failed call is only marked by the SDK's flag: a successful result can be plain text too.
    const isError = block.is_error === true;
    const base = { toolUseId: String(block.tool_use_id), output: block.content };
    out.events.push({ kind: "tool_result", ...base, isError });
    const content = isError ? { ...base, isError: true } : base;
    out.finalized.push({ role: "user", kind: "tool_result", content });
  }
  return out;
}

function mapStreamEvent(event: BetaRawMessageStreamEvent): MappedMessage {
  if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") return EMPTY;
  return { events: [{ kind: "text_delta", text: event.delta.text }], finalized: [] };
}

// The uuids of the messages a result answered; several when the SDK ran them as one turn.
function answeredBy(message: { user_message_uuid?: string; user_message_uuids?: string[] }) {
  if (message.user_message_uuids && message.user_message_uuids.length > 0) {
    return { answered: message.user_message_uuids };
  }
  return message.user_message_uuid ? { answered: [message.user_message_uuid] } : {};
}

function mapResult(message: Extract<SDKMessage, { type: "result" }>): MappedMessage {
  const answered = answeredBy(message);
  if (message.subtype === "success" && !message.is_error) {
    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
    return { events: [{ kind: "turn_end", usage, ...answered }], finalized: [] };
  }
  const detail =
    message.subtype === "success" ? message.result : message.errors.join("; ") || message.subtype;
  return { events: [{ kind: "turn_error", message: detail, ...answered }], finalized: [] };
}

// Sub-agent traffic (parent_tool_use_id set) never reaches the student; the coach has no sub-agents.
export function mapSdkMessage(message: SDKMessage): MappedMessage {
  switch (message.type) {
    case "system":
      if (message.subtype !== "init") return EMPTY;
      return {
        events: [],
        finalized: [],
        init: {
          sessionId: message.session_id,
          model: message.model,
          tools: message.tools,
          apiKeySource: message.apiKeySource,
        },
      };
    case "stream_event":
      return message.parent_tool_use_id === null ? mapStreamEvent(message.event) : EMPTY;
    case "assistant":
      return message.parent_tool_use_id === null ? mapAssistant(blocksOf(message.message)) : EMPTY;
    case "user":
      return message.parent_tool_use_id === null
        ? mapToolResults(blocksOf(message.message))
        : EMPTY;
    case "result":
      return mapResult(message);
    default:
      return EMPTY;
  }
}
