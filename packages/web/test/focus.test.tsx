import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GameDetail } from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../src/components/Chat.js";
import { PromotionChooser } from "../src/components/PromotionChooser.js";
import { Games } from "../src/screens/Games.js";
import { Play } from "../src/screens/Play.js";
import { Practice } from "../src/screens/Practice.js";
import type { GamesApi } from "../src/state/games-api.js";
import {
  COACH_GAME_SOURCE,
  idleFactsApi,
  idleImportApi,
  legalMovesOf,
  liveGame,
  move,
  START_FEN,
} from "./fixtures.js";
import { serverApi } from "./server-api.js";

afterEach(cleanup);

const STYLES = join(import.meta.dirname, "../src/styles");
const INTERACTIVE = "button, input, select, textarea, .board, [tabindex]";

interface Rule {
  selectors: string[];
  body: string;
}

// vitest does not process CSS imports, so the stylesheets are read as text and their rules are
// matched against the rendered elements: the test asks which rule would style each one on focus.
function focusRules(): Rule[] {
  const rules: Rule[] = [];
  for (const file of readdirSync(STYLES).filter((name) => name.endsWith(".css"))) {
    const css = readFileSync(join(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = (match[1] ?? "").split(",").map((part) => part.trim());
      if (selectors.some((selector) => selector.includes(":focus"))) {
        rules.push({ selectors, body: match[2] ?? "" });
      }
    }
  }
  return rules;
}

function focusStyleOf(element: Element, rules: Rule[]): string[] {
  const outlines: string[] = [];
  for (const rule of rules) {
    const hit = rule.selectors.some(
      (selector) =>
        selector.includes(":focus-visible") &&
        element.matches(selector.replace(":focus-visible", "")),
    );
    if (!hit) continue;
    const outline = /outline(?:-style)?\s*:\s*([^;]+)/.exec(rule.body)?.[1];
    if (outline) outlines.push(outline.trim());
  }
  return outlines;
}

function describeElement(element: Element): string {
  const label = element.getAttribute("aria-label") ?? element.textContent?.slice(0, 24) ?? "";
  return `<${element.tagName.toLowerCase()} class="${element.className}"> ${label}`;
}

function expectFocusRing(container: HTMLElement): number {
  const rules = focusRules();
  const elements = [...container.querySelectorAll(INTERACTIVE)];
  const bare = elements.filter((element) => {
    const outlines = focusStyleOf(element, rules);
    return outlines.length === 0 || outlines.some((value) => /^(none|0)\b/.test(value));
  });
  expect(bare.map(describeElement)).toEqual([]);
  return elements.length;
}

const inertBoard = () => ({ set: vi.fn(), destroy: vi.fn() }) as never;

function reviewFixture(): GameDetail {
  return {
    ...COACH_GAME_SOURCE,
    id: 7,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T01:00:00.000Z",
    player_color: "white",
    target_elo: 1200,
    result: "0-1",
    termination: "resign",
    initial_fen: START_FEN,
    moves: [
      {
        ...move(1, { san: "e4", uci: "e2e4", cp_loss: 10, classification: "great" }),
        fen_after: START_FEN,
      },
      { ...move(2, { san: "e5", uci: "e7e5" }), fen_after: START_FEN },
    ],
  };
}

const gamesApi: GamesApi = {
  listGames: async () => [
    {
      ...COACH_GAME_SOURCE,
      id: 7,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T01:00:00.000Z",
      player_color: "white",
      target_elo: 1200,
      result: "0-1",
      termination: "resign",
      move_count: 2,
      accuracy: 0.5,
    },
  ],
  getGame: async () => reviewFixture(),
};

const card = {
  kind: "training" as const,
  activity_id: 4,
  orientation: "white" as const,
  fen: START_FEN,
  turn: "white" as const,
  last_move: null,
  legal_moves: legalMovesOf(START_FEN),
  input_enabled: false,
  pending: "none" as const,
  mode: "srs" as const,
  item: {
    kind: "card" as const,
    card_id: 7,
    exposure_id: "ex-1",
    prompt_fen: START_FEN,
    student_color: "white" as const,
    rating_preview: { "0": 4, "1": 4, "2": 4, "3": 24, "4": 24, "5": 72 },
    position_in_queue: 1,
    queue_length: 3,
  },
  status: "solved" as const,
  served_at: "2026-03-01T00:00:00.000Z",
  exposure_id: "ex-1",
  expected: null,
  exploring: { fen: START_FEN, line_san: [], trail: [] },
  tries: 0,
  last_try: null,
  gave_up: false,
  solution_line: null,
  suggested_quality: null,
  summary: null,
};

describe("focus ring", () => {
  it("covers the Play screen with a game on the board", () => {
    const server = serverApi(liveGame({ moves: [move(1), move(2)] }));
    const { container } = render(
      <Play server={server} createBoard={inertBoard} factsApi={idleFactsApi} />,
    );
    expect(expectFocusRing(container)).toBeGreaterThan(3);
  });

  it("covers the new game dialog", () => {
    const { container } = render(
      <Play server={serverApi()} createBoard={inertBoard} factsApi={idleFactsApi} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New game" }));
    expect(screen.getByRole("dialog", { name: "New game" })).toBeTruthy();
    expect(container.querySelectorAll("input")).toHaveLength(3);
    expect(expectFocusRing(container)).toBeGreaterThan(5);
  });

  it("covers the Games list and an opened game with its controls", async () => {
    const { container } = render(
      <Games
        server={serverApi()}
        api={gamesApi}
        importApi={idleImportApi}
        createBoard={inertBoard}
      />,
    );
    expect(
      expectFocusRing(container) + (await screen.findAllByRole("button")).length,
    ).toBeGreaterThan(0);
    fireEvent.doubleClick(await screen.findByRole("row", { name: /1200/ }));
    await screen.findByRole("button", { name: /^Create cards/ });
    expect(expectFocusRing(container)).toBeGreaterThan(8);
  });

  it("covers the Practice chooser and a card with its rating buttons", async () => {
    const chooser = render(
      <Practice server={serverApi()} fetchMotifs={async () => [{ motif: "fork", count: 2 }]} />,
    );
    await screen.findByRole("radio", { name: /fork/ });
    expect(expectFocusRing(chooser.container)).toBeGreaterThanOrEqual(3);
    chooser.unmount();

    const training = render(<Practice server={serverApi(card)} createBoard={inertBoard} />);
    expect(screen.getAllByRole("button", { name: /^\d (Right|Blank|Wrong|Easy)/ })).toHaveLength(6);
    expect(expectFocusRing(training.container)).toBeGreaterThan(8);
  });

  it("covers the chat composer, an approval card and a tool line", () => {
    const server = serverApi(null, {
      permissions: [{ requestId: "r1", toolName: "Bash", input: {} }],
      items: [{ type: "tool", key: "t", toolUseId: "t1", name: "mcp__chess__get_game", input: {} }],
    });
    const { container } = render(<Chat server={server} />);
    expect(screen.getByRole("button", { name: /Read the game/ })).toBeTruthy();
    expect(expectFocusRing(container)).toBeGreaterThanOrEqual(4);
  });

  it("covers the promotion chooser", () => {
    const { container } = render(
      <PromotionChooser
        to="a8"
        pieces={["q", "r"]}
        orientation="white"
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(expectFocusRing(container)).toBe(3);
  });

  it("finds the board container among the interactive elements", () => {
    const { container } = render(
      <Play server={serverApi(liveGame())} createBoard={inertBoard} factsApi={idleFactsApi} />,
    );
    expect(container.querySelector(".board")?.matches(INTERACTIVE)).toBe(true);
  });
});
