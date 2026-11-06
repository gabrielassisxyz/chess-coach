import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/coach/session.js";
import { loadRecordedTurns } from "./fake-sdk.js";

// A fake SDK whose every answer waits for the test, across as many streams as the session
// launches, and which counts how many messages are being answered at the same moment.
export class GatedSdk {
  readonly calls: { options: Options }[] = [];
  readonly userTexts: string[] = [];
  maxConcurrentTurns = 0;
  private answering = 0;
  private readonly releases: (() => void)[] = [];
  private readonly answer: SDKMessage[] = loadRecordedTurns()[0] ?? [];

  readonly query: QueryFn = ({ prompt, options }) => {
    this.calls.push({ options });
    return this.replay(prompt);
  };

  /** Lets the oldest message still waiting be answered. */
  release(): void {
    this.releases.shift()?.();
  }

  get waiting(): number {
    return this.releases.length;
  }

  private replay(prompt: AsyncIterable<SDKUserMessage>): AsyncIterable<SDKMessage> {
    const self = this;
    async function* run(): AsyncGenerator<SDKMessage, void> {
      for await (const user of prompt) {
        self.userTexts.push(String(user.message.content));
        self.answering += 1;
        self.maxConcurrentTurns = Math.max(self.maxConcurrentTurns, self.answering);
        await new Promise<void>((resolve) => self.releases.push(resolve));
        self.answering -= 1;
        for (const message of self.answer) yield message;
      }
    }
    return run();
  }
}
