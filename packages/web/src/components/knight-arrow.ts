import type { DrawBrush, DrawBrushes, DrawShape } from "@lichess-org/chessground/draw";
import type { Color, Key } from "@lichess-org/chessground/types";

const SQUARE = 100;
const CENTER = SQUARE / 2;
// Chessground's svg.js scales strokeWidth by lineWidth / 64 squares and draws arrowhead markers
// 3 * strokeWidth long by 4 * strokeWidth wide.
const CHESSGROUND_SCALE = SQUARE / 64;
const HEAD_LENGTH_MULTIPLIER = 3;
const HEAD_HALF_WIDTH_MULTIPLIER = 2;
const BRUSH_ATTR_RE = /\bdata-brush="([^"]+)"/;

interface KnightArrowGeometry {
  cornerX: number;
  cornerY: number;
  destX: number;
  destY: number;
  shaftEndX: number;
  shaftEndY: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  strokeWidth: number;
}

function parseSquare(square: Key): [number, number] | null {
  if (square.length !== 2) return null;
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return [file, rank];
}

function knightScreenDelta(orig: Key, dest: Key, orientation: Color): [number, number] | null {
  const from = parseSquare(orig);
  const to = parseSquare(dest);
  if (!from || !to) return null;
  const df = to[0] - from[0];
  const dr = to[1] - from[1];
  if (Math.abs(df) * Math.abs(dr) !== 2) return null;
  return orientation === "white" ? [df, -dr] : [-df, dr];
}

