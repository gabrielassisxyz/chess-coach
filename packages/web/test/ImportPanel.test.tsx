import type { ChessComListedGame } from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportPanel } from "../src/components/ImportPanel.js";
import { summaryLabel } from "../src/state/games.js";
import type { ImportApi } from "../src/state/import-api.js";
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
  fireEvent.click(screen.getByRole("button", { name: "Fetch games" }));
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
    const boxes = within(screen.getByRole("list", { name: "Chess.com games" })).getAllByRole(
      "checkbox",
    );
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

  it("hides the games of an unticked time class and keeps one with no time control", async () => {
    const blitz = { ...listed("blitz"), time_control: "180" };
    const bullet = { ...listed("bullet"), time_control: "60" };
    const unknown = { ...listed("unknown"), time_control: null };
    render(
      <ImportPanel
        onChanged={() => {}}
        api={apiWith({ listChessCom: async () => [listed("rapid"), blitz, bullet, unknown] })}
      />,
    );
    await listGames();
    expect(screen.getByText("3 games found.")).toBeTruthy();
    const items = within(screen.getByRole("list", { name: "Chess.com games" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(3);
    fireEvent.click(screen.getByRole("checkbox", { name: "Bullet" }));
    fireEvent.click(screen.getByRole("button", { name: "Fetch games" }));
    await screen.findByText("4 games found.");
  });

  it("passes the result of an import to the screen so a partial one can be retried", async () => {
    const failed = [{ id: "b", message: "timed out" }];
    const onImported = vi.fn();
    render(
      <ImportPanel
        onChanged={() => {}}
        onImported={onImported}
        api={apiWith({
          listChessCom: async () => [listed("a"), listed("b")],
          importChessCom: async () => ({ imported: 1, skipped: 0, failed }),
        })}
      />,
    );
    await listGames();
    const boxes = within(screen.getByRole("list", { name: "Chess.com games" })).getAllByRole(
      "checkbox",
    );
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await screen.findByText("Imported 1, skipped 0, 1 unreadable.");
    expect(onImported).toHaveBeenCalledWith("assiszzz", { imported: 1, skipped: 0, failed });
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
    fireEvent.click(screen.getByRole("button", { name: "Fetch games" }));
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
