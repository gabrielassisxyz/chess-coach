import {
  type FoundPosition,
  listFoundPositionsLackingNote,
  setFoundNote,
} from "../db/found-positions.js";
import { listMoves, type MoveRecord, type PlayerColor } from "../db/games.js";
import type { Database } from "../db/open.js";
import { type Log, silentLog } from "../log.js";
import { sanFor } from "../srs/cards.js";
import type { PositionPhase } from "./game-phase.js";
import {
  evaluationText,
  IDEA_ATTEMPTS,
  type IdeaMove,
  type IdeaSession,
  ideaRejection,
  LOGGED_TEXT_CHARS,
  MAX_IDEA_CHARS,
  numberedMoves,
  tidy,
} from "./repertoire-ideas.js";

export interface FoundNotesResult {
  /** Listed positions that had no note when the run began. */
  considered: number;
  /** Notes stored. */
  generated: number;
  /** Texts the check refused; a position that failed both tries adds two. */
  rejected: number;
  /** Positions left without a note after the retry; a rerun tries them again. */
  empty: number;
}

/** Everything a position's note is written from, and nothing else. */
export interface FoundNoteTarget {
  id: string;
  fen: string;
  /** The student's colour, which is also the side to move. */
  color: PlayerColor;
  phase: PositionPhase;
  /** The shown game's moves before the student's move there, in SAN; empty once the game is gone. */
  line: string[];
  /** Every move the position accepts, the best first; the note explains the first. */
  accepted: IdeaMove[];
  /** The engine's evaluation with best play, in centipawns from White's side; null when ungraded. */
  evalCp: number | null;
  /** The student's move in the shown game; set only for a position found from a mistake. */
  played: { san: string; classification: string | null } | null;
}

// The note is read after the answer, under a title that already names the move, so a text that
// names it or any other accepted move, or the square one of them goes to, adds nothing and goes.
export function foundNoteRejection(text: string, accepted: readonly IdeaMove[]): string | null {
  for (const move of accepted) {
    const refusal = ideaRejection(text, move);
    if (refusal !== null) return refusal;
  }
  return null;
}

export const FOUND_NOTE_SYSTEM_PROMPT = [
  "You write the note shown to a chess student right after they answer one position taken from",
  "their own games. The student plays the side to move; the note says why the best move is played",
  "there, so that the next time they meet the position they find it themselves.",
  "",
  "State the idea: the plan the move serves, the piece or square it pressures, the weakness it",
  "targets or the problem it prevents. Write for a club player rated about 1200, in plain words.",
  "",
  "Rules:",
  "- Never write the move, its algebraic notation or the square the piece moves to.",
  "- If the student's own move in that game is given, use it only to see what they missed, and do",
  "  not write it either.",
  `- At most ${MAX_IDEA_CHARS} characters: one or two sentences, no markdown, no quotation marks.`,
  "- Claim only what the position supports. The evaluation is there to keep you honest about how",
  "  good the position is: do not quote it, and do not call the position better or worse than it says.",
  "- Answer with the note and nothing else.",
].join("\n");

const whiteViewOf = (studentViewCp: number, color: PlayerColor): number =>
  color === "white" ? studentViewCp : -studentViewCp;

// The shown game is the one whose move at `ply` was played from this position, so that row holds
// the grading of it. A game with no such row, as one that ended on the opponent's move, grades nothing.
function studentMoveOf(position: FoundPosition, moves: readonly MoveRecord[]): MoveRecord | null {
  const move = moves.find((candidate) => candidate.ply === position.ply);
  return move?.isPlayer ? move : null;
}

