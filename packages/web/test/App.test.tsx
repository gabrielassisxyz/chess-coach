import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { chatReducer, initialChatState } from "../src/state/transcript.js";
import { FakeSocket } from "./fake-socket.js";
import { liveGame } from "./fixtures.js";

// The stylesheet is read as text because vitest does not process CSS imports.
const layoutCss = readFileSync(join(import.meta.dirname, "../src/styles/layout.css"), "utf8");

interface HappyWindow {
  happyDOM: { setViewport(size: { width: number; height: number }): void };
}

beforeEach(() => {
  FakeSocket.reset();
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
  act(() => FakeSocket.latest.receive({ type: "bootstrap", transcript: [], activity: liveGame() }));
}

describe("App", () => {
  it("switches screens from the top bar and keeps the chat beside every one", () => {
    render(<App />);
    connect();
    const tab = (name: string) => screen.getByRole("button", { name });
    expect(tab("Play").getAttribute("aria-current")).toBe("page");
    fireEvent.click(tab("Games"));
    expect(screen.getByRole("region", { name: "Games" })).toBeTruthy();
    expect(screen.getByLabelText("Message to the coach")).toBeTruthy();
    fireEvent.click(tab("Practice"));
    expect(screen.getByRole("button", { name: "Review due cards" })).toBeTruthy();
  });

  it("shows a server error as a dismissible notice and keeps the connection in the chat", () => {
    render(<App />);
    connect();
    expect(screen.getByRole("status").textContent).toBe("watching the board");
    act(() =>
      FakeSocket.latest.receive({ type: "error", code: "illegal_move", message: "not legal" }),
    );
    expect(screen.getByRole("alert").textContent).toContain("not legal");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reduces a repeated error to a new errorCount so the board can resync", () => {
    const error = { type: "error", code: "illegal_move", message: "same" } as const;
    const once = chatReducer(initialChatState, { type: "server", event: error });
    const twice = chatReducer(once, { type: "server", event: error });
    expect(twice.errorCount).toBe(2);
    expect(chatReducer(twice, { type: "dismiss_error" }).lastError).toBeNull();
  });
});

describe("layout", () => {
  function frameStyle(width: number): CSSStyleDeclaration {
    (window as unknown as HappyWindow).happyDOM.setViewport({ width, height: 900 });
    const style = document.createElement("style");
    style.textContent = layoutCss;
    document.head.append(style);
    const grid = document.createElement("main");
    grid.className = "frame";
    document.body.append(grid);
    const computed = getComputedStyle(grid);
    const snapshot = {
      gridTemplateColumns: computed.gridTemplateColumns,
      display: computed.display,
      flexDirection: computed.flexDirection,
    } as CSSStyleDeclaration;
    style.remove();
    grid.remove();
    return snapshot;
  }
  const columns = (width: number): string => frameStyle(width).gridTemplateColumns;

  it("puts the left column, the board and the coach side by side at 1280px", () => {
    expect(columns(1280)).toBe("220px minmax(0, 1fr) 360px");
  });

  it("stacks everything in one column at 800px", () => {
    const frame = frameStyle(800);
    expect(frame.display).toBe("flex");
    expect(frame.flexDirection).toBe("column");
  });
});
