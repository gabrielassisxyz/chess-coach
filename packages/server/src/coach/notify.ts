import type {
  CostlyMove,
  DifficultyChangeNotification,
  GameEndNotification,
  NotificationContent,
  PlyQuestionNotification,
  TurnNotification,
} from "../game/notifications.js";

// The first centipawn loss the coach is expected to comment on again after the fact (an inaccuracy).
export const NOTABLE_CP_LOSS = 81;

const TERMINATION_TEXT = {
  checkmate: "by checkmate",
  stalemate: "by stalemate",
  draw: "as a draw",
  resign: "by resignation",
  abort: "aborted",
} as const;

// White plies are "12. Nf3", black plies "12... Nf6".
function label(ply: number, san: string): string {
  const number = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${number}. ${san}` : `${number}... ${san}`;
}

function bestText(best: string | null): string {
  return best === null ? "no better move was found" : `best was ${best}`;
}

function renderTurn(turn: TurnNotification): string {
  const reply =
    turn.engine_reply_san === null
      ? "The game is over, so there was no reply."
      : `The engine replied ${label(turn.ply + 1, turn.engine_reply_san)}.`;
  return [
    `The student played ${label(turn.ply, turn.player_san)} (${turn.classification}, cp loss ${turn.cp_loss}; ${bestText(turn.best_san)}). ${reply}`,
    `Position now (FEN): ${turn.fen}`,
  ].join("\n");
}

function renderEnd(end: GameEndNotification): string {
  const result = end.result ?? "no result";
  const lines = [
    `The game is over: ${result} ${TERMINATION_TEXT[end.termination]}. The student played ${end.player_color}. Final position (FEN): ${end.fen}`,
  ];
  if (end.costliest_moves.length > 0) {
    lines.push("The student's costliest moves, worst first:");
    for (const move of end.costliest_moves) lines.push(costlyLine(move));
    lines.push(
      `The spaced-repetition cards for this game were already created (${end.cards.created} new, ${end.cards.skipped} already existed), so do not call create_srs_cards. Walk through these moves one at a time: for each, call show_position with the position before the move, explain what went wrong and what the better move does, then call explain_card with that move's card id. A move with no card gets the walk-through only.`,
    );
  }
  return lines.join("\n");
}

function costlyLine(move: CostlyMove): string {
  const card = move.card_id === null ? "no card, the loss is too small" : `card id ${move.card_id}`;
  return `- ${label(move.ply, move.san)} (${move.classification}, cp loss ${move.cp_loss}; ${bestText(move.best_san)}); position before (FEN): ${move.fen_before}; ${card}`;
}

function renderEarlier(turns: TurnNotification[]): string {
  const notable = turns.filter((turn) => turn.cp_loss >= NOTABLE_CP_LOSS);
  if (notable.length === 0) return `No earlier move lost ${NOTABLE_CP_LOSS} cp or more.`;
  const lines = notable.map(
    (turn) =>
      `- ${label(turn.ply, turn.player_san)} (${turn.classification}, cp loss ${turn.cp_loss}; ${bestText(turn.best_san)})`,
  );
  return [`Earlier moves with a cp loss of ${NOTABLE_CP_LOSS} or more:`, ...lines].join("\n");
}

/**
 * One message for everything the coach has not seen yet. A single row is rendered in full; several
 * are folded so the coach comments on where the game stands now rather than replaying each move.
 */
export function renderNotifications(items: CoachNotification[]): string {
  const turns = items.filter((item): item is TurnNotification => item.type === "turn");
  const ends = items.filter((item): item is GameEndNotification => item.type === "game_end");
  const questions = items.filter(
    (item): item is PlyQuestionNotification => item.type === "ply_question",
  );
  const last = turns.at(-1);
  if (items.length === 1) {
    const only = items[0] as CoachNotification;
    return renderOne(only);
  }
  const parts = [`Several updates arrived while you were busy (${items.length} in all).`];
  if (last) {
    parts.push(`Current position after move ${last.move_number} (FEN): ${last.fen}`);
    if (turns.length > 1) parts.push(renderEarlier(turns.slice(0, -1)));
    parts.push(`The latest move in full:\n${renderTurn(last)}`);
  }
  for (const end of ends) parts.push(renderEnd(end));
  for (const item of items) if (isTrainingRow(item)) parts.push(renderOne(item));
  for (const item of items) if (item.type === "difficulty_change") parts.push(renderOne(item));
  for (const question of questions) parts.push(renderPlyQuestion(question));
  return parts.join("\n\n");
}

const REASON_TEXT = {
  streak_up: "the student won the last two games",
  streak_down: "the student lost the last two games",
  coach: "the coach changed it",
  student: "the student asked for it",
} as const;

export function renderDifficultyChange(change: DifficultyChangeNotification): string {
  return `The engine level moved from ${change.from_elo} to ${change.to_elo} because ${REASON_TEXT[change.reason]}. Tell the student in a sentence; the next game starts at ${change.to_elo}.`;
}

