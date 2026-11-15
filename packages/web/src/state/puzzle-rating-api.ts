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

const CHART_WIDTH = 600;
const CHART_HEIGHT = 120;
const CHART_PAD = 8;

function scaleRatingPoints(
  points: readonly PuzzleRatingPoint[],
  width: number,
  height: number,
  pad: number,
  centerFlat: boolean,
): string {
  if (points.length === 1) {
    const midY = (height / 2).toFixed(1);
    return `0.0,${midY} ${width.toFixed(1)},${midY}`;
  }
  const ratings = points.map((point) => point.rating);
  const min = Math.min(...ratings);
  const max = Math.max(...ratings);
  const span = max - min;
  const innerHeight = height - pad * 2;
  const midY = height / 2;
  return ratings
    .map((rating, index) => {
      const x = ((index / (ratings.length - 1)) * width).toFixed(1);
      const y =
        span === 0 && centerFlat ? midY : pad + (1 - (rating - min) / (span || 1)) * innerHeight;
      return `${x},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function ratingSparklinePoints(points: readonly PuzzleRatingPoint[]): string | null {
  if (points.length < 2) return null;
  return scaleRatingPoints(points, SPARK_WIDTH, SPARK_HEIGHT, SPARK_PAD, false);
}

// Polyline coordinates for the Dashboard chart SVG; a single-day series draws a flat middle line.
export function ratingChartPoints(
  points: readonly PuzzleRatingPoint[],
  width = CHART_WIDTH,
  height = CHART_HEIGHT,
  pad = CHART_PAD,
): string | null {
  if (points.length === 0) return null;
  return scaleRatingPoints(points, width, height, pad, true);
}
