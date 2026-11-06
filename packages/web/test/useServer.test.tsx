import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServer } from "../src/hooks/useServer.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";

const delta = (seq: number, messageId: number, text: string) => ({
  type: "chat",
  tab: "play",
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

const demoState = (activityId: number, fen: string) => ({
  kind: "demo",
  activity_id: activityId,
  orientation: "white",
  fen,
  turn: "black",
  last_move: null,
  legal_moves: [],
  input_enabled: false,
  pending: "none",
  returns_to: null,
  moves_played: [],
});

describe("useServer", () => {
  it("keeps the latest activity from bootstrap and activity events", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: demoState(1, "8/8/8/8/8/8/8/K6k w - - 0 1"),
      }),
    );
    expect(result.current.activity).toMatchObject({ kind: "demo", activity_id: 1 });
    act(() => FakeSocket.latest.receive({ type: "activity", state: demoState(2, "x") }));
    expect(result.current.activity?.activity_id).toBe(2);
    act(() => FakeSocket.latest.receive({ type: "activity", state: null }));
    expect(result.current.activity).toBeNull();
  });

  it("takes the current Elo from the bootstrap and clears it when a bootstrap carries none", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
        current_elo: 700,
      }),
    );
    expect(result.current.currentElo).toBe(700);
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
      }),
    );
    expect(result.current.currentElo).toBeNull();
  });

  it("sends a board command with a command_id and drops a malformed one", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    let sent = false;
    act(() => {
      sent = result.current.send({ type: "move", from: "e2", to: "e4", activity_id: 3 });
    });
    expect(sent).toBe(true);
    expect(FakeSocket.latest.sent).toEqual([
      { type: "move", command_id: "c1", from: "e2", to: "e4", activity_id: 3 },
    ]);
    act(() => {
      sent = result.current.send({ type: "move", from: "z9", to: "e4" });
    });
    expect(sent).toBe(false);
    expect(FakeSocket.latest.sent).toHaveLength(1);
  });

  it("merges deltas of one message into a single assistant item", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
      }),
    );
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
        conversations: {
          play: [
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
          games: [],
          practice: [],
        },
        activity: null,
      }),
    );
    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[1]).toMatchObject({ type: "tool", result: { output: "done" } });
  });

  it("keeps a failed tool result marked, from the bootstrap and from the live stream", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: {
          play: [
            {
              id: 1,
              seq: 1,
              role: "assistant",
              kind: "tool_use",
              content: { toolUseId: "t1", name: "look", input: {} },
              created_at: "t",
            },
            {
              id: 2,
              seq: 2,
              role: "user",
              kind: "tool_result",
              content: { toolUseId: "t1", output: "boom", isError: true },
              created_at: "t",
            },
          ],
          games: [],
          practice: [],
        },
        activity: null,
      }),
    );
    expect(result.current.items[0]).toMatchObject({ result: { output: "boom", isError: true } });
    act(() =>
      FakeSocket.latest.receive({
        type: "chat",
        tab: "play",
        message_id: 9,
        seq: 9,
        event: { kind: "tool_use", tool_use_id: "t2", name: "look", input: {} },
      }),
    );
    act(() =>
      FakeSocket.latest.receive({
        type: "chat",
        tab: "play",
        message_id: 10,
        seq: 10,
        event: { kind: "tool_result", tool_use_id: "t2", output: "boom", is_error: true },
      }),
    );
    expect(result.current.items[1]).toMatchObject({ result: { output: "boom", isError: true } });
  });

  it("resets transcript and approvals on reconnect and resends nothing", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
      }),
    );
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
    act(() =>
      second.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
      }),
    );

    expect(result.current.connection).toBe("connected");
    expect(result.current.items).toEqual([]);
    expect(result.current.permissions).toEqual([]);
    expect(second.sent).toEqual([]);
  });

  it("settles the coach turn to idle when the socket drops mid-turn", () => {
    const { result } = mount();
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
      }),
    );
    act(() => FakeSocket.latest.receive(delta(1, 1, "partial")));
    expect(result.current.turn).toBe("streaming");

    act(() => FakeSocket.latest.drop());
    act(() => vi.advanceTimersByTime(500));
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
      }),
    );
    expect(result.current.turn).toBe("idle");
    expect(result.current.items).toEqual([]);
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
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
      }),
    );
    let sent = false;
    act(() => {
      sent = result.current.say("hello");
    });
    expect(sent).toBe(true);
    expect(FakeSocket.latest.sent).toEqual([
      { type: "say", command_id: "c1", tab: "play", text: "hello" },
    ]);
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

  describe("per-tab conversations", () => {
    const entry = (id: number, role: string, text: string) => ({
      id,
      seq: id,
      role,
      kind: "text",
      content: { text },
      created_at: "2026-01-01T00:00:00Z",
    });

    function mountOn(tab: "play" | "games" | "practice") {
      const view = renderHook(
        ({ visible }) =>
          useServer({ url: "ws://test/api/ws", createSocket: createFakeSocket, tab: visible }),
        { initialProps: { visible: tab } },
      );
      act(() => FakeSocket.latest.open());
      act(() =>
        FakeSocket.latest.receive({
          type: "bootstrap",
          conversations: {
            play: [entry(1, "user", "about my game")],
            games: [],
            practice: [entry(2, "assistant", "about the puzzle")],
          },
          activity: null,
        }),
      );
      return view;
    }

    it("shows the visible tab's conversation and follows the tab when it changes", () => {
      const { result, rerender } = mountOn("practice");
      expect(result.current.tab).toBe("practice");
      expect(result.current.items).toEqual([
        expect.objectContaining({ role: "assistant", text: "about the puzzle" }),
      ]);
      rerender({ visible: "play" });
      expect(result.current.items).toEqual([
        expect.objectContaining({ role: "user", text: "about my game" }),
      ]);
      rerender({ visible: "games" });
      expect(result.current.items).toEqual([]);
    });

    it("keeps a chat event in its own tab, says into the visible one, and asks for a fresh one", () => {
      const { result } = mountOn("games");
      act(() => FakeSocket.latest.receive({ ...delta(1, 1, "Puzzle reply"), tab: "practice" }));
      expect(result.current.items).toEqual([]);
      expect(result.current.conversations.practice.items.at(-1)).toMatchObject({
        text: "Puzzle reply",
      });
      expect(result.current.conversations.practice.coachMessages).toBe(1);
      expect(result.current.turn).toBe("idle");
      act(() => {
        result.current.say("why this move?");
        result.current.newConversation();
      });
      expect(FakeSocket.latest.sent).toEqual([
        { type: "say", command_id: "c1", tab: "games", text: "why this move?" },
        { type: "new_conversation", command_id: "c2", tab: "games" },
      ]);
      expect(result.current.conversations.games.items).toHaveLength(1);
    });

    it("empties only the named tab when the server starts a fresh conversation", () => {
      const { result } = mountOn("play");
      act(() => FakeSocket.latest.receive({ type: "conversation_started", tab: "play" }));
      expect(result.current.items).toEqual([]);
      expect(result.current.lastMessageAt).toBeNull();
      expect(result.current.conversations.practice.items).toHaveLength(1);
    });

    it("appends a divider row to its tab", () => {
      const { result } = mountOn("practice");
      act(() =>
        FakeSocket.latest.receive({
          type: "chat_row",
          tab: "practice",
          entry: {
            id: 7,
            seq: 2,
            role: "system",
            kind: "text",
            content: { label: "Puzzles", at: "2026-01-01T16:30:00Z" },
            created_at: "2026-01-01T16:30:00Z",
          },
        }),
      );
      expect(result.current.items.at(-1)).toEqual({
        type: "divider",
        key: "row-7",
        label: "Puzzles",
        at: "2026-01-01T16:30:00Z",
      });
      expect(result.current.conversations.play.items).toHaveLength(1);
    });

    it("dates the conversation by its newest bootstrap row", () => {
      const { result } = mountOn("play");
      expect(result.current.lastMessageAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
      expect(result.current.conversations.games.lastMessageAt).toBeNull();
    });
  });
});
