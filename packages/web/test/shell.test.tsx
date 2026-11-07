import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { COACH_OPEN_STORAGE_KEY } from "../src/state/coach-panel.js";
import { FakeSocket } from "./fake-socket.js";
import { liveGame } from "./fixtures.js";

const layoutCss = readFileSync(join(import.meta.dirname, "../src/styles/layout.css"), "utf8");

beforeEach(() => {
  FakeSocket.reset();
  window.localStorage.clear();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "ok", version: "0.0.0", ready: true })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function connect(): void {
  act(() => FakeSocket.latest.open());
  act(() =>
    FakeSocket.latest.receive({
      type: "bootstrap",
      conversations: { play: [], games: [], practice: [] },
      activity: liveGame(),
    }),
  );
}

let seq = 0;
function coachSays(text: string): void {
  seq += 1;
  act(() =>
    FakeSocket.latest.receive({
      type: "chat",
      tab: "play",
      message_id: seq,
      seq,
      event: { kind: "text_delta", text },
    }),
  );
}

function coachEvent(event: unknown): void {
  seq += 1;
  act(() => FakeSocket.latest.receive({ type: "chat", tab: "play", message_id: 1, seq, event }));
}

const state = (): string | null =>
  within(screen.getByRole("complementary", { name: "Coach" })).getByRole("status").textContent;
const collapse = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Collapse coach panel" }));
};

describe("top bar", () => {
  it("names the tabs Play, Games and Practice and disables Routine with a soon tag", () => {
    render(<App />);
    connect();
    const tabs = within(screen.getByRole("navigation", { name: "Screens" }));
    expect(tabs.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Play",
      "Games",
      "Practice",
      "Routinesoon",
    ]);
    const routine = tabs.getByRole("button", { name: /Routine/ }) as HTMLButtonElement;
    expect(routine.disabled).toBe(true);
    expect(routine.textContent).toContain("soon");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("chess-coach");
  });

  it("opens every screen inside the frame next to the coach", () => {
    render(<App />);
    connect();
    for (const name of ["Games", "Practice", "Play"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.getByRole("region", { name })).toBeTruthy();
      expect(screen.getByRole("complementary", { name: "Coach" })).toBeTruthy();
    }
  });
});

describe("status chip", () => {
  it("is absent while connected and while the first connection is still being made", () => {
    render(<App />);
    expect(screen.queryByTestId("status-chip")).toBeNull();
    connect();
    expect(screen.queryByTestId("status-chip")).toBeNull();
  });

  it("counts the reconnect attempts while the socket is down", () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      connect();
      act(() => FakeSocket.latest.drop());
      expect(screen.getByTestId("status-chip").textContent).toBe(
        "Connection lost · reconnecting (1st try)",
      );
      act(() => vi.advanceTimersByTime(500));
      act(() => FakeSocket.latest.drop());
      expect(screen.getByTestId("status-chip").textContent).toContain("(2nd try)");
      act(() => vi.advanceTimersByTime(1000));
      act(() => FakeSocket.latest.drop());
      expect(screen.getByTestId("status-chip").textContent).toContain("(3rd try)");
      act(() => vi.advanceTimersByTime(2000));
      act(() => FakeSocket.latest.open());
      expect(screen.queryByTestId("status-chip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the engine was not found when health reports stockfish_missing", async () => {
    const fetchHealth = async () => ({
      status: "ok" as const,
      version: "0.0.0",
      ready: false,
      reason: "stockfish_missing" as const,
    });
    render(<App fetchHealth={fetchHealth} />);
    connect();
    expect((await screen.findByTestId("status-chip")).textContent).toBe("Engine not found");
  });
});

describe("coach panel", () => {
  it("collapses to a strip, expands from it, and remembers the choice", () => {
    const view = render(<App />);
    connect();
    expect(document.querySelector(".frame")?.getAttribute("data-coach")).toBe("open");
    collapse();
    expect(document.querySelector(".frame")?.getAttribute("data-coach")).toBe("collapsed");
    expect(screen.queryByLabelText("Message to the coach")).toBeNull();
    expect(window.localStorage.getItem(COACH_OPEN_STORAGE_KEY)).toBe("false");

    view.unmount();
    FakeSocket.reset();
    render(<App />);
    expect(document.querySelector(".frame")?.getAttribute("data-coach")).toBe("collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Expand coach panel" }));
    expect(screen.getByLabelText("Message to the coach")).toBeTruthy();
    expect(window.localStorage.getItem(COACH_OPEN_STORAGE_KEY)).toBe("true");
  });

  it("keeps the draft through a collapse", () => {
    render(<App />);
    connect();
    fireEvent.change(screen.getByLabelText("Message to the coach"), { target: { value: "hm" } });
    collapse();
    fireEvent.click(screen.getByRole("button", { name: "Expand coach panel" }));
    expect((screen.getByLabelText("Message to the coach") as HTMLTextAreaElement).value).toBe("hm");
  });

  it("sets an unread dot when the coach speaks while closed and clears it on opening", () => {
    render(<App />);
    connect();
    collapse();
    expect(screen.queryByTestId("coach-unread")).toBeNull();
    coachSays("Nice move.");
    expect(screen.getByTestId("coach-unread")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Expand coach panel/ }));
    expect(screen.queryByTestId("coach-unread")).toBeNull();
    collapse();
    expect(screen.queryByTestId("coach-unread")).toBeNull();
  });

  it("does not mark a message that arrives while the panel is open", () => {
    render(<App />);
    connect();
    coachSays("Hello.");
    collapse();
    expect(screen.queryByTestId("coach-unread")).toBeNull();
  });

  it("does not mark the transcript replayed by a reconnect", () => {
    render(<App />);
    connect();
    coachSays("One.");
    collapse();
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: {
          play: [
            {
              id: 1,
              seq: 1,
              role: "assistant",
              kind: "text",
              content: { text: "One." },
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          games: [],
          practice: [],
        },
        activity: liveGame(),
      }),
    );
    expect(screen.queryByTestId("coach-unread")).toBeNull();
  });
});

describe("panel header wording", () => {
  it("follows the coach's state", () => {
    render(<App />);
    connect();
    expect(state()).toBe("watching the board");
    coachEvent({ kind: "tool_use", tool_use_id: "t1", name: "look", input: {} });
    expect(state()).toBe("thinking");
    coachSays("Hm.");
    expect(state()).toBe("writing");
    coachEvent({ kind: "turn_end", usage: { input_tokens: 1, output_tokens: 1 } });
    expect(state()).toBe("watching the board");
    act(() =>
      FakeSocket.latest.receive({
        type: "permission_request",
        request_id: "r1",
        tool_name: "Bash",
        input: {},
      }),
    );
    expect(state()).toBe("waiting for you");
    act(() => FakeSocket.latest.drop());
    expect(state()).toBe("offline · reconnecting");
  });
});

describe("frame styles", () => {
  it("fixes the coach column at 360px open and 32px collapsed", () => {
    expect(layoutCss).toMatch(/--left-column: 220px;/);
    expect(layoutCss).toMatch(
      /grid-template-columns: var\(--left-column\) minmax\(0, 1fr\) 360px;/,
    );
    expect(layoutCss).toMatch(
      /\.frame\[data-coach="collapsed"\] \{\s*grid-template-columns: var\(--left-column\) minmax\(0, 1fr\) 32px;/,
    );
  });
});
