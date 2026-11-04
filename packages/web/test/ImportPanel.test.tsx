import type { ChessComListedGame, ImportStatus } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportPanel } from "../src/components/ImportPanel.js";
import type { ImportApi } from "../src/state/import-api.js";
import { summaryLabel } from "../src/state/review.js";
import { COACH_GAME_SOURCE, idleImportApi } from "./fixtures.js";

afterEach(cleanup);

const listed = (uuid: string, imported = false): ChessComListedGame => ({
  uuid,
  url: "https://www.chess.com/game/live/1",
  played_at: "2026-10-28T12:00:00.000Z",
  opponent: "Dibitard49",
  student_color: "white",
  result: "1-0",
  time_control: "600",
  student_rating: 400,
  opponent_rating: 410,
  already_imported: imported,
});

function apiWith(overrides: Partial<ImportApi>): ImportApi {
  return { ...idleImportApi, ...overrides };
}

async function listGames(): Promise<void> {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "assiszzz" } });
  fireEvent.click(screen.getByRole("button", { name: "List games" }));
  await screen.findByRole("list", { name: "Chess.com games" });
}

describe("ImportPanel", () => {
  it("lists games, imports the picked ones and reports the counts", async () => {
    const importChessCom = vi.fn(async () => ({ imported: 1, skipped: 0 }));
    const onChanged = vi.fn();
    render(
      <ImportPanel
        onChanged={onChanged}
        api={apiWith({
          listChessCom: async () => [listed("a"), listed("b", true)],
          importChessCom,
        })}
      />,
    );
    await listGames();
    const boxes = screen.getAllByRole("checkbox");
    expect((boxes[1] as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Import selected" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await screen.findByText("Imported 1, skipped 0.");
    expect(importChessCom).toHaveBeenCalledWith("assiszzz", ["a"]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows the server's message when the listing fails", async () => {
    render(
      <ImportPanel
        onChanged={() => {}}
        api={apiWith({
          listChessCom: async () =>
            Promise.reject(new Error("a Chess.com username is 3 to 25 letters")),
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "List games" }));
    await screen.findByText(/3 to 25 letters/);
  });

  it("sends a pasted PGN with the chosen side, or none when left on detect", async () => {
    const importPgn = vi.fn(async () => ({ imported: 1, skipped: 0 }));
    render(<ImportPanel onChanged={() => {}} api={apiWith({ importPgn })} />);
    fireEvent.change(screen.getByLabelText("Paste a PGN"), { target: { value: "1. e4 e5 1-0" } });
    fireEvent.click(screen.getByRole("button", { name: "Import PGN" }));
    await screen.findByText("Imported the game.");
    fireEvent.change(screen.getByLabelText("You played"), { target: { value: "black" } });
    fireEvent.click(screen.getByRole("button", { name: "Import PGN" }));
    await waitFor(() => expect(importPgn).toHaveBeenCalledTimes(2));
    expect(importPgn.mock.calls).toEqual([
      ["1. e4 e5 1-0", null],
      ["1. e4 e5 1-0", "black"],
    ]);
  });

  it("shows grading progress, keeps polling, and refreshes the list when it finishes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const statuses: ImportStatus[] = [
      { pending: 1, failed: 0, running: { game_id: 1, graded_plies: 3, total_plies: 30 } },
      { pending: 0, failed: 0, running: null },
    ];
    const status = vi.fn(async () => statuses.shift() ?? { pending: 0, failed: 0, running: null });
    const onChanged = vi.fn();
    render(<ImportPanel onChanged={onChanged} pollMs={50} api={apiWith({ status })} />);
    expect((await screen.findByTestId("import-progress")).textContent).toBe(
      "Grading a game: 3 of 30 moves, 1 more waiting.",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("import-progress")).toBeNull();
    vi.useRealTimers();
  });
});

describe("summaryLabel for imported games", () => {
  const base = {
    ...COACH_GAME_SOURCE,
    id: 1,
    started_at: "2026-10-28T12:00:00.000Z",
    finished_at: "2026-10-28T12:00:00.000Z",
    player_color: "white" as const,
    target_elo: 400,
    result: "1-0" as const,
    termination: "checkmate" as const,
    move_count: 59,
    accuracy: null,
    source: "chesscom" as const,
    opponent: "Dibitard49",
    played_at: "2026-10-28T12:00:00.000Z",
  };

  it("names the source and opponent and says grading is not finished", () => {
    expect(summaryLabel({ ...base, grading: "running" })).toBe(
      "2026-10-28, Chess.com vs Dibitard49, white, 1-0 by checkmate, 59 moves, grading running",
    );
  });

  it("falls back to accuracy once graded", () => {
    expect(summaryLabel({ ...base, grading: "done", accuracy: 0.8 })).toContain("80% accuracy");
  });
});