function roundSvg(value: number): number {
  return Number(value.toFixed(4));
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function knightArrowGeometry(
  dxSquares: number,
  dySquares: number,
  lineWidth: number,
): KnightArrowGeometry {
  const destX = CENTER + dxSquares * SQUARE;
  const destY = CENTER + dySquares * SQUARE;
  // Two-square leg first, then the one-square turn to the destination.
  const verticalFirst = Math.abs(dySquares) > Math.abs(dxSquares);
  const cornerX = verticalFirst ? CENTER : destX;
  const cornerY = verticalFirst ? destY : CENTER;

  const ux = Math.sign(destX - cornerX);
  const uy = Math.sign(destY - cornerY);
  const px = -uy;
  const py = ux;

  const strokeWidth = lineWidth * CHESSGROUND_SCALE;
  const headLength = HEAD_LENGTH_MULTIPLIER * strokeWidth;
  const headHalfWidth = HEAD_HALF_WIDTH_MULTIPLIER * strokeWidth;
  const shaftEndX = destX - ux * headLength;
  const shaftEndY = destY - uy * headLength;

  return {
    cornerX,
    cornerY,
    destX,
    destY,
    shaftEndX,
    shaftEndY,
    leftX: shaftEndX + px * headHalfWidth,
    leftY: shaftEndY + py * headHalfWidth,
    rightX: shaftEndX - px * headHalfWidth,
    rightY: shaftEndY - py * headHalfWidth,
    strokeWidth,
  };
}

/** Returns whether two squares are a knight's jump apart. */
export function isKnightArrow(orig: Key, dest?: Key): boolean {
  return dest !== undefined && knightScreenDelta(orig, dest, "white") !== null;
}

/** Builds chessground customSvg markup for a knight move in 100-unit square coordinates. */
export function knightArrowSvgHtml(
  orig: Key,
  dest: Key,
  orientation: Color,
  brushName: string,
  brush: DrawBrush,
  lineWidthOverride?: number,
): string {
  const delta = knightScreenDelta(orig, dest, orientation);
  if (!delta) {
    throw new Error(`Not a knight move: ${orig} -> ${dest}`);
  }
  const geo = knightArrowGeometry(delta[0], delta[1], lineWidthOverride ?? brush.lineWidth);
  const color = escapeAttr(brush.color);
  const name = escapeAttr(brushName);
  return (
    `<g data-brush="${name}" opacity="${roundSvg(brush.opacity)}">` +
    `<path d="M ${CENTER} ${CENTER} L ${geo.cornerX} ${geo.cornerY} L ${roundSvg(geo.shaftEndX)} ${roundSvg(geo.shaftEndY)}" ` +
    `fill="none" stroke="${color}" stroke-width="${roundSvg(geo.strokeWidth)}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>` +
    `<polygon points="${roundSvg(geo.leftX)},${roundSvg(geo.leftY)} ${geo.destX},${geo.destY} ${roundSvg(geo.rightX)},${roundSvg(geo.rightY)}" ` +
    `fill="${color}"/>` +
    `</g>`
  );
}

/** Recovers the logical squares and brush of a converted knight-arrow shape. */
export function logicalKnightShape(shape: DrawShape): DrawShape {
  if (shape.brush || !shape.customSvg) return shape;
  const match = shape.customSvg.html.match(BRUSH_ATTR_RE);
  if (!match?.[1]) return shape;
  const logical: DrawShape = { orig: shape.orig, brush: match[1] };
  if (shape.dest !== undefined) logical.dest = shape.dest;
  if (shape.modifiers !== undefined) logical.modifiers = shape.modifiers;
  if (shape.below !== undefined) logical.below = shape.below;
  if (shape.label !== undefined) logical.label = shape.label;
  return logical;
}

/** Converts a knight-move arrow to an L-shaped customSvg shape without `brush`. */
export function convertKnightArrowShape(
  shape: DrawShape,
  orientation: Color,
  brushes: DrawBrushes,
): DrawShape {
  if (shape.piece || !shape.dest || !isKnightArrow(shape.orig, shape.dest)) {
    return shape;
  }
  if (shape.brush && shape.customSvg) return shape;
  const brushName = shape.brush ?? shape.customSvg?.html.match(BRUSH_ATTR_RE)?.[1];
  if (!brushName) return shape;
  const brush = brushes[brushName];
  if (!brush) return shape;

  const html = knightArrowSvgHtml(
    shape.orig,
    shape.dest,
    orientation,
    brushName,
    brush,
    shape.modifiers?.lineWidth,
  );
  if (shape.customSvg && shape.customSvg.html === html && shape.customSvg.center === "orig") {
    return shape;
  }
  const converted: DrawShape = {
    orig: shape.orig,
    dest: shape.dest,
    customSvg: { html, center: "orig" },
  };
  if (shape.modifiers !== undefined) converted.modifiers = shape.modifiers;
  if (shape.below !== undefined) converted.below = shape.below;
  if (shape.label !== undefined) converted.label = shape.label;
  return converted;
}

function isToggledOffConvertedKnight(
  shape: DrawShape,
  previousShapes: readonly DrawShape[],
): boolean {
  if (!shape.brush || !isKnightArrow(shape.orig, shape.dest)) return false;
  const prior = previousShapes.find((item) => item.orig === shape.orig && item.dest === shape.dest);
  if (!prior || prior.brush) return false;
  return logicalKnightShape(prior).brush === shape.brush;
}

/**
 * Applies chessground's toggle-off rule for converted hand-drawn knight arrows (which lack
 * `brush`, so chessground replaces instead of removing them) and converts newly drawn ones.
 */
export function reconcileHandKnightArrows(
  drawnShapes: readonly DrawShape[],
  previousShapes: readonly DrawShape[],
  orientation: Color,
  brushes: DrawBrushes,
): { shapes: DrawShape[]; changed: boolean } {
  const next: DrawShape[] = [];
  let changed = false;

  for (const shape of drawnShapes) {
    if (isToggledOffConvertedKnight(shape, previousShapes)) {
      changed = true;
      continue;
    }
    const converted = convertKnightArrowShape(shape, orientation, brushes);
    if (converted !== shape) changed = true;
    next.push(converted);
  }

  return { shapes: next, changed };
}
