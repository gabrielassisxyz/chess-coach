import type { ServerEvent } from "@chess-coach/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Chat } from "../src/components/Chat.js";
import { coachErrorHint } from "../src/state/coach-hint.js";
import { type ChatState, chatReducer, initialChatState } from "../src/state/transcript.js";
import { serverApi } from "./server-api.js";

afterEach(cleanup);

let seq = 0;
function chat(event: unknown): ServerEvent {
  seq += 1;
  return { type: "chat", tab: "play", message_id: 1, seq, event } as ServerEvent;
}

const delta = chat({ kind: "text_delta", text: "Hi" });
const toolUse = chat({ kind: "tool_use", tool_use_id: "t1", name: "look", input: {} });
const toolResult = chat({ kind: "tool_result", tool_use_id: "t1", output: "ok" });
const turnEnd = chat({ kind: "turn_end", usage: { input_tokens: 1, output_tokens: 1 } });
const turnError = chat({ kind: "turn_error", message: "boom" });

function fold(...events: ServerEvent[]): ChatState {
  return events.reduce(
    (state, event) => chatReducer(state, { type: "server", event }),
    initialChatState,
  );
}

describe("coach turn state", () => {
  it("starts idle", () => {
    expect(initialChatState.conversations.play.turn).toBe("idle");
  });

  it("is thinking from a tool call until its result, and still thinking after it", () => {
    expect(fold(toolUse).conversations.play.turn).toBe("thinking");
    expect(fold(toolUse, toolResult).conversations.play.turn).toBe("thinking");
  });

  it("is streaming while text deltas arrive", () => {
    expect(fold(toolUse, toolResult, delta).conversations.play.turn).toBe("streaming");
  });

  it("returns to idle on turn_end and on turn_error", () => {
    expect(fold(toolUse, delta, turnEnd).conversations.play.turn).toBe("idle");
    expect(fold(toolUse, turnError).conversations.play.turn).toBe("idle");
  });

  it("is thinking as soon as the student sends a message", () => {
    const sent = chatReducer(initialChatState, { type: "local_say", text: "hello", tab: "play" });
    expect(sent.conversations.play.turn).toBe("thinking");
  });

  it("goes back to idle on a bootstrap, which is the truth after a reconnect", () => {
    const streaming = fold(delta);
    const after = chatReducer(streaming, {
      type: "server",
      event: {
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
      },
    });
    expect(after.conversations.play.turn).toBe("idle");
  });
});

describe("chat header", () => {
  it("words the turn state in the panel header", () => {
    const { rerender } = render(<Chat server={serverApi(null, { turn: "idle" })} />);
    const state = () => screen.getByRole("status").textContent;
    expect(state()).toBe("watching the board");
    rerender(<Chat server={serverApi(null, { turn: "thinking" })} />);
    expect(state()).toBe("thinking");
    rerender(<Chat server={serverApi(null, { turn: "streaming" })} />);
    expect(state()).toBe("writing");
  });

  it("says offline while reconnecting, when the turn cannot be known", () => {
    render(<Chat server={serverApi(null, { connection: "reconnecting", turn: "thinking" })} />);
    expect(screen.getByRole("status").textContent).toBe("offline · reconnecting");
  });
});

describe("turn_error hints", () => {
  it.each([
    "Not logged in. Please run /login",
    "authentication_failed",
    "Claude Code process exited with code 1",
    "the SDK stream closed",
  ])("suggests a fix for %s", (message) => {
    expect(coachErrorHint(message)).not.toBeNull();
  });

  it("points at /login for an auth failure and at a terminal for a process failure", () => {
    expect(coachErrorHint("Not logged in")).toContain("/login");
    expect(coachErrorHint("Claude Code process exited with code 1")).toContain("send your message");
  });

  it("stays silent for an error it has no fix for", () => {
    expect(coachErrorHint("quota hit")).toBeNull();
  });

  it("renders the hint under the message in the chat", () => {
    render(
      <Chat
        server={serverApi(null, {
          items: [{ type: "turn_error", key: "e", message: "Not logged in. Please run /login" }],
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Not logged in");
    expect(screen.getByTestId("error-hint").textContent).toContain("restart the server");
  });

  it("renders no hint element for an error without a known fix", () => {
    render(
      <Chat
        server={serverApi(null, {
          items: [{ type: "turn_error", key: "e", message: "quota hit" }],
        })}
      />,
    );
    expect(screen.queryByTestId("error-hint")).toBeNull();
  });
});
