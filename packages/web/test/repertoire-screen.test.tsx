import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrainingActivity } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import { Practice } from "../src/screens/Practice.js";
import { PRACTICE_PAGE_STORAGE_KEY } from "../src/state/practice-page.js";
import {
  CLASSICAL_VARIATION,
  italianRepertoire,
  motifCounts,
  openPracticePage,
  progressOf,
  repertoireActivity,
  repertoireAnswer,
  repertoireList,
} from "./practice-fixtures.js";
import { serverApi } from "./server-api.js";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const listed = async () => repertoireList;
const hubProps = {
  fetchProgress: async () => progressOf(),
  fetchMotifs: async () => motifCounts,
  fetchRepertoires: listed,
  fetchRepertoireList: async () => repertoireAnswer(),
};

const seen: { fen?: string; drawable?: { autoShapes?: unknown[] } }[] = [];
const spyBoard: BoardFactory = (_element, config) => {
  seen.push(config as (typeof seen)[number]);
  return { set: (next: (typeof seen)[number]) => seen.push(next), destroy: vi.fn() } as never;
};

const IDEA = "Prepare d4 and keep the bishop on the a2 g8 diagonal.";

function renderDrill(activity: TrainingActivity, fetchRepertoires = listed) {
  const server = serverApi(activity, { tab: "practice" });
  const view = render(
    <Practice server={server} createBoard={spyBoard} fetchRepertoires={fetchRepertoires} />,
  );
  return { server, ...view };
}

// The page draws its sections once the list has loaded, so it is found by what the list holds.
async function whiteOpenings(): Promise<HTMLElement> {
  await screen.findByRole("article", { name: "Italian Game" });
  return screen.getByRole("region", { name: "White" });
}

const stateCard = (): HTMLElement => document.querySelector(".state-card") as HTMLElement;
const moveList = (): HTMLElement => screen.getByRole("list", { name: "Moves" });
const fact = (key: string): string | undefined =>
  screen.getByTestId(`fact-${key}`).querySelector("dd")?.textContent ?? undefined;
const arrows = (): unknown[] => seen.at(-1)?.drawable?.autoShapes ?? [];

