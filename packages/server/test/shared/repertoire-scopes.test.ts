import {
  FOUND_DRILL_SCOPES,
  FoundDrillScopeSchema,
  REPERTOIRE_SCOPES,
  RepertoireScopeCountsSchema,
  RepertoireScopeSchema,
} from "@chess-coach/shared";
import { describe, expect, it } from "vitest";

describe("the scopes of a line drill", () => {
  it("are the three it always had and most missed", () => {
    expect(REPERTOIRE_SCOPES).toHaveLength(4);
    expect([...REPERTOIRE_SCOPES].sort()).toEqual(["all", "due", "missed", "recommended"]);
    for (const scope of REPERTOIRE_SCOPES) {
      expect(RepertoireScopeSchema.safeParse(scope).success).toBe(true);
    }
    expect(RepertoireScopeSchema.safeParse("weekly").success).toBe(false);
  });

  it("leave the drill of positions from the games with its own three", () => {
    expect([...FOUND_DRILL_SCOPES].sort()).toEqual(["all", "due", "recommended"]);
    expect(FoundDrillScopeSchema.safeParse("due").success).toBe(true);
    expect(FoundDrillScopeSchema.safeParse("missed").success).toBe(false);
  });
});

describe("the counts a line drill offers", () => {
  const counts = { recommended: 5, due: 9, all: 39 };

  it("hold a most missed count that is optional", () => {
    expect(RepertoireScopeCountsSchema.parse(counts)).toEqual(counts);
    expect(RepertoireScopeCountsSchema.parse({ ...counts, missed: 4 })).toEqual({
      ...counts,
      missed: 4,
    });
  });

  it("take a whole number of 0 or more for it, and nothing else", () => {
    expect(RepertoireScopeCountsSchema.safeParse({ ...counts, missed: 0 }).success).toBe(true);
    for (const missed of [-1, 1.5, "3", null]) {
      expect(RepertoireScopeCountsSchema.safeParse({ ...counts, missed }).success).toBe(false);
    }
  });
});
