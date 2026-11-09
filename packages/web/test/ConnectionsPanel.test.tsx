import type { ConnectionsStatus } from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPanel } from "../src/components/ConnectionsPanel.js";
import { Games } from "../src/screens/Games.js";
import type { ConnectionsApi } from "../src/state/connections-api.js";
import { idleConnectionsApi, idleImportApi } from "./fixtures.js";

afterEach(cleanup);

const EMPTY: ConnectionsStatus = { lichess_token_set: false, chesscom_username: null };
const WITH_TOKEN: ConnectionsStatus = { lichess_token_set: true, chesscom_username: null };

function apiWith(overrides: Partial<ConnectionsApi>): ConnectionsApi {
  return {
    get: async () => EMPTY,
    saveLichessToken: async () => WITH_TOKEN,
    removeLichessToken: async () => EMPTY,
    saveChessComUsername: async (username) => ({
      lichess_token_set: false,
      chesscom_username: username,
    }),
    removeChessComUsername: async () => EMPTY,
    ...overrides,
  };
}

const tokenField = () => screen.getByLabelText("Lichess API token") as HTMLInputElement;

describe("ConnectionsPanel", () => {
  it("hides what is typed and empties the field once the token is saved", async () => {
    const saveLichessToken = vi.fn(async () => WITH_TOKEN);
    render(<ConnectionsPanel api={apiWith({ saveLichessToken })} />);
    expect(tokenField().type).toBe("password");
    fireEvent.change(tokenField(), { target: { value: "lip_abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    await screen.findByText("A token is saved.");
    expect(saveLichessToken).toHaveBeenCalledWith("lip_abc");
    expect(tokenField().value).toBe("");
  });

  it("shows only that a token exists, and offers to replace or remove it", async () => {
    const removeLichessToken = vi.fn(async () => EMPTY);
    render(<ConnectionsPanel api={apiWith({ get: async () => WITH_TOKEN, removeLichessToken })} />);
    await screen.findByText("A token is saved.");
    expect(tokenField().value).toBe("");
    screen.getByRole("button", { name: "Replace token" });
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));
    await waitFor(() => expect(removeLichessToken).toHaveBeenCalledOnce());
    await screen.findByRole("button", { name: "Save token" });
  });

  it("says why a save was refused, and keeps what was typed", async () => {
    const saveLichessToken = vi.fn(async () => {
      throw new Error("Lichess did not accept that token.");
    });
    render(<ConnectionsPanel api={apiWith({ saveLichessToken })} />);
    fireEvent.change(tokenField(), { target: { value: "lip_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    await screen.findByText("Lichess did not accept that token.");
    expect(tokenField().value).toBe("lip_bad");
  });

  it("keeps what was typed when the saved values arrive late", async () => {
    let answer: (status: ConnectionsStatus) => void = () => undefined;
    const get = () => new Promise<ConnectionsStatus>((resolve) => (answer = resolve));
    render(<ConnectionsPanel api={apiWith({ get })} />);
    const field = screen.getByLabelText("Chess.com username") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "typed_name" } });
    answer({ lichess_token_set: false, chesscom_username: "saved_name" });
    await screen.findByText(/No token saved/);
    expect(field.value).toBe("typed_name");
  });

  it("says nothing about the token until it knows", async () => {
    render(
      <ConnectionsPanel
        api={apiWith({
          get: async () => {
            throw new Error("offline");
          },
        })}
      />,
    );
    await screen.findByText("The saved connections could not be loaded. Reload to try again.");
    expect(screen.queryByText(/No token saved/)).toBeNull();
    expect(screen.queryByText("A token is saved.")).toBeNull();
  });

  it("can be reached before there are any games", async () => {
    render(
      <Games
        server={{} as never}
        api={{ listGames: async () => [], getGame: async () => Promise.reject(new Error("none")) }}
        importApi={idleImportApi}
        connectionsApi={idleConnectionsApi}
      />,
    );
    await screen.findByRole("region", { name: "Connections" });
  });

  it("starts with the saved account and tells the parent when a connection changes", async () => {
    const onChanged = vi.fn();
    render(
      <ConnectionsPanel
        onChanged={onChanged}
        api={apiWith({
          get: async () => ({ lichess_token_set: false, chesscom_username: "someone" }),
        })}
      />,
    );
    const field = (await screen.findByDisplayValue("someone")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Save account" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });
});