describe("the openings page on the hub", () => {
  // The page is the hub's Openings page, which each hub here opens on as the page stored last.
  beforeEach(() => window.localStorage.setItem(PRACTICE_PAGE_STORAGE_KEY, "openings"));

  const italianCard = (): HTMLElement => screen.getByRole("article", { name: "Italian Game" });

  it("shows the Italian Game card with its variation's train button, counts and menu", async () => {
    render(<Practice server={serverApi(null)} {...hubProps} />);
    const group = await whiteOpenings();
    expect(within(group).getByText("1 variation")).toBeTruthy();
    const trainCard = within(group).getByRole("button", { name: "Train 10, Italian Game" });
    expect((trainCard as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(group).getByRole("button", { name: "Italian Game" }));
    expect(within(group).getByText(CLASSICAL_VARIATION)).toBeTruthy();
    expect(
      (
        within(group).getByRole("button", {
          name: `Train 10, ${CLASSICAL_VARIATION}`,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    fireEvent.click(
      within(group).getByRole("button", { name: "More ways to train, Italian Game" }),
    );
    expect(
      within(group)
        .getAllByRole("button", { name: /^(Everything due|All moves)/ })
        .map((entry) => entry.textContent),
    ).toEqual(["Everything due 14", "All moves 38"]);
  });

  it.each([
    ["Train 10, Italian Game", "recommended"],
    ["Everything due 14", "due"],
    ["All moves 38", "all"],
  ] as const)(
    "starts the line drill of the scope %s from the card and sends no drill size",
    async (name, scope) => {
      const server = serverApi(null);
      render(<Practice server={server} {...hubProps} />);
      const group = await whiteOpenings();
      if (scope !== "recommended") {
        fireEvent.click(
          within(group).getByRole("button", { name: "More ways to train, Italian Game" }),
        );
      }
      fireEvent.click(within(group).getByRole("button", { name }));
      expect(server.send).toHaveBeenCalledTimes(1);
      expect(server.send).toHaveBeenCalledWith({
        type: "start_training",
        mode: "repertoire",
        repertoire_id: 3,
        scope,
        level: "group",
      });
    },
  );

  it("starts the line drill of one variation with no level from its row", async () => {
    const server = serverApi(null);
    render(<Practice server={server} {...hubProps} />);
    const group = await whiteOpenings();
    fireEvent.click(within(group).getByRole("button", { name: "Italian Game" }));
    fireEvent.click(
      within(group).getByRole("button", { name: `Train 10, ${CLASSICAL_VARIATION}` }),
    );
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "repertoire",
      repertoire_id: 3,
      scope: "recommended",
    });
  });

  it("marks the pressed start as starting and holds every other start until the board answers", async () => {
    render(<Practice server={serverApi(null)} {...hubProps} />);
    const group = await whiteOpenings();
    fireEvent.click(
      within(group).getByRole("button", { name: "More ways to train, Italian Game" }),
    );
    fireEvent.click(within(group).getByRole("button", { name: "Everything due 14" }));
    expect(within(group).getByRole("button", { name: "Starting, Italian Game" })).toBeTruthy();
    expect(
      (
        within(group).getByRole("button", {
          name: "More ways to train, Italian Game",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    openPracticePage("Overview");
    const motifStart = screen.getByRole("button", { name: "Start any motif" });
    expect((motifStart as HTMLButtonElement).disabled).toBe(true);
  });

  it("waits while another card starts a session", async () => {
    render(<Practice server={serverApi(null)} {...hubProps} />);
    const group = await whiteOpenings();
    openPracticePage("Overview");
    fireEvent.click(await screen.findByRole("button", { name: "Start any motif" }));
    openPracticePage("Openings");
    expect(
      (within(group).getByRole("button", { name: "Train 10, Italian Game" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("offers a button that trains all moves, with no menu, when nothing is due", async () => {
    const none = [{ ...italianRepertoire, moves: { recommended: 0, due: 0, all: 38 } }];
    const server = serverApi(null);
    render(
      <Practice
        server={server}
        {...hubProps}
        fetchRepertoireList={async () => repertoireAnswer(none)}
      />,
    );
    const group = await whiteOpenings();
    const button = within(group).getByRole("button", { name: "Train all moves, Italian Game" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(
      within(group).queryByRole("button", { name: "More ways to train, Italian Game" }),
    ).toBeNull();
    fireEvent.click(button);
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "repertoire",
      repertoire_id: 3,
      scope: "all",
      level: "group",
    });
  });

  it("keeps the starts open when the engine is missing, since a line is graded against stored moves", async () => {
    const missing = async () => ({
      status: "ok" as const,
      version: "test",
      ready: false,
      reason: "stockfish_missing",
    });
    render(<Practice server={serverApi(null)} {...hubProps} fetchHealth={missing} />);
    openPracticePage("Overview");
    await screen.findByRole("alert", { name: "Engine missing" });
    openPracticePage("Openings");
    const group = await whiteOpenings();
    const start = within(group).getByRole("button", { name: "Train 10, Italian Game" });
    expect((start as HTMLButtonElement).disabled).toBe(false);
  });

  it("words a refused start and goes back to the page", async () => {
    const server = serverApi(null);
    const { rerender } = render(<Practice server={server} {...hubProps} />);
    const group = await whiteOpenings();
    fireEvent.click(
      within(group).getByRole("button", { name: "More ways to train, Italian Game" }),
    );
    fireEvent.click(within(group).getByRole("button", { name: "Everything due 14" }));
    const refused = serverApi(null, { errorCount: 1, lastErrorCode: "empty_queue" });
    rerender(<Practice server={refused} {...hubProps} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No move of this opening is due right now");
    expect(alert.textContent).toContain("Choose All moves");
    expect(within(group).getByRole("button", { name: "Train 10, Italian Game" })).toBeTruthy();
  });

  it("says when the openings are loading, failed or not stored yet", async () => {
    const waiting = new Promise<never>(() => undefined);
    const { unmount } = render(
      <Practice server={serverApi(null)} {...hubProps} fetchRepertoireList={() => waiting} />,
    );
    expect((await screen.findByRole("status")).textContent).toBe("Loading your openings.");
    unmount();

    const failing = () => Promise.reject(new Error("down"));
    const second = render(
      <Practice server={serverApi(null)} {...hubProps} fetchRepertoireList={failing} />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.className).toContain("practice__failure");
    expect(alert.textContent).toBe("Your openings could not be loaded.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    second.unmount();

    render(
      <Practice
        server={serverApi(null)}
        {...hubProps}
        fetchRepertoireList={async () => repertoireAnswer([])}
      />,
    );
    await screen.findByText("No opening is stored yet.");
  });

  it("offers no Try again while it loads or after it loaded", async () => {
    const waiting = new Promise<never>(() => undefined);
    const { unmount } = render(
      <Practice server={serverApi(null)} {...hubProps} fetchRepertoireList={() => waiting} />,
    );
    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    unmount();

    render(<Practice server={serverApi(null)} {...hubProps} />);
    await whiteOpenings();
    expect(italianCard()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    cleanup();
    render(
      <Practice
        server={serverApi(null)}
        {...hubProps}
        fetchRepertoireList={async () => repertoireAnswer([])}
      />,
    );
    await screen.findByText("No opening is stored yet.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("retries only the list when Try again is pressed", async () => {
    let resolveSecond: (value: ReturnType<typeof repertoireAnswer>) => void = () => undefined;
    const secondCall = new Promise<ReturnType<typeof repertoireAnswer>>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchRepertoireList = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(secondCall);
    const fetchProgress = vi.fn(hubProps.fetchProgress);
    const fetchMotifs = vi.fn(hubProps.fetchMotifs);

    render(
      <Practice
        server={serverApi(null)}
        fetchProgress={fetchProgress}
        fetchMotifs={fetchMotifs}
        fetchRepertoireList={fetchRepertoireList}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Your openings could not be loaded.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("status").textContent).toBe("Loading your openings.");
    expect(fetchRepertoireList).toHaveBeenCalledTimes(2);
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(fetchMotifs).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSecond(repertoireAnswer());
      await secondCall;
    });
    const loadedCard = await whiteOpenings();
    expect(within(loadedCard).getByRole("article", { name: "Italian Game" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("groups each side under its own heading", async () => {
    const both = [
      ...repertoireList,
      { ...italianRepertoire, id: 4, side: "black" as const, group_name: "Sicilian Defense" },
    ];
    render(
      <Practice
        server={serverApi(null)}
        {...hubProps}
        fetchRepertoireList={async () => repertoireAnswer(both)}
      />,
    );
    await screen.findByRole("region", { name: "White" });
    const black = await screen.findByRole("region", { name: "Black" });
    expect(within(black).getByRole("article", { name: "Sicilian Defense" })).toBeTruthy();
  });

  it("draws no older Italian puzzle row beside the sections", async () => {
    render(<Practice server={serverApi(null)} {...hubProps} />);
    await whiteOpenings();
    expect(screen.queryByText("Italian Opening")).toBeNull();
    expect(screen.queryByRole("region", { name: "Openings" })).toBeNull();
  });
});

describe("the variation in play", () => {
  it("names the position's opening above the move list, with the rating block gone", () => {
    renderDrill(repertoireActivity());
    const name = screen.getByTestId("variation-name");
    expect(name.textContent).toBe("Italian Game: Giuoco Piano");
    expect(
      name.compareDocumentPosition(moveList()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Puzzle rating")).toBeNull();
  });

  it("falls back to the variation of the repertoire when the position has no book name", async () => {
    renderDrill(repertoireActivity({ sans: [], drill: { opening_name: null } }));
    await waitFor(() =>
      expect(screen.getByTestId("variation-name").textContent).toBe(CLASSICAL_VARIATION),
    );
  });

  it("still names something while the list loads, and when it cannot be read", async () => {
    const waiting = new Promise<never>(() => undefined);
    const bare = repertoireActivity({ sans: [], drill: { opening_name: null } });
    const { unmount } = renderDrill(bare, () => waiting);
    expect(screen.getByTestId("variation-name").textContent).toBe("Loading the variation name");
    unmount();
    renderDrill(bare, () => Promise.reject(new Error("down")));
    await waitFor(() =>
      expect(screen.getByTestId("variation-name").textContent).toBe("Variation name not available"),
    );
  });

  it("keeps the name on the screen after a miss, a hint and when the line has ended", () => {
    const states = [
      repertoireActivity({ training: { tries: 1 } }),
      repertoireActivity({ drill: { hint: { kind: "idea", text: IDEA } } }),
      repertoireActivity({ training: { status: "solved", input_enabled: false, legal_moves: [] } }),
    ];
    const { rerender } = renderDrill(states[0] as TrainingActivity);
    for (const state of states) {
      rerender(
        <Practice
          server={serverApi(state, { tab: "practice" })}
          createBoard={spyBoard}
          fetchRepertoires={listed}
        />,
      );
      expect(screen.getByTestId("variation-name").textContent).toBe("Italian Game: Giuoco Piano");
    }
  });
});

describe("a move that is new", () => {
  const first = () =>
    repertoireActivity({
      drill: { first_pass: true, answer: { uci: "c2c3", san: "c3" } },
    });

  it("shows its answer as an arrow on the board and in the move list and the card", () => {
    renderDrill(first());
    expect(arrows()).toEqual([{ orig: "c2", dest: "c3", brush: "green" }]);
    expect(screen.getByTestId("answer-cell").textContent).toContain("c3");
    expect(stateCard().textContent).toContain("New move");
    expect(stateCard().textContent).toContain("Play c3");
  });

  it("shows a blank for the move on a later pass, with no arrow and no answer", () => {
    seen.length = 0;
    renderDrill(repertoireActivity());
    expect(arrows()).toEqual([]);
    expect(screen.queryByTestId("answer-cell")).toBeNull();
    expect(screen.getByTestId("ply-6")).toBeTruthy();
    expect(screen.getAllByText("Your move").length).toBeGreaterThan(0);
    expect(moveList().textContent).not.toContain("c3");
  });

  it("keeps the move blank on a later pass even if an answer is still attached", () => {
    seen.length = 0;
    renderDrill(
      repertoireActivity({ drill: { first_pass: false, answer: { uci: "c2c3", san: "c3" } } }),
    );
    expect(arrows()).toEqual([]);
    expect(screen.queryByTestId("answer-cell")).toBeNull();
    expect(moveList().textContent).not.toContain("c3");
  });

  it("offers the idea on a new move but never the move, which is already shown", () => {
    renderDrill(first());
    expect(screen.getByRole("button", { name: "Ask for the idea" })).toBeTruthy();
    cleanup();
    renderDrill(
      repertoireActivity({
        drill: {
          first_pass: true,
          answer: { uci: "c2c3", san: "c3" },
          hint: { kind: "idea", text: IDEA },
        },
      }),
    );
    expect(screen.queryByRole("button", { name: /Ask for/ })).toBeNull();
    expect(stateCard().textContent).toContain(IDEA);
  });
});

describe("a miss", () => {
  const missed = (tries: number) =>
    repertoireActivity({
      training: {
        tries,
        last_try: { uci: "d2d3", san: "d3", correct: false },
        wrong_tries: Array.from({ length: tries }, () => ({ ply: 6, uci: "d2d3", san: "d3" })),
      },
    });

  it("returns the piece and adds nothing to the panel, and only the wrong-try counter goes up", () => {
    const { rerender } = renderDrill(repertoireActivity());
    expect(fact("tries")).toBe("0");
    const cardBefore = stateCard().textContent;
    const listBefore = moveList().textContent;
    const setsBefore = seen.length;

    const after = missed(1);
    rerender(
      <Practice
        server={serverApi(after, { tab: "practice" })}
        createBoard={spyBoard}
        fetchRepertoires={listed}
      />,
    );

    expect(fact("tries")).toBe("1");
    expect(seen.length).toBeGreaterThan(setsBefore);
    expect(seen.at(-1)?.fen).toBe(after.fen);
    expect(stateCard().textContent).toBe(cardBefore);
    expect(moveList().textContent).toBe(listBefore);
    expect(document.querySelector(".moves-list__variation")).toBeNull();
    expect(screen.queryByText(/Not that move|Try something else/)).toBeNull();
    expect(screen.queryByTestId("square-badge")).toBeNull();
  });

  it("keeps counting and keeps the line open for as many tries as the student wants", () => {
    renderDrill(missed(4));
    expect(fact("tries")).toBe("4");
    expect(screen.getByTestId("ply-6")).toBeTruthy();
  });

  it("still marks a right move on its square", () => {
    renderDrill(
      repertoireActivity({
        training: { last_try: { uci: "c2c3", san: "c3", correct: true }, status: "in_progress" },
      }),
    );
    expect(screen.getByTestId("square-badge").getAttribute("data-kind")).toBe("check");
  });

  it("sends the try as try_move and never as exploration", () => {
    const { server } = renderDrill(repertoireActivity());
    expect(server.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "explore" }));
  });
});

describe("the hints", () => {
  it("offers the idea, then the move, and shows each only once asked", () => {
    const { server, rerender } = renderDrill(repertoireActivity());
    expect(stateCard().textContent).not.toContain(IDEA);
    expect(arrows()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Ask for the idea" }));
    expect(server.send).toHaveBeenCalledWith({ type: "hint", activity_id: 6 });

    const idea = repertoireActivity({ drill: { hint: { kind: "idea", text: IDEA } } });
    rerender(
      <Practice
        server={serverApi(idea, { tab: "practice" })}
        createBoard={spyBoard}
        fetchRepertoires={listed}
      />,
    );
    expect(stateCard().textContent).toContain("The idea");
    expect(stateCard().textContent).toContain(IDEA);
    expect(arrows()).toEqual([]);
    expect(screen.queryByText("Ask for the idea")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ask for the move" }));
    const move = repertoireActivity({ drill: { hint: { kind: "move", uci: "c2c3", san: "c3" } } });
    rerender(
      <Practice
        server={serverApi(move, { tab: "practice" })}
        createBoard={spyBoard}
        fetchRepertoires={listed}
      />,
    );
    expect(stateCard().textContent).toContain("Play c3");
    expect(arrows()).toEqual([{ orig: "c2", dest: "c3", brush: "green" }]);
    expect(screen.getByTestId("answer-cell").textContent).toContain("c3");
    expect(screen.queryByRole("button", { name: /Ask for/ })).toBeNull();
  });

  it("has no View solution, so the hint button is the only way to the move", () => {
    renderDrill(repertoireActivity());
    expect(screen.queryByRole("button", { name: "View solution" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Get a hint" })).toBeNull();
  });

  it("asks for a hint with the h key as it does on a puzzle", () => {
    const { server } = renderDrill(repertoireActivity());
    fireEvent.keyDown(window, { key: "h" });
    expect(server.send).toHaveBeenCalledWith({ type: "hint", activity_id: 6 });
  });
});

describe("a flagged try", () => {
  it("names the other opening the good move reached", () => {
    renderDrill(
      repertoireActivity({ drill: { flagged_opening: "Scotch Game", flagged_sound: true } }),
    );
    expect(screen.getByText("Good move, but that is the Scotch Game")).toBeTruthy();
    expect(stateCard().textContent).toContain("It is not the move of this line. Try again.");
  });

  it("warns without naming an opening when any other sound move is played", () => {
    renderDrill(repertoireActivity({ drill: { flagged_opening: null, flagged_sound: true } }));
    expect(screen.getByText("Good move, but this line plays another move")).toBeTruthy();
    expect(stateCard().textContent).toContain("It is not the move of this line. Try again.");
  });

  it("keeps an idea the student asked for beside the flag", () => {
    renderDrill(
      repertoireActivity({
        drill: {
          flagged_opening: "Scotch Game",
          flagged_sound: true,
          hint: { kind: "idea", text: IDEA },
        },
      }),
    );
    expect(screen.getByText("Good move, but that is the Scotch Game")).toBeTruthy();
    expect(stateCard().textContent).toContain(IDEA);
  });

  it("keeps an idea the student asked for beside a sound-move warning", () => {
    renderDrill(
      repertoireActivity({
        drill: { flagged_opening: null, flagged_sound: true, hint: { kind: "idea", text: IDEA } },
      }),
    );
    expect(screen.getByText("Good move, but this line plays another move")).toBeTruthy();
    expect(stateCard().textContent).toContain(IDEA);
  });

  it("drops the warning once the server clears it on the next try", () => {
    const { rerender } = renderDrill(
      repertoireActivity({ drill: { flagged_opening: null, flagged_sound: true } }),
    );
    expect(screen.getByText("Good move, but this line plays another move")).toBeTruthy();
    rerender(
      <Practice
        server={serverApi(repertoireActivity({ training: { tries: 2 } }), { tab: "practice" })}
        createBoard={spyBoard}
        fetchRepertoires={listed}
      />,
    );
    expect(screen.queryByText(/Good move/)).toBeNull();
    expect(stateCard().textContent).toContain("Your move");
  });
});

describe("a line that ended", () => {
  const ended = (training: Partial<TrainingActivity>, movesLeft: number) =>
    repertoireActivity({
      training: { input_enabled: false, legal_moves: [], ...training },
      drill: { moves_left: movesLeft },
    });

  it("reads Line played and offers Continue while moves are left", () => {
    const { server } = renderDrill(ended({ status: "solved" }, 3));
    expect(stateCard().textContent).toContain("Line played");
    expect(stateCard().textContent).toContain("3 moves left to practise.");
    fireEvent.click(screen.getByRole("button", { name: "Continue training" }));
    expect(server.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 6 });
  });

  it("says a missed move comes back, and still offers Continue", () => {
    renderDrill(ended({ status: "failed", tries: 1 }, 4));
    expect(stateCard().textContent).toContain("Missed a move");
    expect(stateCard().textContent).toContain("It comes back on a later pass.");
    expect(screen.getByRole("button", { name: "Continue training" })).toBeTruthy();
  });

  it("offers Finish only when no move is left, whatever the queue position says", () => {
    const last = ended({ status: "solved" }, 0);
    renderDrill(last);
    expect(screen.getByRole("button", { name: "Finish training" })).toBeTruthy();
    cleanup();
    const more = ended({ status: "solved", item: { ...last.item, position_in_queue: 3 } }, 2);
    renderDrill(more);
    expect(screen.getByRole("button", { name: "Continue training" })).toBeTruthy();
  });

  it("is locked to the board's input and lets the student step back through the line", () => {
    renderDrill(ended({ status: "solved" }, 3));
    expect(screen.getByRole("button", { name: "Previous move" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Analyse" })).toBeTruthy();
  });
});

describe("explore while a line is open", () => {
  const stage = (): HTMLElement => document.querySelector(".puzzle-stage") as HTMLElement;

  it("marks the board stage so the bar hides Explore, which the server refuses", () => {
    renderDrill(repertoireActivity());
    expect(stage().getAttribute("data-drill")).toBe("open");
    const css = readFileSync(join(import.meta.dirname, "../src/styles/repertoire.css"), "utf8");
    expect(css).toMatch(
      /\.puzzle-stage\[data-drill="open"\] \.board-bar__scratch \{\s*display: none;/,
    );
  });

  it("gives the bar back once the line has ended and leaves puzzles alone", () => {
    renderDrill(repertoireActivity({ training: { status: "solved", input_enabled: false } }));
    expect(stage().hasAttribute("data-drill")).toBe(false);
  });
});

describe("its stylesheet", () => {
  const read = (path: string): string => readFileSync(join(import.meta.dirname, path), "utf8");

  it("holds no colour literal, only tokens", () => {
    const css = read("../src/styles/repertoire.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it("is imported by the entry point, or the screen would have no styling", () => {
    expect(read("../src/main.tsx")).toContain('import "./styles/repertoire.css";');
  });
});

describe("the end of a session", () => {
  const finished = () =>
    repertoireActivity({
      training: {
        status: "solved",
        input_enabled: false,
        legal_moves: [],
        summary: { solved: 9, failed: 3 },
      },
      drill: { moves_left: 0, result: { practised: 12, first_try_right: 9 } },
    });

  it("shows the moves practised and how many were right first try", () => {
    renderDrill(finished());
    expect(screen.getByTestId("summary").textContent).toBe("12 moves practised, 9 right first try");
    expect(stateCard().textContent).toContain("Session finished");
  });

  it("says one move in the singular", () => {
    renderDrill(
      repertoireActivity({
        training: { summary: { solved: 1, failed: 0 }, input_enabled: false, legal_moves: [] },
        drill: { moves_left: 0, result: { practised: 1, first_try_right: 1 } },
      }),
    );
    expect(screen.getByTestId("summary").textContent).toBe("1 move practised, 1 right first try");
  });

  it("ends the run once and lands on the hub with no last-session line", () => {
    const { server, rerender } = renderDrill(finished());
    expect(server.send).toHaveBeenCalledTimes(1);
    expect(server.send).toHaveBeenCalledWith({ type: "end_training", activity_id: 6 });

    rerender(<Practice server={serverApi(null)} {...hubProps} createBoard={spyBoard} />);
    expect(screen.queryByTestId("summary")).toBeNull();
    expect(screen.queryByTestId("last-session")).toBeNull();
    expect(screen.getByRole("region", { name: "Due cards" })).toBeTruthy();
  });
});
