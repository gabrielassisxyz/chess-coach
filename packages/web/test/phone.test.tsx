import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { Chat } from "../src/components/Chat.js";
import { COACH_OPEN_STORAGE_KEY, PHONE_QUERY } from "../src/state/coach-panel.js";
import { FakeSocket } from "./fake-socket.js";
import { liveGame } from "./fixtures.js";
import { serverApi } from "./server-api.js";

const STYLES = join(import.meta.dirname, "../src/styles");

beforeEach(() => {
  FakeSocket.reset();
  window.localStorage.clear();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "ok", version: "0.0.0", ready: true })),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: query === PHONE_QUERY, media: query })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

describe("coach bar on a phone", () => {
  it("shows the latest coach line and opens the sheet when tapped", () => {
    render(<App />);
    connect();
    coachSays("Look at c2 again.");
    const bar = screen.getByTestId("coach-bar-line");
    expect(bar.textContent).toBe("Look at c2 again.");
    expect(screen.queryByRole("button", { name: "Collapse coach panel" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Expand coach panel/ }));
    const sheet = screen.getByRole("complementary", { name: "Coach" });
    expect(within(sheet).getByText("Look at c2 again.")).toBeTruthy();
    expect(within(sheet).getByLabelText("Message to the coach")).toBeTruthy();
    expect(screen.queryByTestId("coach-bar-line")).toBeNull();
  });

  it("starts as a bar whatever the desktop panel was left as, and never overwrites that choice", () => {
    window.localStorage.setItem(COACH_OPEN_STORAGE_KEY, "true");
    render(<App />);
    connect();
    expect(screen.getByTestId("coach-bar-line")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Expand coach panel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse coach panel" }));
    expect(screen.getByTestId("coach-bar-line")).toBeTruthy();
    expect(window.localStorage.getItem(COACH_OPEN_STORAGE_KEY)).toBe("true");
  });

  it("marks the bar unread when the coach speaks while it is closed, until it is opened", () => {
    render(<App />);
    connect();
    coachSays("First.");
    expect(screen.getByTestId("coach-unread")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Expand coach panel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse coach panel" }));
    expect(screen.queryByTestId("coach-unread")).toBeNull();
  });

  it("falls back to the idle words while the coach has said nothing", () => {
    render(<Chat server={serverApi()} open={false} idleLabel="looking at move 4" />);
    expect(screen.getByTestId("coach-bar-line").textContent).toBe("looking at move 4");
  });

  it("keeps only the coach's words, not the student's, on the bar", () => {
    render(
      <Chat
        server={serverApi(null, {
          items: [
            { type: "text", key: "a", role: "assistant", text: "Why a3?" },
            { type: "text", key: "b", role: "user", text: "to stop Nb4" },
          ],
        })}
        open={false}
      />,
    );
    expect(screen.getByTestId("coach-bar-line").textContent).toBe("Why a3?");
  });
});

describe("the phone breakpoint", () => {
  it("is the one the stylesheets stack at", () => {
    const px = PHONE_QUERY.match(/max-width: (\d+px)/)?.[1];
    for (const file of ["layout.css", "chat.css", "games.css", "play.css", "board.css"]) {
      const css = readFileSync(join(STYLES, file), "utf8");
      expect(css, file).toContain(`@media (max-width: ${px})`);
    }
  });

  it("gives the sheet half the height and the bar a 44 px target", () => {
    const css = readFileSync(join(STYLES, "chat.css"), "utf8");
    expect(css).toMatch(/\.chat \{[^}]*height: 50dvh/);
    expect(css).toMatch(/\.coach__strip \{[^}]*min-height: 44px/);
  });
});
