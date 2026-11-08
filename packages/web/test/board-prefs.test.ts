import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOARD_PREFS_STORAGE_KEY,
  DEFAULT_BOARD_PREFS,
  readBoardPrefs,
} from "../src/state/board-prefs.js";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("board prefs", () => {
  it("starts with coordinates inside, normal animation, both highlights on and no auto-next", () => {
    expect(readBoardPrefs()).toEqual(DEFAULT_BOARD_PREFS);
    expect(DEFAULT_BOARD_PREFS).toEqual({
      coordinates: "inside",
      animation: "normal",
      lastMove: true,
      legalMoves: true,
      autoNext: false,
    });
  });

  it("reads a stored set field by field, keeping the default for anything off the scale", () => {
    window.localStorage.setItem(
      BOARD_PREFS_STORAGE_KEY,
      JSON.stringify({ coordinates: "off", animation: "slow", lastMove: false, autoNext: "yes" }),
    );
    expect(readBoardPrefs()).toEqual({
      coordinates: "off",
      animation: "normal",
      lastMove: false,
      legalMoves: true,
      autoNext: false,
    });
  });

  it("falls back to the defaults on unreadable storage", () => {
    window.localStorage.setItem(BOARD_PREFS_STORAGE_KEY, "{not json");
    expect(readBoardPrefs()).toEqual(DEFAULT_BOARD_PREFS);
  });
});
