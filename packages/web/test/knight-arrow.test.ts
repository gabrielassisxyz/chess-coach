import type { DrawBrushes, DrawShape } from "@lichess-org/chessground/draw";
import { describe, expect, it } from "vitest";
import {
  convertKnightArrowShape,
  isKnightArrow,
  logicalKnightShape,
  reconcileHandKnightArrows,
} from "../src/components/knight-arrow.js";

const TEST_BRUSHES: DrawBrushes = {
  green: { key: "g", color: "#5ba66b", opacity: 0.9, lineWidth: 10 },
  blue: { key: "b", color: "#4b82d1", opacity: 0.8, lineWidth: 8 },
  yellow: { key: "y", color: "#d6a62a", opacity: 0.7, lineWidth: 7 },
  red: { key: "r", color: "#c95151", opacity: 0.5, lineWidth: 6 },
  paleBlue: { key: "pb", color: "#4b82d1", opacity: 0.4, lineWidth: 5 },
};

function parseSvg(html: string) {
  const wrapper = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  wrapper.innerHTML = html;
  const group = wrapper.querySelector("g");
  const path = wrapper.querySelector("path");
  const polygon = wrapper.querySelector("polygon");
  const pathPoints = (path?.getAttribute("d") ?? "")
    .trim()
    .split(/[ML]\s*/)
    .filter(Boolean)
    .map((pair) => pair.trim().split(/\s+/).map(Number) as [number, number]);
  const headPoints = (polygon?.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number) as [number, number]);
  return { group, path, polygon, pathPoints, headPoints };
}

describe("isKnightArrow", () => {
  it("recognises every 2-by-1 jump and rejects straight, diagonal, and circle shapes", () => {
    expect(isKnightArrow("g1", "f3")).toBe(true);
    expect(isKnightArrow("b8", "c6")).toBe(true);
    expect(isKnightArrow("e4", "f6")).toBe(true);
    expect(isKnightArrow("b1", "d2")).toBe(true);
    expect(isKnightArrow("e4", "g5")).toBe(true);

    expect(isKnightArrow("e2", "e4")).toBe(false);
    expect(isKnightArrow("c1", "f4")).toBe(false);
    expect(isKnightArrow("e4", undefined)).toBe(false);
    expect(isKnightArrow("e4", "e4")).toBe(false);
  });
});

describe("convertKnightArrowShape", () => {
  it.each([
    {
      label: "g1 to f3 (corner g3: two up, one left)",
      orig: "g1" as const,
      dest: "f3" as const,
      corner: [50, -150],
      tip: [-50, -150],
    },
    {
      label: "b8 to c6 (corner b6: two down, one right)",
      orig: "b8" as const,
      dest: "c6" as const,
      corner: [50, 250],
      tip: [150, 250],
    },
    {
      label: "e4 to f6 (corner e6: two up, one right)",
      orig: "e4" as const,
      dest: "f6" as const,
      corner: [50, -150],
      tip: [150, -150],
    },
    {
      label: "b1 to d2 (corner d1: two right, one up)",
      orig: "b1" as const,
      dest: "d2" as const,
      corner: [250, 50],
      tip: [250, -50],
    },
  ])(
    "draws $label as customSvg with no brush when oriented to white",
    ({ orig, dest, corner, tip }) => {
      const converted = convertKnightArrowShape(
        { orig, dest, brush: "green" },
        "white",
        TEST_BRUSHES,
      );
      expect(converted.orig).toBe(orig);
      expect(converted.dest).toBe(dest);
      expect(converted.brush).toBeUndefined();
      expect(converted.customSvg?.center).toBe("orig");

      const parsed = parseSvg(converted.customSvg?.html ?? "");
      expect(parsed.group?.getAttribute("opacity")).toBe("0.9");
      expect(parsed.path?.getAttribute("stroke")).toBe("#5ba66b");
      expect(parsed.path?.getAttribute("stroke-width")).toBe("15.625");
      expect(parsed.polygon?.getAttribute("fill")).toBe("#5ba66b");
      expect(parsed.pathPoints[0]).toEqual([50, 50]);
      expect(parsed.pathPoints[1]).toEqual(corner);
      expect(parsed.headPoints[1]).toEqual(tip);
    },
  );

  it("mirrors g1->f3, b8->c6, e4->f6 and b1->d2 when oriented to black", () => {
    const cases = [
      { orig: "g1" as const, dest: "f3" as const, corner: [50, 250], tip: [150, 250] },
      { orig: "b8" as const, dest: "c6" as const, corner: [50, -150], tip: [-50, -150] },
      { orig: "e4" as const, dest: "f6" as const, corner: [50, 250], tip: [-50, 250] },
      { orig: "b1" as const, dest: "d2" as const, corner: [-150, 50], tip: [-150, 150] },
    ];
    for (const item of cases) {
      const white = convertKnightArrowShape(
        { orig: item.orig, dest: item.dest, brush: "blue" },
        "white",
        TEST_BRUSHES,
      );
      const black = convertKnightArrowShape(
        { orig: item.orig, dest: item.dest, brush: "blue" },
        "black",
        TEST_BRUSHES,
      );
      const whiteSvg = parseSvg(white.customSvg?.html ?? "");
      const blackSvg = parseSvg(black.customSvg?.html ?? "");
      expect(blackSvg.pathPoints[1]).toEqual(item.corner);
      expect(blackSvg.headPoints[1]).toEqual(item.tip);
      expect(blackSvg.pathPoints).toEqual(whiteSvg.pathPoints.map(([x, y]) => [100 - x, 100 - y]));
      expect(blackSvg.headPoints).toEqual(whiteSvg.headPoints.map(([x, y]) => [100 - x, 100 - y]));
    }
  });

  it("bakes each brush colour, opacity, and scaled line width into the svg", () => {
    for (const [name, def] of Object.entries(TEST_BRUSHES)) {
      const converted = convertKnightArrowShape(
        { orig: "g1", dest: "f3", brush: name },
        "white",
        TEST_BRUSHES,
      );
      const parsed = parseSvg(converted.customSvg?.html ?? "");
      expect(parsed.group?.getAttribute("opacity")).toBe(String(def.opacity));
      expect(parsed.path?.getAttribute("stroke")).toBe(def.color);
      expect(parsed.path?.getAttribute("stroke-width")).toBe(String((def.lineWidth * 100) / 64));
      expect(parsed.polygon?.getAttribute("fill")).toBe(def.color);
    }
  });

  it("leaves straight arrows, diagonals, circles, and external customSvgs untouched", () => {
    const shapes: DrawShape[] = [
      { orig: "e2", dest: "e4", brush: "green" },
      { orig: "c1", dest: "f4", brush: "blue" },
      { orig: "e4", brush: "red" },
      { orig: "g1", dest: "f3", customSvg: { html: "<circle cx='50' cy='50' r='10'/>" } },
    ];
    for (const shape of shapes) {
      expect(convertKnightArrowShape(shape, "white", TEST_BRUSHES)).toBe(shape);
    }
  });
});

