import type { HealthResponse } from "@chess-coach/shared";

export interface ServiceNotice {
  reason: "stockfish_missing" | "engine_fault";
  message: string;
}

const MESSAGES: Record<ServiceNotice["reason"], string> = {
  stockfish_missing:
    "Stockfish was not found, so there is no engine to play against. Install it (for example `sudo pacman -S stockfish` or `sudo apt install stockfish`) or set STOCKFISH_PATH, then restart the server.",
  engine_fault:
    "The engine stopped responding during a turn. Restart the server: the interrupted move is finished on the next start.",
};

// Only the two reasons the player can act on are shown; a coach that is still starting is not a fault.
export function serviceNotice(health: HealthResponse | null): ServiceNotice | null {
  if (!health || health.ready) return null;
  if (health.reason === "stockfish_missing" || health.reason === "engine_fault") {
    return { reason: health.reason, message: MESSAGES[health.reason] };
  }
  return null;
}
