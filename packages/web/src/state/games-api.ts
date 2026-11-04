import {
  type GameDetail,
  GameDetailResponseSchema,
  GameListResponseSchema,
  type GameSummary,
} from "@chess-coach/shared";

export interface GamesApi {
  listGames(): Promise<GameSummary[]>;
  getGame(id: number): Promise<GameDetail>;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

export const serverGamesApi: GamesApi = {
  async listGames() {
    return GameListResponseSchema.parse(await getJson("/api/games")).games;
  },
  async getGame(id) {
    return GameDetailResponseSchema.parse(await getJson(`/api/games/${id}`)).game;
  },
};
