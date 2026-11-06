import type { Log, LogFields } from "../log.js";
import type { CoachEvent } from "./events.js";

// A message handed to the SDK, open until a result names its uuid. The SDK may answer several
// queued messages with one result; without uuids in the result, the oldest open one is assumed.
export interface QueuedTurn {
  turn: number;
  uuid: string;
  queuedAt: number;
}

interface OpenToolCall {
  name: string;
  startedAt: number;
}

// Shared by every tab's ledger: one turn runs at a time across tabs, so a turn waits behind the
// previous answer whichever tab gave it.
export interface TurnTiming {
  lastTurnEndedAt: number;
}

// A refusal from the coach's own tools is JSON carrying `error`; its code is what a reader wants.
function refusalCode(output: unknown): string | null {
  const text = Array.isArray(output)
    ? output.map((block) => (block as { text?: unknown } | null)?.text ?? "").join("")
    : output;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown } | null;
    return typeof parsed?.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

/** The turns one SDK stream has been handed and not yet answered, and the log lines they produce. */
export class CoachTurnLedger {
  private readonly queued: QueuedTurn[] = [];
  private readonly openTools = new Map<string, OpenToolCall>();
  // Once a result has named the messages it answered, one that names none is the SDK's own turn.
  private resultsNameMessages = false;

  constructor(
    private readonly log: Log,
    private readonly timing: TurnTiming,
  ) {}

  get openTurns(): number {
    return this.queued.length;
  }

  get oldestTurn(): number | undefined {
    return this.queued[0]?.turn;
  }

  get turnNumbers(): number[] {
    return this.queued.map((queued) => queued.turn);
  }

  open(turn: QueuedTurn): void {
    this.queued.push(turn);
  }

  // Messages queued on a stream that ended will never be answered by the next one.
  reset(): void {
    this.queued.length = 0;
    this.openTools.clear();
  }

  record(event: CoachEvent, base: LogFields, fallbackTurn: number): void {
    const turn = { ...base, turn: this.oldestTurn ?? fallbackTurn };
    if (event.kind === "tool_use") {
      this.openTools.set(event.toolUseId, { name: event.name, startedAt: performance.now() });
      this.log.info("coach.tool_call", {
        ...turn,
        tool_use_id: event.toolUseId,
        name: event.name,
        input: event.input,
      });
    } else if (event.kind === "tool_result") {
      const call = this.openTools.get(event.toolUseId);
      this.openTools.delete(event.toolUseId);
      const code = refusalCode(event.output);
      this.log.info("coach.tool_result", {
        ...turn,
        tool_use_id: event.toolUseId,
        name: call?.name ?? null,
        duration_ms: call ? Math.round(performance.now() - call.startedAt) : null,
        is_error: event.isError || code !== null,
        error_code: code,
        output: event.output,
      });
    } else if (event.kind === "turn_end" || event.kind === "turn_error") {
      this.closeTurn(turn, event);
    }
  }

  // A turn runs from when its first message was queued or when the turn before it ended, whichever
  // is later. A result that names no message this session sent (an SDK-internal turn) closes none.
  private closeTurn(
    base: LogFields,
    event: Extract<CoachEvent, { kind: "turn_end" | "turn_error" }>,
  ): void {
    const now = performance.now();
    const closed = this.takeAnswered(event.answered);
    const first = closed[0];
    const startedAt = first ? Math.max(first.queuedAt, this.timing.lastTurnEndedAt) : null;
    const turn = { ...base, turn: first?.turn ?? null, turns: closed.map((open) => open.turn) };
    const timing = {
      duration_ms: startedAt === null ? null : Math.round(now - startedAt),
      waited_ms: first && startedAt !== null ? Math.round(startedAt - first.queuedAt) : null,
    };
    this.timing.lastTurnEndedAt = now;
    if (event.kind === "turn_error") {
      this.log.warn("coach.turn_failed", { ...turn, ...timing, message: event.message });
      return;
    }
    this.log.info("coach.turn_end", {
      ...turn,
      ...timing,
      input_tokens: event.usage.inputTokens,
      output_tokens: event.usage.outputTokens,
    });
  }

  private takeAnswered(answered: string[] | undefined): QueuedTurn[] {
    if (!answered || answered.length === 0) {
      if (this.resultsNameMessages) return [];
      const oldest = this.queued.shift();
      return oldest ? [oldest] : [];
    }
    this.resultsNameMessages = true;
    const closed = this.queued.filter((open) => answered.includes(open.uuid));
    const left = this.queued.filter((open) => !answered.includes(open.uuid));
    this.queued.splice(0, this.queued.length, ...left);
    return closed;
  }
}
