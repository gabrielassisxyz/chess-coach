// Types shared by server and web. The server is the only writer of these shapes; the web
// renders them. Keeping them here is what lets both sides change together under one tsc run.

export interface HealthResponse {
  status: "ok";
  version: string;
  ready: boolean;
  reason?: string;
}

export * from "./activity.js";
export * from "./events.js";
export * from "./games.js";
export * from "./import.js";
export * from "./progress.js";
