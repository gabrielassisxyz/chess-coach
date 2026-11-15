import {
  type PuzzleRatingHistoryResponse,
  PuzzleRatingHistoryResponseSchema,
  type PuzzleRatingPoint,
  type PuzzleRatingWindow,
} from "@chess-coach/shared";

export type FetchPuzzleRatingHistory = (
  days: PuzzleRatingWindow,
) => Promise<PuzzleRatingHistoryResponse>;

export const fetchPuzzleRatingHistoryFromServer: FetchPuzzleRatingHistory = async (days) => {
  const response = await fetch(`/api/puzzles/rating/history?days=${encodeURIComponent(days)}`);
  if (!response.ok) {
    throw new Error(`puzzle rating history: ${response.status}`);
  }
  return PuzzleRatingHistoryResponseSchema.parse(await response.json());
};

const SPARK_WIDTH = 200;
const SPARK_HEIGHT = 28;
const SPARK_PAD = 3;

export function ratingSparklinePoints(points: readonly PuzzleRatingPoint[]): string | null {
  if (points.length < 2) return null;
  const ratings = points.map((point) => point.rating);
  const min = Math.min(...ratings);
  const max = Math.max(...ratings);
  const span = max - min || 1;
  const innerHeight = SPARK_HEIGHT - SPARK_PAD * 2;
  return ratings
    .map((rating, index) => {
      const x = ((index / (ratings.length - 1)) * SPARK_WIDTH).toFixed(1);
      const y = (SPARK_PAD + (1 - (rating - min) / span) * innerHeight).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");
}
