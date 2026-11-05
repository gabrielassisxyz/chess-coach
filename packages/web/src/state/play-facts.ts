import { type ProgressResponse, ProgressResponseSchema } from "@chess-coach/shared";
import { useEffect, useState } from "react";
import { type GamesApi, serverGamesApi } from "./games-api.js";

export interface PlayFactsApi {
  getGame: GamesApi["getGame"];
  getProgress(): Promise<ProgressResponse>;
}

export const serverPlayFactsApi: PlayFactsApi = {
  getGame: serverGamesApi.getGame,
  async getProgress() {
    const response = await fetch("/api/progress");
    if (!response.ok) throw new Error(`/api/progress answered ${response.status}`);
    return ProgressResponseSchema.parse(await response.json());
  },
};

export interface PlayFacts {
  engineElo: number | null;
  startedAt: string | null;
  // The latest Chess.com rating the student has; null until one is imported.
  studentRating: number | null;
}

const NO_FACTS: PlayFacts = { engineElo: null, startedAt: null, studentRating: null };

// The live-game activity names neither the engine's strength nor the start time, and the progress
// route is the only place the student's rating lives. Each lookup that fails leaves its field null
// and the screen leaves the label out.
export function usePlayFacts(gameId: number | null, api: PlayFactsApi): PlayFacts {
  const [facts, setFacts] = useState<PlayFacts>(NO_FACTS);

  useEffect(() => {
    if (gameId === null) {
      setFacts(NO_FACTS);
      return;
    }
    let current = true;
    const settle = <T>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);
    Promise.all([settle(api.getGame(gameId)), settle(api.getProgress())]).then(
      ([game, progress]) => {
        if (!current) return;
        setFacts({
          engineElo: game?.target_elo ?? null,
          startedAt: game?.started_at ?? null,
          studentRating: progress?.rating_history.at(-1)?.rating ?? null,
        });
      },
    );
    return () => {
      current = false;
    };
  }, [gameId, api]);

  return facts;
}

// "today" and "yesterday" read better than a date for the game the student is in the middle of.
export function dayWords(iso: string, now: Date = new Date()): string {
  const day = new Date(iso);
  if (Number.isNaN(day.getTime())) return iso.slice(0, 10);
  const startOf = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(day)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return iso.slice(0, 10);
}