export function foundNoteTargetOf(
  position: FoundPosition,
  moves: readonly MoveRecord[],
): FoundNoteTarget {
  const studentMove = studentMoveOf(position, moves);
  const evalBefore = studentMove?.evalBeforeCp ?? null;
  return {
    id: position.id,
    fen: position.fen,
    color: position.color,
    phase: position.phase,
    line: moves.filter((move) => move.ply < position.ply).map((move) => move.san),
    accepted: position.acceptedUci.map((uci) => ({
      san: sanFor(position.fen, uci) ?? uci,
      uci,
    })),
    evalCp: evalBefore === null ? null : whiteViewOf(evalBefore, position.color),
    played:
      position.fromMistake && studentMove
        ? { san: studentMove.san, classification: studentMove.classification }
        : null,
  };
}

// `5.Bc4` for White and `5...Nf6` for Black, the move number being the position's own.
function numberedMove(fen: string, san: string): string {
  const [, side, , , , fullmove] = fen.split(" ");
  return `${fullmove}${side === "b" ? "..." : "."}${san}`;
}

/** Everything the text is written from: no move after the position and no other accepted move. */
export function foundNotePrompt(target: FoundNoteTarget, refusal: string | null): string {
  const best = target.accepted[0] as IdeaMove;
  const lines = [
    `Position (FEN): ${target.fen}`,
    `Side to move: ${target.color === "white" ? "White" : "Black"}`,
    `Phase: ${target.phase}`,
    `Moves so far in the game shown: ${target.line.length > 0 ? numberedMoves(target.line) : "not available"}`,
    `Move to explain: ${numberedMove(target.fen, best.san)}`,
  ];
  if (target.evalCp !== null) {
    lines.push(`Engine evaluation with best play: ${evaluationText(target.evalCp)}`);
  }
  if (target.played) {
    const rated = target.played.classification
      ? `, which the engine rated a ${target.played.classification}`
      : "";
    lines.push(
      `The student played ${numberedMove(target.fen, target.played.san)} here in that game${rated}`,
    );
  }
  if (refusal)
    lines.push("", `Your last note was refused because ${refusal}. Write a different one.`);
  return lines.join("\n");
}

async function writeOneNote(
  session: IdeaSession,
  target: FoundNoteTarget,
  log: Log,
): Promise<{ text: string | null; rejected: number }> {
  let refusal: string | null = null;
  let rejected = 0;
  for (let attempt = 1; attempt <= IDEA_ATTEMPTS; attempt += 1) {
    const text = tidy(await session.write(foundNotePrompt(target, refusal)));
    refusal = foundNoteRejection(text, target.accepted);
    if (refusal === null) return { text, rejected };
    rejected += 1;
    log.warn("openings.found_note_rejected", {
      position_id: target.id,
      attempt,
      reason: refusal,
      text: text.slice(0, LOGGED_TEXT_CHARS),
    });
  }
  return { text: null, rejected };
}

// Several positions come from one game, so each game's moves are read once per run.
function gameMovesReader(db: Database): (gameId: number) => MoveRecord[] {
  const games = new Map<number, MoveRecord[]>();
  return (gameId) => {
    const stored = games.get(gameId);
    if (stored) return stored;
    const moves = listMoves(db, gameId);
    games.set(gameId, moves);
    return moves;
  };
}

/**
 * Writes the note of every listed position that has none, one position at a time. Each text is
 * stored as it passes the check, so a run that stops partway keeps what it wrote and a rerun picks
 * up the rest; a position whose texts both fail stays empty and is tried again by the next run.
 */
export async function generateFoundNotes(
  db: Database,
  session: IdeaSession,
  log: Log = silentLog,
): Promise<FoundNotesResult> {
  const positions = listFoundPositionsLackingNote(db);
  const result: FoundNotesResult = {
    considered: positions.length,
    generated: 0,
    rejected: 0,
    empty: 0,
  };
  const movesOfGame = gameMovesReader(db);
  for (const position of positions) {
    const target = foundNoteTargetOf(position, movesOfGame(position.gameId));
    const written = await writeOneNote(session, target, log);
    result.rejected += written.rejected;
    if (written.text === null) result.empty += 1;
    else if (setFoundNote(db, position.id, written.text)) result.generated += 1;
  }
  return result;
}
