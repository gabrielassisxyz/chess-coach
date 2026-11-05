import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServer } from "../src/hooks/useServer.js";
import {
  type ClientReport,
  fitReport,
  installClientLog,
  postReport,
  setClientReporter,
} from "../src/state/client-log.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";

let reports: ClientReport[];

beforeEach(() => {
  reports = [];
  setClientReporter((report) => reports.push(report));
});

afterEach(() => {
  setClientReporter(() => undefined);
  vi.useRealTimers();
});

describe("postReport", () => {
  it("posts the report as JSON to /api/client-log and cuts long text", async () => {
    const post = vi.fn(async () => new Response(null, { status: 204 }));
    postReport(
      { level: "error", event: "window_error", message: "m".repeat(20_000), stack: "s" },
      post as unknown as typeof fetch,
    );
    expect(post).toHaveBeenCalledTimes(1);
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/client-log");
    expect(init).toMatchObject({ method: "POST", keepalive: true });
    const body = JSON.parse(String(init.body)) as ClientReport;
    expect(body).toMatchObject({ level: "error", event: "window_error", stack: "s" });
    expect("m".repeat(20_000).startsWith(body.message)).toBe(true);
    expect(new TextEncoder().encode(String(init.body)).length).toBeLessThanOrEqual(15 * 1024);
  });

  it("keeps a report with a long message and a long multi-byte stack under the cap", () => {
    const body = fitReport({
      level: "error",
      event: "window_error",
      message: "é".repeat(9000),
      stack: "€\n".repeat(9000),
    });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(15 * 1024);
    const parsed = JSON.parse(body) as ClientReport;
    expect(parsed.message.length).toBeGreaterThan(0);
    expect(parsed.event).toBe("window_error");
  });
});

describe("fitReport", () => {
  it("cuts the longer field first, so a long stack does not eat a short message", () => {
    const body = JSON.parse(
      fitReport({ level: "error", event: "e", message: "what broke", stack: "s".repeat(40_000) }),
    ) as ClientReport;
    expect(body.message).toBe("what broke");
    expect((body.stack ?? "").length).toBeGreaterThan(1000);
  });

  it("keeps a useful stack whole when the message is what is too long", () => {
    const stack = "at frame\n".repeat(200);
    const body = JSON.parse(
      fitReport({ level: "error", event: "e", message: "m".repeat(40_000), stack }),
    ) as ClientReport;
    expect(body.stack).toBe(stack);
    expect(body.message.length).toBeGreaterThan(1000);
  });

  it("replaces a context too large to send, and keeps the message", () => {
    const body = fitReport({
      level: "warn",
      event: "malformed_frame",
      message: "bad frame",
      context: { frame: "x".repeat(20_000) },
    });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(15 * 1024);
    expect(JSON.parse(body)).toMatchObject({
      message: "bad frame",
      context: { dropped: "context too large" },
    });
  });
});

describe("installClientLog", () => {
  it("reports uncaught errors and rejections, and stops after uninstall", () => {
    const target = new EventTarget() as unknown as Window;
    const seen: ClientReport[] = [];
    const uninstall = installClientLog(target, (report) => seen.push(report));
    target.dispatchEvent(new ErrorEvent("error", { error: new Error("render broke"), lineno: 7 }));
    const rejection = Object.assign(new Event("unhandledrejection"), { reason: "socket gone" });
    target.dispatchEvent(rejection);
    uninstall();
    target.dispatchEvent(new ErrorEvent("error", { error: new Error("after") }));
    expect(seen).toMatchObject([
      { level: "error", event: "window_error", message: "render broke", context: { line: 7 } },
      { level: "error", event: "unhandled_rejection", message: "socket gone" },
    ]);
  });
});

describe("useServer reports", () => {
  it("sends error frames, socket drops and the reconnect to the server log", () => {
    vi.useFakeTimers();
    FakeSocket.reset();
    renderHook(() => useServer({ url: "ws://test/api/ws", createSocket: createFakeSocket }));
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "error",
        code: "demo_active",
        message: "only the coach moves pieces in a demo",
        command_id: "c3",
      }),
    );
    act(() => FakeSocket.latest.drop());
    act(() => vi.advanceTimersByTime(600));
    act(() => FakeSocket.latest.open());
    expect(reports).toMatchObject([
      { level: "warn", event: "error_frame", context: { code: "demo_active", command_id: "c3" } },
      { level: "warn", event: "ws_closed", context: { attempt: 1 } },
      { level: "info", event: "ws_reconnected", context: { attempts: 1 } },
    ]);
  });
});
