import type { HealthResponse } from "@chess-coach/shared";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { useHealth } from "../src/hooks/useHealth.js";
import { FakeSocket } from "./fake-socket.js";

const health = (overrides: Partial<HealthResponse> = {}): HealthResponse => ({
  status: "ok",
  version: "0.0.0",
  ready: true,
  ...overrides,
});

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function connectWithNoGame(): void {
  act(() => FakeSocket.latest.open());
  act(() => FakeSocket.latest.receive({ type: "bootstrap", transcript: [], activity: null }));
}

describe("service banner", () => {
  it("shows the install hint and disables New game while Stockfish is missing", async () => {
    const fetchHealth = vi.fn(async () => health({ ready: false, reason: "stockfish_missing" }));
    render(<App fetchHealth={fetchHealth} />);
    connectWithNoGame();
    const banner = await screen.findByRole("note", { name: "Server status" });
    expect(banner.textContent).toContain("Stockfish was not found");
    expect(banner.textContent).toContain("STOCKFISH_PATH");
    expect((screen.getByRole("button", { name: "New game" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("names an engine fault and keeps New game disabled", async () => {
    const fetchHealth = vi.fn(async () => health({ ready: false, reason: "engine_fault" }));
    render(<App fetchHealth={fetchHealth} />);
    connectWithNoGame();
    const banner = await screen.findByRole("note", { name: "Server status" });
    expect(banner.getAttribute("data-reason")).toBe("engine_fault");
    expect((screen.getByRole("button", { name: "New game" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows nothing and leaves New game enabled when the server is ready", async () => {
    const fetchHealth = vi.fn(async () => health());
    render(<App fetchHealth={fetchHealth} />);
    connectWithNoGame();
    await waitFor(() => expect(fetchHealth).toHaveBeenCalled());
    expect(screen.queryByRole("note", { name: "Server status" })).toBeNull();
    expect((screen.getByRole("button", { name: "New game" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("stays quiet while the coach is merely starting", async () => {
    const fetchHealth = vi.fn(async () => health({ ready: false, reason: "coach is starting" }));
    render(<App fetchHealth={fetchHealth} />);
    connectWithNoGame();
    await waitFor(() => expect(fetchHealth).toHaveBeenCalled());
    expect(screen.queryByRole("note", { name: "Server status" })).toBeNull();
  });
});

describe("useHealth", () => {
  it("polls every interval until the server is ready, then stops", async () => {
    vi.useFakeTimers();
    const answers = [health({ ready: false, reason: "x" }), health({ ready: false }), health()];
    const fetchHealth = vi.fn(async () => answers.shift() ?? health());
    const { result } = renderHook(() => useHealth(0, { fetchHealth, intervalMs: 1000 }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchHealth).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fetchHealth).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fetchHealth).toHaveBeenCalledTimes(3);
    expect(result.current?.ready).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(fetchHealth).toHaveBeenCalledTimes(3);
  });

  it("asks again when the refresh token changes, and keeps the last answer when a request fails", async () => {
    const fetchHealth = vi
      .fn<() => Promise<HealthResponse>>()
      .mockResolvedValueOnce(health())
      .mockRejectedValueOnce(new Error("offline"));
    const { result, rerender } = renderHook(
      ({ token }) => useHealth(token, { fetchHealth, intervalMs: 1000 }),
      { initialProps: { token: 0 } },
    );
    await waitFor(() => expect(result.current?.ready).toBe(true));
    rerender({ token: 1 });
    await waitFor(() => expect(fetchHealth).toHaveBeenCalledTimes(2));
    expect(result.current?.ready).toBe(true);
  });
});
