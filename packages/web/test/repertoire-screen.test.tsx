import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PausedTraining, TrainingActivity } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import { useServer } from "../src/hooks/useServer.js";
import { Practice } from "../src/screens/Practice.js";
import { loadLastSession } from "../src/state/practice.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";
import {
  CLASSICAL_VARIATION,
  italianRepertoire,
  motifCounts,
  progressOf,
  repertoireActivity,
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

// The card is replaced once the list has loaded, so it is found by what the list holds.
async function whiteOpenings(): Promise<HTMLElement> {
  await screen.findByRole("heading", { name: "Italian Game" });
  return screen.getByRole("region", { name: "White openings" });
}

const stateCard = (): HTMLElement => document.querySelector(".state-card") as HTMLElement;
const moveList = (): HTMLElement => screen.getByRole("list", { name: "Moves" });
const fact = (key: string): string | undefined =>
  screen.getByTestId(`fact-${key}`).querySelector("dd")?.textContent ?? undefined;
const arrows = (): unknown[] => seen.at(-1)?.drawable?.autoShapes ?? [];

describe("the openings menu on the hub", () => {
  it("shows a White openings group with Italian Game, its variation and three starts with counts", async () => {
    render(<Practice server={serverApi(null)} {...hubProps} />);
    const group = await whiteOpenings();
    expect(within(group).getByText("14 due")).toBeTruthy();
    expect(within(group).getByText(CLASSICAL_VARIATION)).toBeTruthy();
    for (const name of ["Recommended 10", "Everything due 14", "All moves 38"]) {
      expect((within(group).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    }
  });

  it.each([
    ["Recommended 10", "recommended"],
    ["Everything due 14", "due"],
    ["All moves 38", "all"],
  ] as const)(
    "starts the line drill of the scope %s and sends no drill size",
    async (name, scope) => {
      const server = serverApi(null);
      render(<Practice server={server} {...hubProps} />);
      const group = await whiteOpenings();
      fireEvent.click(within(group).getByRole("button", { name }));
      expect(server.send).toHaveBeenCalledTimes(1);
      expect(server.send).toHaveBeenCalledWith({
        type: "start_training",
        mode: "repertoire",
        repertoire_id: 3,
        scope,
      });
    },
  );

  it("marks the pressed start as starting and holds every other start until the board answers", async () => {
    render(<Practice server={serverApi(null)} {...hubProps} />);
    const group = await whiteOpenings();
    fireEvent.click(within(group).getByRole("button", { name: "Everything due 14" }));
    expect(within(group).getByRole("button", { name: "Starting" })).toBeTruthy();
    expect(
      (within(group).getByRole("button", { name: "Recommended 10" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const motifStart = screen.getByRole("button", { name: "Start any motif" });
    expect((motifStart as HTMLButtonElement).disabled).toBe(true);
  });

  it("waits while another card starts a session", async () => {
    render(<Practice server={serverApi(null)} {...hubProps} />);
    const group = await whiteOpenings();
    fireEvent.click(await screen.findByRole("button", { name: "Start any motif" }));
    expect(
      (within(group).getByRole("button", { name: "Recommended 10" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("disables a start with nothing to serve and says why", async () => {
    const none = async () => [{ ...italianRepertoire, moves: { recommended: 0, due: 0, all: 38 } }];
    render(<Practice server={serverApi(null)} {...hubProps} fetchRepertoires={none} />);
    const group = await whiteOpenings();
    for (const name of ["Recommended 0", "Everything due 0"]) {
      expect((within(group).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
    expect(
      (within(group).getByRole("button", { name: "All moves 38" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(group.textContent).toContain("Nothing is due");
  });

  it("keeps the starts open when the engine is missing, since a line is graded against stored moves", async () => {
    const missing = async () => ({
      status: "ok" as const,
      version: "test",
      ready: false,
      reason: "stockfish_missing",
    });
    render(<Practice server={serverApi(null)} {...hubProps} fetchHealth={missing} />);
    await screen.findByRole("alert", { name: "Engine missing" });
    const group = await whiteOpenings();
    const start = within(group).getByRole("button", { name: "Recommended 10" });
    expect((start as HTMLButtonElement).disabled).toBe(false);
  });

  it("words a refused start and goes back to the menu", async () => {
    const server = serverApi(null);
    const { rerender } = render(<Practice server={server} {...hubProps} />);
    const group = await whiteOpenings();
    fireEvent.click(within(group).getByRole("button", { name: "Everything due 14" }));
    const refused = serverApi(null, { errorCount: 1, lastErrorCode: "empty_queue" });
    rerender(<Practice server={refused} {...hubProps} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No move of this opening is due right now");
    expect(alert.textContent).toContain("Choose All moves");
    expect(within(group).getByRole("button", { name: "Everything due 14" })).toBeTruthy();
  });

  it("says when the openings are loading, failed or not stored yet", async () => {
    const waiting = new Promise<never>(() => undefined);
    const { unmount } = render(
      <Practice server={serverApi(null)} {...hubProps} fetchRepertoires={() => waiting} />,
    );
    expect((await screen.findByRole("region", { name: "White openings" })).textContent).toContain(
      "Loading openings.",
    );
    unmount();

    const failing = () => Promise.reject(new Error("down"));
    const second = render(
      <Practice server={serverApi(null)} {...hubProps} fetchRepertoires={failing} />,
    );
    await screen.findByText(/The openings could not be loaded/);
    second.unmount();

    render(<Practice server={serverApi(null)} {...hubProps} fetchRepertoires={async () => []} />);
    await screen.findByText("No opening is stored yet. Generate the Italian repertoire first.");
  });

  it("groups each side under its own heading", async () => {
    const both = async () => [
      ...repertoireList,
      { ...italianRepertoire, id: 4, side: "black" as const, group_name: "Sicilian Defense" },
    ];
    render(<Practice server={serverApi(null)} {...hubProps} fetchRepertoires={both} />);
    await screen.findByRole("region", { name: "White openings" });
    const black = await screen.findByRole("region", { name: "Black openings" });
    expect(within(black).getByRole("heading", { name: "Sicilian Defense" })).toBeTruthy();
  });

  it("leaves the older Italian puzzle row where it was", async () => {
    render(<Practice server={serverApi(null)} {...hubProps} />);
    const openings = await screen.findByRole("region", { name: "Openings" });
    expect(within(openings).getByText("Italian Opening")).toBeTruthy();
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
    renderDrill(repertoireActivity({ drill: { flagged_opening: "Scotch Game" } }));
    expect(screen.getByText("Good move, but that is the Scotch Game")).toBeTruthy();
    expect(stateCard().textContent).toContain("Try again");
  });

  it("keeps an idea the student asked for beside the flag", () => {
    renderDrill(
      repertoireActivity({
        drill: { flagged_opening: "Scotch Game", hint: { kind: "idea", text: IDEA } },
      }),
    );
    expect(screen.getByText("Good move, but that is the Scotch Game")).toBeTruthy();
    expect(stateCard().textContent).toContain(IDEA);
  });

  it("drops the name once the server clears it on the next try", () => {
    const { rerender } = renderDrill(
      repertoireActivity({ drill: { flagged_opening: "Scotch Game" } }),
    );
    rerender(
      <Practice
        server={serverApi(repertoireActivity({ training: { tries: 2 } }), { tab: "practice" })}
        createBoard={spyBoard}
        fetchRepertoires={listed}
      />,
    );
    expect(screen.queryByText(/Scotch Game/)).toBeNull();
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

  it("ends the run and lands on the hub with the same words, kept across a reload", () => {
    const { server, rerender } = renderDrill(finished());
    expect(server.send).toHaveBeenCalledWith({ type: "end_training", activity_id: 6 });
    expect(loadLastSession()).toEqual({ solved: 9, failed: 3, unit: "moves" });

    rerender(<Practice server={serverApi(null)} {...hubProps} createBoard={spyBoard} />);
    expect(screen.getByTestId("last-session").textContent).toBe(
      "Last session: 12 moves practised, 9 right first try",
    );
  });
});

function Connected() {
  const server = useServer({ url: "ws://test/api/ws", createSocket: createFakeSocket });
  return <Practice server={server} {...hubProps} />;
}

describe("a paused line drill", () => {
  const paused: PausedTraining = {
    run_id: 3,
    mode: "repertoire",
    motif: null,
    color: "white",
    position: 2,
    size: 12,
    solved: 2,
    failed: 1,
    repertoire_id: 3,
    scope: "recommended",
  };

  it("offers Resume counting moves, not items", async () => {
    FakeSocket.reset();
    render(<Connected />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
        paused_training: paused,
      }),
    );
    const resume = await screen.findByRole("region", { name: "Paused session" });
    expect(within(resume).getByText("Resume: Repertoire · 2 of 12 moves done")).toBeTruthy();
    fireEvent.click(within(resume).getByRole("button", { name: "Resume" }));
    expect(FakeSocket.latest.sent.map((frame) => (frame as { type: string }).type)).toContain(
      "resume_training",
    );
  });
});
