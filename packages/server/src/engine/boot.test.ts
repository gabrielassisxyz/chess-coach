import { describe, expect, it } from "vitest";
import { bootEngines } from "./boot.js";
import { EngineFault } from "./errors.js";

describe("bootEngines", () => {
  it("reports ok when both engines start", async () => {
    expect(await bootEngines({ start: async () => {} })).toEqual({ ok: true });
  });

  it("names a binary that exited at startup as stockfish_missing", async () => {
    const boot = await bootEngines({
      start: async () => {
        throw new EngineFault("exited", "engine process exited");
      },
    });
    expect(boot).toMatchObject({ ok: false, reason: "stockfish_missing" });
  });

  it("keeps other faults apart from a missing binary", async () => {
    const boot = await bootEngines({
      start: async () => {
        throw new EngineFault("timeout", "no answer within 10 ms");
      },
    });
    expect(boot).toMatchObject({ ok: false, reason: "stockfish_failed" });
  });
});
