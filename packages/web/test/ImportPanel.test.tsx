import type { ChessComListedGame, ConnectionsStatus } from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportPanel } from "../src/components/ImportPanel.js";
import type { ConnectionsApi } from "../src/state/connections-api.js";
import { summaryLabel } from "../src/state/games.js";
import type { ImportApi } from "../src/state/import-api.js";
import { COACH_GAME_SOURCE, idleConnectionsApi, idleImportApi } from "./fixtures.js";

afterEach(cleanup);

const NO_ACCOUNTS: ConnectionsStatus = {
  lichess_token_set: false,
  lichess_username: null,
  chesscom_username: null,
};

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
  const savedAccount = (name: string | null): ConnectionsApi => ({
    ...idleConnectionsApi,
    get: async () => ({ ...NO_ACCOUNTS, chesscom_username: name }),
  });

  it("starts with the saved account", async () => {
    render(
      <ImportPanel onChanged={vi.fn()} api={idleImportApi} connections={savedAccount("someone")} />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("someone"),
    );
  });

  it("reads the account again on a new revision and keeps the rest of the form", async () => {
    let saved: string | null = null;
    const connections: ConnectionsApi = {
      ...idleConnectionsApi,
      get: async () => ({ ...NO_ACCOUNTS, chesscom_username: saved }),
    };
    const props = { onChanged: vi.fn(), api: idleImportApi, connections };
    const { rerender } = render(<ImportPanel {...props} connectionRevision={0} />);
    const pgn = screen.getByLabelText("Paste a PGN") as HTMLTextAreaElement;
    fireEvent.change(pgn, { target: { value: "1. e4 *" } });
    saved = "someone";
    rerender(<ImportPanel {...props} connectionRevision={1} />);
    await waitFor(() =>
      expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("someone"),
    );
    expect((screen.getByLabelText("Paste a PGN") as HTMLTextAreaElement).value).toBe("1. e4 *");
  });

  it("stays empty with no saved account", async () => {
    const get = vi.fn(async () => NO_ACCOUNTS);
    render(
      <ImportPanel
        onChanged={vi.fn()}
        api={idleImportApi}
        connections={{ ...idleConnectionsApi, get }}
      />,
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("");
  });

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

describe("importing from Lichess", () => {
  const lichessConnections = (saved: string | null): ConnectionsApi => ({
    ...idleConnectionsApi,
    get: async () => ({ ...NO_ACCOUNTS, lichess_username: saved }),
  });
  const usernameField = () => screen.getByLabelText("Lichess username") as HTMLInputElement;
  const importButton = () =>
    screen.getByRole("button", { name: /^Import Lichess games|Importing/ });

  it("starts with the saved Lichess account and leaves the Chess.com field alone", async () => {
    render(
      <ImportPanel
        onChanged={vi.fn()}
        api={idleImportApi}
        connections={lichessConnections("fixture-student")}
      />,
    );
    await waitFor(() => expect(usernameField().value).toBe("fixture-student"));
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("");
  });

  it("reads the Lichess account again on a new revision without overwriting what was typed", async () => {
    let saved: string | null = null;
    const connections: ConnectionsApi = {
      ...idleConnectionsApi,
      get: async () => ({ ...NO_ACCOUNTS, lichess_username: saved }),
    };
    const props = { onChanged: vi.fn(), api: idleImportApi, connections };
    const { rerender } = render(<ImportPanel {...props} connectionRevision={0} />);
    saved = "fixture-student";
    rerender(<ImportPanel {...props} connectionRevision={1} />);
    await waitFor(() => expect(usernameField().value).toBe("fixture-student"));
    fireEvent.change(usernameField(), { target: { value: "typed-name" } });
    saved = "another-account";
    rerender(<ImportPanel {...props} connectionRevision={2} />);
    await waitFor(() => expect(usernameField().value).toBe("typed-name"));
  });

  it("imports the whole range in one step and reports the counts", async () => {
    const importLichess = vi.fn(async () => ({ imported: 4, skipped: 1 }));
    const onChanged = vi.fn();
    render(
      <ImportPanel
        onChanged={onChanged}
        api={apiWith({ importLichess })}
        connections={lichessConnections("fixture-student")}
      />,
    );
    await waitFor(() => expect(usernameField().value).toBe("fixture-student"));
    fireEvent.change(screen.getByLabelText("First month"), { target: { value: "2026-09" } });
    fireEvent.change(screen.getByLabelText("Last month"), { target: { value: "2026-10" } });
    fireEvent.click(importButton());
    await screen.findByText("Imported 4, skipped 1.");
    expect(importLichess).toHaveBeenCalledWith("fixture-student", "2026-09", "2026-10");
    expect(onChanged).toHaveBeenCalled();
  });

  it("says how many games could not be read", async () => {
    const importLichess = async () => ({
      imported: 3,
      skipped: 0,
      failed: [{ id: "Wm4cTe9R", message: "fixture-student did not play game Wm4cTe9R" }],
    });
    render(
      <ImportPanel
        onChanged={vi.fn()}
        api={apiWith({ importLichess })}
        connections={idleConnectionsApi}
      />,
    );
    fireEvent.change(usernameField(), { target: { value: "fixture-student" } });
    fireEvent.click(importButton());
    await screen.findByText("Imported 3, skipped 0, 1 unreadable.");
  });

  it("shows the reason Lichess refused and lets the student try again", async () => {
    const importLichess = vi.fn(async () => {
      throw new Error("Lichess is rate limiting this app. Wait a few minutes, then import again.");
    });
    const onChanged = vi.fn();
    render(
      <ImportPanel
        onChanged={onChanged}
        api={apiWith({ importLichess })}
        connections={idleConnectionsApi}
      />,
    );
    fireEvent.change(usernameField(), { target: { value: "fixture-student" } });
    fireEvent.click(importButton());
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Lichess is rate limiting this app");
    expect((importButton() as HTMLButtonElement).disabled).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("is disabled with no username, and again while an import runs", async () => {
    let finish: () => void = () => undefined;
    const importLichess = () =>
      new Promise<{ imported: number; skipped: number }>((resolve) => {
        finish = () => resolve({ imported: 1, skipped: 0 });
      });
    render(
      <ImportPanel
        onChanged={vi.fn()}
        api={apiWith({ importLichess })}
        connections={idleConnectionsApi}
      />,
    );
    expect((importButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(usernameField(), { target: { value: "fixture-student" } });
    expect((importButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(importButton());
    await screen.findByRole("button", { name: "Importing…" });
    expect((importButton() as HTMLButtonElement).disabled).toBe(true);
    finish();
    await screen.findByText("Imported 1, skipped 0.");
    expect((importButton() as HTMLButtonElement).disabled).toBe(false);
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
