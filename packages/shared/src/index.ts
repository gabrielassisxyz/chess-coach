// Types shared by server and web. The server is the only writer of these shapes; the web
// renders them. Keeping them here is what lets both sides change together under one tsc run.

export interface HealthResponse {
  status: "ok";
  version: string;
}
