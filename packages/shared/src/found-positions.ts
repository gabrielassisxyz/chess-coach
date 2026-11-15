import { z } from "zod";

// The positions collected from the student's games, as the From my games page lists them and the
// `found` drill serves them. The accepted moves never travel: the list shows a position, the drill
// grades it on the server.

export const FOUND_POSITION_PHASES = ["opening", "middlegame", "endgame"] as const;
export const FoundPositionPhaseSchema = z.enum(FOUND_POSITION_PHASES);
export type FoundPositionPhase = z.infer<typeof FoundPositionPhaseSchema>;

// A position nothing has rated yet is new; a rated one is due once its review time has come.
export const FoundPositionStateSchema = z.enum(["new", "due", "scheduled"]);
export type FoundPositionState = z.infer<typeof FoundPositionStateSchema>;

// An `own:` id is 20 characters; the cap only keeps a pasted blob out of the queue builder.
export const MAX_FOUND_POSITION_ID_LENGTH = 64;
