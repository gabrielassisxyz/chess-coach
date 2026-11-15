import { describe, expect, it } from "vitest";
import {
  EXTRA_PUZZLE_THEMES,
  isGoalOrLengthTheme,
  PUZZLE_THEME_GROUPS,
  PUZZLE_THEMES,
  puzzleThemeInfo,
} from "./puzzle-themes.js";

describe("puzzle themes catalogue", () => {
  it("lists all 54 themes across the 6 groups in prototype order with unique Lichess keys", () => {
    expect(PUZZLE_THEMES).toHaveLength(54);

    const groupsSeen = PUZZLE_THEMES.map((entry) => entry.group).filter(
      (group, index, all) => index === 0 || all[index - 1] !== group,
    );
    expect(groupsSeen).toEqual([...PUZZLE_THEME_GROUPS]);
    expect(PUZZLE_THEME_GROUPS).toHaveLength(6);

    const keys = PUZZLE_THEMES.map((entry) => entry.theme);
    expect(new Set(keys).size).toBe(54);
  });

  it("uses Lichess keys for Mate in 4+ and odd names, and exposes Checkmate for mate", () => {
    expect(puzzleThemeInfo("mateIn4")).toEqual({
      name: "Mate in 4+",
      description: "A long mating sequence.",
    });
    expect(puzzleThemeInfo("capturingDefender")?.name).toBe("Capture the defender");
    expect(puzzleThemeInfo("queenRookEndgame")?.name).toBe("Queen and rook");
    expect(puzzleThemeInfo("underPromotion")?.name).toBe("Underpromotion");
    expect(puzzleThemeInfo("xRayAttack")?.name).toBe("X-ray");
    expect(puzzleThemeInfo("anastasiaMate")?.name).toBe("Anastasia's mate");

    expect(EXTRA_PUZZLE_THEMES.mate).toEqual({
      name: "Checkmate",
      description: "Find the forcing line that ends the game.",
    });
    expect(puzzleThemeInfo("mate")).toEqual(EXTRA_PUZZLE_THEMES.mate);
  });

  it("identifies the Goal and length themes that stay unranked", () => {
    expect(isGoalOrLengthTheme("short")).toBe(true);
    expect(isGoalOrLengthTheme("crushing")).toBe(true);
    expect(isGoalOrLengthTheme("fork")).toBe(false);
    expect(isGoalOrLengthTheme("mate")).toBe(false);
  });
});
