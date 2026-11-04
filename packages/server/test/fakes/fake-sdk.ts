import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CoachQuery, QueryFn } from "../../src/coach/session.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sdk-stream.jsonl");

// Splits the recorded stream at each result message: one entry per turn.
export function loadRecordedTurns(): SDKMessage[][] {
  const messages = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SDKMessage);
  const turns: SDKMessage[][] = [];
  let current: SDKMessage[] = [];
  for (const message of messages) {
    current.push(message);
    if (message.type === "result") {
      turns.push(current);
      current = [];
    }
  }
  return turns;
}

export interface FakeSdkOptions {
  turns?: SDKMessage[][];
  failBeforeInit?: Error;
  // Ends the first turn with this error after `messages` messages, the way an exited CLI process does.
  failMidTurn?: { messages: number; error: Error };
}

// Replays one recorded turn per user message it is fed, like the real streaming-input query.
export class FakeSdk {
  readonly calls: { options: Options }[] = [];
  readonly userTexts: string[] = [];
  private readonly turns: SDKMessage[][];
  private readonly failBeforeInit: Error | undefined;
  private midTurnFailure: FakeSdkOptions["failMidTurn"];

  constructor(options: FakeSdkOptions = {}) {
    this.turns = options.turns ?? loadRecordedTurns();
    this.failBeforeInit = options.failBeforeInit;
    this.midTurnFailure = options.failMidTurn;
  }

  readonly query: QueryFn = ({ prompt, options }) => {
    this.calls.push({ options });
    return this.replay(prompt);
  };

  private replay(prompt: AsyncIterable<SDKUserMessage>): CoachQuery {
    const turns = this.turns;
    const userTexts = this.userTexts;
    const failure = this.failBeforeInit;
    const midTurn = this.midTurnFailure;
    this.midTurnFailure = undefined;
    async function* run(): AsyncGenerator<SDKMessage, void> {
      if (failure) throw failure;
      let index = 0;
      for await (const user of prompt) {
        userTexts.push(String(user.message.content));
        const turn = turns[index] ?? [];
        if (midTurn) {
          yield* turn.slice(0, midTurn.messages);
          throw midTurn.error;
        }
        for (const message of turn) yield message;
        index += 1;
      }
    }
    return run();
  }
}