describe("logicalKnightShape", () => {
  it("recovers the original squares and brush from a converted knight arrow", () => {
    const converted = convertKnightArrowShape(
      { orig: "g8", dest: "f6", brush: "red" },
      "white",
      TEST_BRUSHES,
    );
    expect(logicalKnightShape(converted)).toEqual({ orig: "g8", dest: "f6", brush: "red" });
  });

  it("returns non-converted shapes as-is", () => {
    const straight: DrawShape = { orig: "e2", dest: "e4", brush: "green" };
    expect(logicalKnightShape(straight)).toBe(straight);
  });
});

describe("reconcileHandKnightArrows", () => {
  it("converts a new draw, toggles off on repeat with the same colour, and replaces on a new colour", () => {
    const first = reconcileHandKnightArrows(
      [{ orig: "g1", dest: "f3", brush: "green" }],
      [],
      "white",
      TEST_BRUSHES,
    );
    expect(first.changed).toBe(true);
    expect(first.shapes).toHaveLength(1);
    expect(first.shapes[0]?.brush).toBeUndefined();
    expect(logicalKnightShape(first.shapes[0] as DrawShape)).toEqual({
      orig: "g1",
      dest: "f3",
      brush: "green",
    });

    // Drawing the same knight arrow with the same colour causes chessground to pass it again as
    // a newly pushed shape because the existing converted one had no brush.
    const toggledOff = reconcileHandKnightArrows(
      [{ orig: "g1", dest: "f3", brush: "green" }],
      first.shapes,
      "white",
      TEST_BRUSHES,
    );
    expect(toggledOff).toEqual({ shapes: [], changed: true });

    // Drawing the same knight arrow with a different colour replaces it rather than removing it.
    const recoloured = reconcileHandKnightArrows(
      [{ orig: "g1", dest: "f3", brush: "red" }],
      first.shapes,
      "white",
      TEST_BRUSHES,
    );
    expect(recoloured.changed).toBe(true);
    expect(recoloured.shapes).toHaveLength(1);
    expect(logicalKnightShape(recoloured.shapes[0] as DrawShape)).toEqual({
      orig: "g1",
      dest: "f3",
      brush: "red",
    });
  });

  it("re-renders an already-converted knight arrow when orientation flips", () => {
    const white = reconcileHandKnightArrows(
      [{ orig: "g1", dest: "f3", brush: "green" }],
      [],
      "white",
      TEST_BRUSHES,
    );
    const flipped = reconcileHandKnightArrows(white.shapes, white.shapes, "black", TEST_BRUSHES);
    expect(flipped.changed).toBe(true);
    expect(parseSvg(flipped.shapes[0]?.customSvg?.html ?? "").headPoints[1]).toEqual([150, 250]);
  });
});
