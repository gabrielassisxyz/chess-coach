import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { chatReducer, initialChatState } from "../src/state/transcript.js";
import { FakeSocket } from "./fake-socket.js";
import { COACH_GAME_SOURCE, liveGame, START_FEN } from "./fixtures.js";
import { foundPosition, foundResponse, openPracticePage, progressOf } from "./practice-fixtures.js";

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

function textRow(id: number, text: string) {
  return {
    id,
    seq: id,
    role: "assistant",
    kind: "text",
    content: { text },
    created_at: "2026-01-01T00:00:00Z",
  };
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

  it("does not show an aborted game on Play once a practice session is open", () => {
    render(<App />);
    connect();
    act(() => FakeSocket.latest.receive({ type: "activity", state: null }));
    act(() =>
      FakeSocket.latest.receive({
        type: "activity",
        state: {
          kind: "training",
          activity_id: 11,
          orientation: "white",
          fen: START_FEN,
          turn: "white",
          last_move: null,
          legal_moves: [],
          input_enabled: true,
          pending: "none",
          mode: "puzzles",
          item: {
            kind: "puzzle",
            puzzle_id: "p1",
            motif: "fork",
            difficulty: "easy",
            fen: START_FEN,
            cursor: 0,
            reply_uci: null,
            position_in_queue: 1,
            queue_length: 5,
          },
          status: "prompt",
          served_at: "2026-03-01T00:00:00.000Z",
          expected: null,
          exploring: { fen: START_FEN, line_san: [], trail: [] },
          tries: 0,
          last_try: null,
          gave_up: false,
          solution_line: null,
          suggested_grade: null,
          hint_square: null,
          summary: null,
        },
      }),
    );
    expect(screen.getByText("A practice session is open")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Moves" })).toBeNull();
  });

  it("shows each tab's own conversation in the chat panel", () => {
    render(<App />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: {
          play: [textRow(1, "about my game")],
          games: [textRow(2, "about the import")],
          practice: [textRow(3, "about the puzzle")],
        },
        activity: liveGame(),
      }),
    );
    const log = () => document.querySelector(".chat__log")?.textContent ?? "";
    expect(log()).toContain("about my game");
    expect(log()).not.toContain("about the puzzle");
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    // The hub keeps the panel closed until the student opens it there.
    fireEvent.click(screen.getByRole("button", { name: /Expand coach panel/ }));
    expect(log()).toContain("about the puzzle");
    expect(log()).not.toContain("about my game");
    fireEvent.click(screen.getByRole("button", { name: "Games" }));
    expect(log()).toContain("about the import");
  });

  it("marks a tab with an unread dot when the coach answers there, until it is opened", () => {
    render(<App />);
    connect();
    act(() =>
      FakeSocket.latest.receive({
        type: "chat",
        tab: "practice",
        message_id: 1,
        seq: 1,
        event: { kind: "text_delta", text: "Boa!" },
      }),
    );
    const practice = screen.getByRole("button", { name: "Practice" });
    expect(screen.getByTestId("tab-unread-practice")).toBeTruthy();
    expect(practice.getAttribute("data-unread")).toBe("true");
    expect(screen.queryByTestId("tab-unread-play")).toBeNull();
    expect(screen.queryByTestId("tab-unread-games")).toBeNull();

    fireEvent.click(practice);
    expect(screen.queryByTestId("tab-unread-practice")).toBeNull();
    act(() =>
      FakeSocket.latest.receive({
        type: "chat",
        tab: "practice",
        message_id: 2,
        seq: 2,
        event: { kind: "text_delta", text: "Again, on screen" },
      }),
    );
    expect(screen.queryByTestId("tab-unread-practice")).toBeNull();
  });

  it("reduces a repeated error to a new errorCount so the board can resync", () => {
    const error = { type: "error", code: "illegal_move", message: "same" } as const;
    const once = chatReducer(initialChatState, { type: "server", event: error });
    const twice = chatReducer(once, { type: "server", event: error });
    expect(twice.errorCount).toBe(2);
    expect(chatReducer(twice, { type: "dismiss_error" }).lastError).toBeNull();
  });
});

