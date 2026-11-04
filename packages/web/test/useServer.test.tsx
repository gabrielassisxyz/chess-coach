import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServer } from "../src/hooks/useServer.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";

const delta = (seq: number, messageId: number, text: string) => ({
  type: "chat",
  message_id: messageId,
  seq,
  event: { kind: "text_delta", text },
});

function mount() {
  return renderHook(() => useServer({ url: "ws://test/api/ws", createSocket: createFakeSocket }));
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useServer", () => {
  it("merges deltas of one message into a single assistant item", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() => FakeSocket.latest.receive({ type: "bootstrap", transcript: [] }));
    act(() => FakeSocket.latest.receive(delta(1, 1, "Hel")));
    act(() => FakeSocket.latest.receive(delta(2, 1, "lo")));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({ role: "assistant", text: "Hello" });
    act(() => FakeSocket.latest.receive(delta(3, 2, "Next")));
    expect(result.current.items).toHaveLength(2);
  });

  it("applies the bootstrap transcript and folds a tool result under its call", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        transcript: [
          { id: 1, seq: 1, role: "user", kind: "text", content: { text: "hi" }, created_at: "t" },
          {
            id: 2,
            seq: 2,
            role: "assistant",
            kind: "tool_use",
            content: { toolUseId: "t1", name: "look", input: { a: 1 } },
            created_at: "t",
          },
          {
            id: 3,
            seq: 3,
            role: "user",
            kind: "tool_result",
            content: { toolUseId: "t1", output: "done" },
            created_at: "t",
          },
        ],
      }),
    );
    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[1]).toMatchObject({ type: "tool", result: { output: "done" } });
  });

  it("resets transcript and approvals on reconnect and resends nothing", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() => FakeSocket.latest.receive({ type: "bootstrap", transcript: [] }));
    act(() => FakeSocket.latest.receive(delta(1, 1, "partial")));
    act(() =>
      FakeSocket.latest.receive({
        type: "permission_request",
        request_id: "r1",
        tool_name: "Bash",
        input: {},
      }),
    );
    expect(result.current.permissions).toHaveLength(1);
    const first = FakeSocket.latest;

    act(() => first.drop());
    expect(result.current.connection).toBe("reconnecting");
    expect(result.current.say("typed while offline")).toBe(false);
    act(() => vi.advanceTimersByTime(500));
    const second = FakeSocket.latest;
    expect(second).not.toBe(first);
    act(() => second.open());
    act(() => second.receive({ type: "bootstrap", transcript: [] }));

    expect(result.current.connection).toBe("connected");
    expect(result.current.items).toEqual([]);
    expect(result.current.permissions).toEqual([]);
    expect(second.sent).toEqual([]);
  });

  it("backs off from 500 ms doubling up to 10 s and resets after a successful open", () => {
    mount();
    const attempts = () => FakeSocket.instances.length;
    act(() => FakeSocket.latest.drop());
    act(() => vi.advanceTimersByTime(499));
    expect(attempts()).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(attempts()).toBe(2);
    act(() => FakeSocket.latest.drop());
    act(() => vi.advanceTimersByTime(999));
    expect(attempts()).toBe(2);
    act(() => vi.advanceTimersByTime(1));
    expect(attempts()).toBe(3);
    for (let i = 0; i < 6; i++) {
      act(() => FakeSocket.latest.drop());
      act(() => vi.advanceTimersByTime(10_000));
    }
    const before = attempts();
    act(() => FakeSocket.latest.drop());
    act(() => vi.advanceTimersByTime(9_999));
    expect(attempts()).toBe(before);
    act(() => vi.advanceTimersByTime(1));
    expect(attempts()).toBe(before + 1);
    act(() => FakeSocket.latest.open());
    act(() => FakeSocket.latest.drop());
    act(() => vi.advanceTimersByTime(500));
    expect(attempts()).toBe(before + 2);
  });

  it("sends say with a command_id and shows the echo locally", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() => FakeSocket.latest.receive({ type: "bootstrap", transcript: [] }));
    let sent = false;
    act(() => {
      sent = result.current.say("hello");
    });
    expect(sent).toBe(true);
    expect(FakeSocket.latest.sent).toEqual([{ type: "say", command_id: "c1", text: "hello" }]);
    expect(result.current.items[0]).toMatchObject({ role: "user", text: "hello" });
  });

  it("surfaces a typed server error and drops a malformed frame", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() => FakeSocket.latest.receive({ type: "error", code: "coach_error", message: "boom" }));
    expect(result.current.lastError).toBe("boom");
    act(() => FakeSocket.latest.receive({ type: "chat", nonsense: true }));
    expect(result.current.lastError).toBe("received a malformed server frame");
  });
});
