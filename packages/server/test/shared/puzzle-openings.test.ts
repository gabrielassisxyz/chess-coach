import { ClientCommandSchema, openingTagOf } from "@chess-coach/shared";
import { describe, expect, it } from "vitest";

describe("openingTagOf", () => {
  it.each([
    ["Italian Game", "Italian_Game"],
    ["Italian Game: Classical Variation", "Italian_Game_Classical_Variation"],
    ["Queen's Gambit Declined", "Queens_Gambit_Declined"],
    ["King's Pawn Game: McConnell Defense", "Kings_Pawn_Game_McConnell_Defense"],
    ["Caro-Kann Defense", "Caro-Kann_Defense"],
    ["Grünfeld Defense", "Grunfeld_Defense"],
  ])("turns %s into %s", (name, tag) => {
    expect(openingTagOf(name)).toBe(tag);
  });

  it("drops the full stop of a name as the stored tags do", () => {
    expect(openingTagOf("St. George Defense")).toBe("St_George_Defense");
    expect(openingTagOf("Nimzo-Indian Defense: St. Petersburg Variation")).toBe(
      "Nimzo-Indian_Defense_St_Petersburg_Variation",
    );
  });

  it("folds an accent written as a combining mark as it folds a precomposed one", () => {
    expect(openingTagOf("Grünfeld Defense".normalize("NFD"))).toBe("Grunfeld_Defense");
    expect(openingTagOf("Kádas Opening: Kádas Gambit")).toBe("Kadas_Opening_Kadas_Gambit");
  });

  it("drops the commas of a variation's sub-line", () => {
    expect(openingTagOf("Sicilian Defense: Najdorf Variation, English Attack")).toBe(
      "Sicilian_Defense_Najdorf_Variation_English_Attack",
    );
  });
});

describe("start_training with an opening tag", () => {
  const start = (fields: Record<string, unknown>) =>
    ClientCommandSchema.safeParse({ type: "start_training", command_id: "c", ...fields });

  it("accepts a tag of letters, digits, underscores and hyphens, from 1 to 120 characters", () => {
    for (const opening of ["Italian_Game", "Caro-Kann_Defense", "A", "x".repeat(120), "B00_2"]) {
      expect(start({ mode: "puzzles", opening }).success).toBe(true);
    }
  });

  it.each([
    ["an empty tag", ""],
    ["a tag of 121 characters", "x".repeat(121)],
    ["a space", "Italian Game"],
    ["a colon", "Italian_Game:Classical"],
    ["an apostrophe", "Queen's_Gambit"],
    ["a quote meant for the query", "Italian_Game' OR '1'='1"],
    ["an accented letter", "Grünfeld_Defense"],
    ["a percent sign", "Italian_%"],
  ])("refuses %s", (_name, opening) => {
    const parsed = start({ mode: "puzzles", opening });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toContainEqual(["opening"]);
  });

  it("refuses a tag together with a motif, naming the motif", () => {
    const parsed = start({ mode: "puzzles", opening: "Italian_Game", motif: "fork" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toMatchObject([{ path: ["motif"] }]);
  });

  it("keeps the opening drill's family, with its spaces and its bound of 100 characters", () => {
    expect(start({ mode: "openings", color: "white", opening: "Italian Game" }).success).toBe(true);
    expect(start({ mode: "openings", color: "white", opening: "x".repeat(100) }).success).toBe(
      true,
    );
    const long = start({ mode: "openings", color: "white", opening: "x".repeat(101) });
    expect(long.success).toBe(false);
    expect(long.error?.issues).toMatchObject([{ path: ["opening"] }]);
  });

  it("leaves a found drill's opening name to its own rule, punctuation and 120 characters", () => {
    const named = "Sicilian Defense: Najdorf Variation, English Attack";
    expect(start({ mode: "found", scope: "all", opening: named }).success).toBe(true);
    expect(start({ mode: "found", scope: "all", opening: "x".repeat(120) }).success).toBe(true);
    expect(
      start({ mode: "found", scope: "all", opening: "Italian Game", motif: "fork" }).success,
    ).toBe(true);
  });

  it("leaves a motif queue and a queue of no filter as they were", () => {
    expect(start({ mode: "puzzles", motif: "fork" }).success).toBe(true);
    expect(start({ mode: "puzzles" }).success).toBe(true);
  });
});
