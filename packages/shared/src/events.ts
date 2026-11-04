import { z } from "zod";

// The wire contract between server and browser. Every frame is validated on arrival by the side
// that receives it; a schema sits beside each type so the two cannot drift apart.

export const MAX_SAY_LENGTH = 4000;

const commandId = z.string().min(1).max(64);

export const ChatPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text_delta"), text: z.string() }),
  z.object({
    kind: z.literal("tool_use"),
    tool_use_id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({ kind: z.literal("tool_result"), tool_use_id: z.string(), output: z.unknown() }),
  z.object({
    kind: z.literal("turn_end"),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
  }),
  z.object({ kind: z.literal("turn_error"), message: z.string() }),
]);
export type ChatPayload = z.infer<typeof ChatPayloadSchema>;

// One persisted row of the open session. `content` is the row's JSON, parsed by the server.
export const TranscriptEntrySchema = z.object({
  id: z.number(),
  seq: z.number(),
  role: z.enum(["user", "assistant", "system"]),
  kind: z.enum(["text", "tool_use", "tool_result", "notification", "incomplete"]),
  content: z.unknown(),
  created_at: z.string(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const BootstrapEventSchema = z.object({
  type: z.literal("bootstrap"),
  transcript: z.array(TranscriptEntrySchema),
});
export type BootstrapEvent = z.infer<typeof BootstrapEventSchema>;

// message_id groups the deltas of one assistant message; seq orders every chat event of a server run.
export const ChatEventSchema = z.object({
  type: z.literal("chat"),
  message_id: z.number().int(),
  seq: z.number().int(),
  event: ChatPayloadSchema,
});
export type ChatEvent = z.infer<typeof ChatEventSchema>;

export const PermissionRequestEventSchema = z.object({
  type: z.literal("permission_request"),
  request_id: z.string(),
  tool_name: z.string(),
  input: z.unknown(),
});
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEventSchema>;

export const ErrorCodeSchema = z.enum([
  "invalid_json",
  "invalid_command",
  "unknown_request",
  "coach_error",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  code: ErrorCodeSchema,
  message: z.string(),
  command_id: commandId.optional(),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  BootstrapEventSchema,
  ChatEventSchema,
  PermissionRequestEventSchema,
  ErrorEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export const SayCommandSchema = z.object({
  type: z.literal("say"),
  command_id: commandId,
  text: z.string().min(1).max(MAX_SAY_LENGTH),
});
export type SayCommand = z.infer<typeof SayCommandSchema>;

export const ApproveToolCommandSchema = z.object({
  type: z.literal("approve_tool"),
  command_id: commandId,
  request_id: z.string(),
  allow: z.boolean(),
});
export type ApproveToolCommand = z.infer<typeof ApproveToolCommandSchema>;

export const ClientCommandSchema = z.discriminatedUnion("type", [
  SayCommandSchema,
  ApproveToolCommandSchema,
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;
