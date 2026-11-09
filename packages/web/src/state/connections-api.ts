import { type ConnectionsStatus, ConnectionsStatusSchema } from "@chess-coach/shared";

export interface ConnectionsApi {
  get(): Promise<ConnectionsStatus>;
  saveLichessToken(token: string): Promise<ConnectionsStatus>;
  removeLichessToken(): Promise<ConnectionsStatus>;
  saveLichessUsername(username: string): Promise<ConnectionsStatus>;
  removeLichessUsername(): Promise<ConnectionsStatus>;
  saveChessComUsername(username: string): Promise<ConnectionsStatus>;
  removeChessComUsername(): Promise<ConnectionsStatus>;
}

async function request(url: string, method: string, body?: unknown): Promise<ConnectionsStatus> {
  const response = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (json as { message?: unknown }).message;
    throw new Error(typeof message === "string" ? message : "That did not work.");
  }
  return ConnectionsStatusSchema.parse(json);
}

export const serverConnectionsApi: ConnectionsApi = {
  get: () => request("/api/connections", "GET"),
  saveLichessToken: (token) => request("/api/connections/lichess", "PUT", { token }),
  removeLichessToken: () => request("/api/connections/lichess", "DELETE"),
  saveLichessUsername: (username) =>
    request("/api/connections/lichess/username", "PUT", { username }),
  removeLichessUsername: () => request("/api/connections/lichess/username", "DELETE"),
  saveChessComUsername: (username) => request("/api/connections/chesscom", "PUT", { username }),
  removeChessComUsername: () => request("/api/connections/chesscom", "DELETE"),
};
