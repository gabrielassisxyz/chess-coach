import { describe, expect, it } from "vitest";
import { assertSubscriptionAuth } from "../../src/coach/auth.js";

describe("assertSubscriptionAuth", () => {
  it("accepts an environment with no API key", () => {
    expect(() => assertSubscriptionAuth({})).not.toThrow();
  });

  it.each(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"])(
    "refuses when %s is set and names it",
    (name) => {
      expect(() => assertSubscriptionAuth({ [name]: "fake" })).toThrow(name);
    },
  );
});