describe("a From my games opponent", () => {
  const SANS = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];

  function detailOf() {
    const chess = new Chess();
    const moves = SANS.map((san, index) => {
      const played = chess.move(san);
      return {
        ply: index + 1,
        san,
        uci: `${played.from}${played.to}`,
        is_player: index % 2 === 0,
        eval_before_cp: null,
        eval_after_cp: null,
        cp_loss: index % 2 === 0 ? (index === 2 ? 120 : 10) : null,
        classification:
          index % 2 === 0 ? (index === 2 ? ("inaccuracy" as const) : ("great" as const)) : null,
        best_move_san: index === 2 ? "d4" : null,
        fen_after: chess.fen(),
      };
    });
    return {
      ...COACH_GAME_SOURCE,
      id: 7,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T01:00:00.000Z",
      player_color: "white" as const,
      target_elo: 1200,
      result: "0-1" as const,
      termination: "resign" as const,
      initial_fen: START_FEN,
      mistakes_count: 3,
      moves,
    };
  }

  const summary = {
    ...COACH_GAME_SOURCE,
    id: 7,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T01:00:00.000Z",
    player_color: "white" as const,
    target_elo: 1200,
    result: "0-1" as const,
    termination: "resign" as const,
    move_count: 6,
    accuracy: 0.5,
    worst_moment: { ply: 3, san: "Nf3", cp_loss: 120, classification: "inaccuracy" as const },
    cards_count: 2,
    mistakes_count: 3,
  };

  it("switches to Games with the review open at the wrong move, once", async () => {
    const mistake = foundPosition({
      id: "own:from-app",
      section: "mistakes",
      phase: "middlegame",
      from_mistake: true,
      opening_name: "Test Opening",
      game: { id: 7, ply: 3, opponent: "Whambalee", played_at: "2026-02-27T12:00:00.000Z" },
    });
    const whole = foundResponse([mistake]);
    const detail = detailOf();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const path = typeof url === "string" ? url : url.toString();
        if (path.includes("/api/found-positions")) return Response.json(whole);
        if (path === "/api/games") return Response.json({ games: [summary] });
        if (path.startsWith("/api/games/")) return Response.json({ game: detail });
        if (path === "/api/progress") return Response.json(progressOf());
        if (path === "/api/repertoires")
          return Response.json({ repertoires: [], groups: [], sides: [], met: [], branches: [] });
        if (path.includes("/api/puzzles/themes/stats"))
          return Response.json({
            days: "30",
            overall: { played: 0, first_try: 0, rating_avg: null, performance: null },
            overall_previous: null,
            themes: [],
            improvement_areas: [],
            strengths: [],
            unranked: 0,
          });
        return Response.json({ status: "ok", version: "0.0.0", ready: true });
      }),
    );
    render(<App />);
    connect();
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    openPracticePage("From my games");
    const opponent = await screen.findByRole("button", { name: "vs Whambalee" });
    fireEvent.click(opponent);
    expect(await screen.findByRole("heading", { name: "White vs Stockfish 1200" })).toBeTruthy();
    expect(screen.getByTestId("ply-3").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("ply-detail").textContent).toContain("2. Nf3, Inaccuracy");
    await waitFor(() => {
      const sent = FakeSocket.latest.sent as { type: string; game_id?: number; ply?: number }[];
      expect(sent).toContainEqual(expect.objectContaining({ type: "open_game", game_id: 7 }));
      expect(sent).toContainEqual(
        expect.objectContaining({ type: "select_review_ply", game_id: 7, ply: 3 }),
      );
    });
    const opens = (FakeSocket.latest.sent as { type: string }[]).filter(
      (c) => c.type === "open_game",
    ).length;
    expect(opens).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    fireEvent.click(screen.getByRole("button", { name: "Games" }));
    expect(await screen.findByRole("table", { name: "Finished games" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(
      (FakeSocket.latest.sent as { type: string }[]).filter((c) => c.type === "open_game"),
    ).toHaveLength(1);
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
