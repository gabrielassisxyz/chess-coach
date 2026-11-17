import type { PuzzleRatingPoint } from "@chess-coach/shared";
import { describe, expect, it } from "vitest";
import {
  ratingChartAxis,
  ratingChartGridlines,
  ratingChartPoints,
} from "../src/state/puzzle-rating-api.js";

function pointsFor(ratings: number[]): PuzzleRatingPoint[] {
  const baseMs = Date.parse("2026-06-10T00:00:00Z");
  return ratings.map((rating, index) => {
    const dayMs = baseMs - (ratings.length - 1 - index) * 86_400_000;
    return { day: new Date(dayMs).toISOString().slice(0, 10), rating };
  });
}

function yOf(polyline: string, position: number): number {
  const pair = polyline.split(" ")[position]?.split(",")[1];
  if (pair === undefined) throw new Error("missing point");
  return Number(pair);
}

describe("ratingChartAxis", () => {
  it("widens a flat series by 25 below and above before picking the step", () => {
    expect(ratingChartAxis(pointsFor([1534]))).toEqual([1500, 1525, 1550, 1575]);
    expect(ratingChartPoints(pointsFor([1534]))).toBe("0.0,64.9 600.0,64.9");
    const flat = pointsFor([1534, 1534, 1534, 1534]);
    expect(ratingChartAxis(flat)).toEqual([1500, 1525, 1550, 1575]);
    const line = ratingChartPoints(flat);
    if (line === null) throw new Error("expected polyline");
    for (const pair of line.split(" ")) {
      expect(Number(pair.split(",")[1])).toBeCloseTo(64.9, 1);
    }
  });

  it("covers a span of 80 with five values at step 25", () => {
    const points = pointsFor([1200, 1280]);
    expect(ratingChartAxis(points)).toEqual([1200, 1225, 1250, 1275, 1300]);
    expect(ratingChartPoints(points)).toBe("0.0,112.0 600.0,28.8");
  });

  it("covers a span of 200 with five values at step 50", () => {
    const points = pointsFor([1200, 1400]);
    expect(ratingChartAxis(points)).toEqual([1200, 1250, 1300, 1350, 1400]);
    expect(ratingChartPoints(points)).toBe("0.0,112.0 600.0,8.0");
  });

  it("covers a span of 334 with five values at step 100", () => {
    const points = pointsFor([1200, 1534]);
    expect(ratingChartAxis(points)).toEqual([1200, 1300, 1400, 1500, 1600]);
    const line = ratingChartPoints(points);
    expect(line).toBe("0.0,112.0 600.0,25.2");
    if (line === null) throw new Error("expected polyline");
    expect(yOf(line, 0)).toBeCloseTo(112.0, 1);
    expect(yOf(line, 1)).toBeCloseTo(25.2, 1);
  });

  it("covers a span of 500 with four values at step 200", () => {
    const points = pointsFor([1200, 1700]);
    expect(ratingChartAxis(points)).toEqual([1200, 1400, 1600, 1800]);
    expect(ratingChartPoints(points)).toBe("0.0,112.0 600.0,25.3");
  });

  it("covers a span of 900 with four values at step 500", () => {
    const points = pointsFor([1200, 2100]);
    expect(ratingChartAxis(points)).toEqual([1000, 1500, 2000, 2500]);
    expect(ratingChartPoints(points)).toBe("0.0,98.1 600.0,35.7");
  });

  it("covers a span of 1900 with five values at step 500", () => {
    const points = pointsFor([600, 2500]);
    expect(ratingChartAxis(points)).toEqual([500, 1000, 1500, 2000, 2500]);
    expect(ratingChartPoints(points)).toBe("0.0,106.8 600.0,8.0");
  });

  it("keeps every span between 2 and 5 values", () => {
    const cases: number[][] = [
      [1534],
      [1200, 1280],
      [1200, 1400],
      [1200, 1534],
      [1200, 1700],
      [1200, 2100],
      [600, 2500],
    ];
    for (const ratings of cases) {
      const ticks = ratingChartAxis(pointsFor(ratings));
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(5);
    }
  });

  it("places gridlines at the axis heights the polyline is scaled to", () => {
    const points = pointsFor([1200, 1534]);
    const gridlines = ratingChartGridlines(points);
    expect(gridlines.map((entry) => entry.value)).toEqual([1200, 1300, 1400, 1500, 1600]);
    expect(gridlines.map((entry) => Number(entry.y.toFixed(1)))).toEqual([
      112.0, 86.0, 60.0, 34.0, 8.0,
    ]);
    const line = ratingChartPoints(points);
    if (line === null) throw new Error("expected polyline");
    expect(yOf(line, 0)).toBe(gridlines[0]?.y);
    expect(gridlines[gridlines.length - 1]?.y).toBe(8);
  });
});
