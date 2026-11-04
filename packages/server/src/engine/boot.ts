import { EngineFault } from "./errors.js";
import type { EnginePool } from "./pool.js";

export type EngineBoot = { ok: true } | { ok: false; reason: string; detail: string };

// A binary that cannot be spawned surfaces as an "exited" fault; the health endpoint names that
// case so the UI can tell the owner to install Stockfish rather than show a generic failure.
export async function bootEngines(pool: Pick<EnginePool, "start">): Promise<EngineBoot> {
  try {
    await pool.start();
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const missing = error instanceof EngineFault && error.reason === "exited";
    return { ok: false, reason: missing ? "stockfish_missing" : "stockfish_failed", detail };
  }
}