export function renderPlyQuestion(question: PlyQuestionNotification): string {
  const who = question.is_player ? "the student" : "the engine";
  const grade =
    question.cp_loss === null || question.classification === null
      ? "this move was not graded"
      : `${question.classification}, cp loss ${question.cp_loss}; ${bestText(question.best_san)}`;
  return [
    `The student is reviewing game ${question.game_id} and asks about ${label(question.ply, question.san)}, played by ${who} (${grade}).`,
    `Position before the move (FEN): ${question.fen_before}`,
    "Call show_position with that position, then explain what the move does and what the alternatives were.",
  ].join("\n");
}

export function renderSrsAnswer(answer: SrsAnswerNotification): string {
  const played = answer.answered_san ?? answer.answered_uci;
  const expected = answer.expected_san ?? answer.expected_uci;
  const verdict = answer.correct
    ? `The student answered review card ${answer.card_id} correctly with ${played}.`
    : `The student missed review card ${answer.card_id}: they played ${played} and the expected move was ${expected}.`;
  const lines = [verdict, `Position (FEN): ${answer.prompt_fen}`];
  if (answer.reasoning) lines.push(renderReasoning(answer.reasoning, played, answer.correct));
  return lines.join("\n");
}

const explorationOffset = (atMs: number): string => `+${Math.round(atMs / 1000)}s`;

function exploredLine(event: ExploredEvent): string {
  return `${explorationOffset(event.at_ms)}  ${event.line ?? event.kind}`;
}

// What the student thought before answering, so the coach can name what they never looked at.
function renderReasoning(reasoning: TrainingReasoning, played: string, correct: boolean): string {
  const wrote =
    reasoning.messages.length === 0
      ? ["What the student wrote: nothing"]
      : ["What the student wrote:", ...reasoning.messages.map((text) => `- ${text}`)];
  const explored =
    reasoning.explored.length === 0
      ? ["Explored: nothing"]
      : ["Explored:", ...reasoning.explored.map(exploredLine)];
  return [...wrote, ...explored, `Answer: ${played} (${correct ? "correct" : "wrong"})`].join("\n");
}

/** One step of the student's scratch play; `line` is the whole line after a move, else null. */
export interface ExploredEvent {
  at_ms: number;
  kind: "move" | "undo" | "reset";
  line: string | null;
}

/** What the student typed and tried on the board while an item was open. */
export interface TrainingReasoning {
  messages: string[];
  explored: ExploredEvent[];
}

/** Row content written when the student answers a review card; the coach comments on a miss. */
export interface SrsAnswerNotification {
  type: "srs_answer";
  card_id: number;
  prompt_fen: string;
  answered_uci: string;
  answered_san: string | null;
  expected_uci: string;
  expected_san: string | null;
  correct: boolean;
  reasoning?: TrainingReasoning;
}

/** Row content written when a puzzle ends, solved or failed. */
export interface PuzzleResultNotification {
  type: "puzzle_result";
  puzzle_id: string;
  motif: string;
  difficulty: string;
  fen: string;
  solved: boolean;
  answered_uci: string[];
  expected_uci: string | null;
  expected_san: string | null;
  reasoning?: TrainingReasoning;
}

/** Row content written once when a training queue ends. */
export interface TrainingSummaryNotification {
  type: "training_summary";
  mode: "srs" | "puzzles";
  solved: number;
  failed: number;
}

export type CoachNotification =
  | NotificationContent
  | SrsAnswerNotification
  | PuzzleResultNotification
  | TrainingSummaryNotification;

type TrainingRow = SrsAnswerNotification | PuzzleResultNotification | TrainingSummaryNotification;

function isTrainingRow(item: CoachNotification): item is TrainingRow {
  return (
    item.type === "srs_answer" || item.type === "puzzle_result" || item.type === "training_summary"
  );
}

function renderPuzzleResult(result: PuzzleResultNotification): string {
  const played = result.answered_uci.at(-1) ?? "nothing";
  const lines = result.solved
    ? [`The student solved the ${result.motif} puzzle ${result.puzzle_id} (${result.difficulty}).`]
    : [
        `The student failed the ${result.motif} puzzle ${result.puzzle_id} (${result.difficulty}): they played ${played} and the expected move was ${result.expected_san ?? result.expected_uci ?? "unknown"}.`,
        `Position (FEN): ${result.fen}`,
      ];
  if (result.reasoning) lines.push(renderReasoning(result.reasoning, played, result.solved));
  return lines.join("\n");
}

function renderTrainingSummary(summary: TrainingSummaryNotification): string {
  const what = summary.mode === "srs" ? "review cards" : "puzzles";
  const total = summary.solved + summary.failed;
  return `The training queue is finished: ${summary.solved} of ${total} ${what} solved, ${summary.failed} failed.`;
}

function renderOne(item: CoachNotification): string {
  switch (item.type) {
    case "turn":
      return renderTurn(item);
    case "game_end":
      return renderEnd(item);
    case "ply_question":
      return renderPlyQuestion(item);
    case "srs_answer":
      return renderSrsAnswer(item);
    case "puzzle_result":
      return renderPuzzleResult(item);
    case "training_summary":
      return renderTrainingSummary(item);
    case "difficulty_change":
      return renderDifficultyChange(item);
  }
}
