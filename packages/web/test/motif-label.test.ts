// Tests the stored motif values into the words the student reads.
import { describe, expect, it } from "vitest";
import { motifLabel } from "../src/state/practice.js";

describe("motifLabel", () => {
  it("turns underscores into spaces with a capital first letter", () => {
    expect(motifLabel("back_rank_mate")).toBe("Back rank mate");
  });

  it("humanises the opening trap motif", () => {
    expect(motifLabel("opening_trap")).toBe("Opening trap");
  });

  it("turns hyphens into spaces with a capital first letter", () => {
    expect(motifLabel("opening-white")).toBe("Opening white");
  });
});
