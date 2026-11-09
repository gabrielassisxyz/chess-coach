import {
  type ChessComListedGame,
  ChessComListResponseSchema,
  type ImportResult,
  ImportResultSchema,
  type ImportStatus,
  ImportStatusSchema,
} from "@chess-coach/shared";

export interface ImportApi {
  listChessCom(username: string, from: string, to: string): Promise<ChessComListedGame[]>;
  importChessCom(username: string, uuids: string[]): Promise<ImportResult>;
  /** Imports every finished standard game of the account in the months, in one step. */
  importLichess(username: string, from: string, to: string): Promise<ImportResult>;
  importPgn(pgn: string, studentColor: "white" | "black" | null): Promise<ImportResult>;
  status(): Promise<ImportStatus>;
}

async function requestJson(url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (json as { message?: unknown }).message;
    throw new Error(typeof message === "string" ? message : `${url} answered ${response.status}`);
  }
  return json;
}

export const serverImportApi: ImportApi = {
  async listChessCom(username, from, to) {
    const json = await requestJson("/api/import/chesscom/list", { username, from, to });
    return ChessComListResponseSchema.parse(json).games;
  },
  async importChessCom(username, uuids) {
    return ImportResultSchema.parse(await requestJson("/api/import/chesscom", { username, uuids }));
  },
  async importLichess(username, from, to) {
    return ImportResultSchema.parse(
      await requestJson("/api/import/lichess", { username, from, to }),
    );
  },
  async importPgn(pgn, studentColor) {
    const body = studentColor ? { pgn, student_color: studentColor } : { pgn };
    return ImportResultSchema.parse(await requestJson("/api/import/pgn", body));
  },
  async status() {
    return ImportStatusSchema.parse(await requestJson("/api/import/status"));
  },
};
