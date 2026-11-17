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

const RATING_AXIS_STEPS = [25, 50, 100, 200, 500] as const;

export function ratingChartAxis(points: readonly PuzzleRatingPoint[]): number[] {
  if (points.length === 0) return [];
  const ratings = points.map((point) => point.rating);
  const min = Math.min(...ratings);
  const max = Math.max(...ratings);
  const lowTarget = min === max ? min - 25 : min;
  const highTarget = min === max ? max + 25 : max;
  for (const step of RATING_AXIS_STEPS) {
    const low = Math.floor(lowTarget / step) * step;
    const high = Math.ceil(highTarget / step) * step;
    const count = Math.round((high - low) / step) + 1;
    if (count <= 5) {
      const ticks: number[] = [];
      for (let value = low; value <= high; value += step) ticks.push(value);
      return ticks;
    }
  }
  const low = Math.floor(lowTarget / 500) * 500;
  const high = Math.ceil(highTarget / 500) * 500;
  const ticks: number[] = [];
  for (let value = low; value <= high; value += 500) ticks.push(value);
  return ticks;
}

export function ratingChartAxisY(
  rating: number,
  low: number,
  high: number,
  height = CHART_HEIGHT,
  pad = CHART_PAD,
): number {
  const span = high - low;
  if (span === 0) return height / 2;
  const innerHeight = height - pad * 2;
  return pad + (1 - (rating - low) / span) * innerHeight;
}

export function ratingChartGridlines(
  points: readonly PuzzleRatingPoint[],
  height = CHART_HEIGHT,
  pad = CHART_PAD,
): { value: number; y: number }[] {
  const ticks = ratingChartAxis(points);
  if (ticks.length === 0) return [];
  const low = ticks[0] as number;
  const high = ticks[ticks.length - 1] as number;
  return ticks.map((value) => ({ value, y: ratingChartAxisY(value, low, high, height, pad) }));
}

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

// Polyline coordinates for the Dashboard chart SVG, scaled to the Y axis range.
// A single-day series draws a flat line at the height of its rating on that axis.
export function ratingChartPoints(
  points: readonly PuzzleRatingPoint[],
  width = CHART_WIDTH,
  height = CHART_HEIGHT,
  pad = CHART_PAD,
): string | null {
  if (points.length === 0) return null;
  const ticks = ratingChartAxis(points);
  if (ticks.length === 0) return null;
  const low = ticks[0] as number;
  const high = ticks[ticks.length - 1] as number;
  if (points.length === 1) {
    const rating = (points[0] as PuzzleRatingPoint).rating;
    const y = ratingChartAxisY(rating, low, high, height, pad);
    return `0.0,${y.toFixed(1)} ${width.toFixed(1)},${y.toFixed(1)}`;
  }
  return points
    .map((point, index) => {
      const x = ((index / (points.length - 1)) * width).toFixed(1);
      const y = ratingChartAxisY(point.rating, low, high, height, pad).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");
}
