import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MAX_CLIENT_REPORT_BYTES } from "../src/http/client-log.js";
import { RecordingLog } from "../src/log.js";

function setup() {
  const log = new RecordingLog();
  return { log, app: buildApp({ log }) };
}

const post = (app: ReturnType<typeof buildApp>, payload: string) =>
  app.inject({
    method: "POST",
    url: "/api/client-log",
    headers: { "content-type": "application/json" },
    payload,
  });

describe("POST /api/client-log", () => {
  it("logs a browser report under client.<event>, an error with its stack", async () => {
    const { app, log } = setup();
    const warn = await post(
      app,
      JSON.stringify({
        level: "warn",
        event: "ws_closed",
        message: "closed",
        context: { attempt: 2 },
      }),
    );
    const error = await post(
      app,
      JSON.stringify({
        level: "error",
        event: "window_error",
        message: "boom",
        stack: "Error: boom\n at x",
      }),
    );
    expect([warn.statusCode, error.statusCode]).toEqual([204, 204]);
    expect(log.named("client.ws_closed")[0]).toMatchObject({
      level: "warn",
      fields: { message: "closed", context: { attempt: 2 } },
    });
    expect(log.named("client.window_error")[0]).toMatchObject({
      level: "error",
      fields: { error_name: "ClientError", error_message: "boom", stack: "Error: boom\n at x" },
    });
  });

  it("rejects a report over 16 KiB (413) or malformed (400) and logs nothing for it", async () => {
    const { app, log } = setup();
    const base = { level: "info", event: "big", message: "" };
    const empty = JSON.stringify(base).length;
    const tooBig = JSON.stringify({
      ...base,
      message: "x".repeat(MAX_CLIENT_REPORT_BYTES - empty + 1),
    });
    expect(tooBig.length).toBe(MAX_CLIENT_REPORT_BYTES + 1);
    const fits = JSON.stringify({ ...base, message: "x".repeat(MAX_CLIENT_REPORT_BYTES - empty) });
    const rejected = await Promise.all([
      post(app, tooBig),
      post(app, JSON.stringify({ level: "loud", event: "x", message: "m" })),
      post(app, JSON.stringify({ level: "info", event: "Server.Start", message: "m" })),
      post(app, "{"),
    ]);
    expect(rejected.map((reply) => reply.statusCode)).toEqual([413, 400, 400, 400]);
    expect(log.names().filter((name) => name.startsWith("client."))).toEqual([]);
    expect((await post(app, fits)).statusCode).toBe(204);
  });
});
