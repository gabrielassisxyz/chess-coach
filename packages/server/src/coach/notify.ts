import type {
  CostlyMove,
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
export function renderNotifications(items: NotificationContent[]): string {
  const turns = items.filter((item): item is TurnNotification => item.type === "turn");
  const ends = items.filter((item): item is GameEndNotification => item.type === "game_end");
  const questions = items.filter(
    (item): item is PlyQuestionNotification => item.type === "ply_question",
  );
  const last = turns.at(-1);
  if (items.length === 1) {
    const only = items[0] as NotificationContent;
    if (only.type === "ply_question") return renderPlyQuestion(only);
    return only.type === "turn" ? renderTurn(only) : renderEnd(only);
  }
  const parts = [`Several updates arrived while you were busy (${items.length} in all).`];
  if (last) {
    parts.push(`Current position after move ${last.move_number} (FEN): ${last.fen}`);
    if (turns.length > 1) parts.push(renderEarlier(turns.slice(0, -1)));
    parts.push(`The latest move in full:\n${renderTurn(last)}`);
  }
  for (const end of ends) parts.push(renderEnd(end));
  for (const question of questions) parts.push(renderPlyQuestion(question));
  return parts.join("\n\n");
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
export function renderSrsAnswer(answer: SrsAnswerNotification): string {
  const played = answer.answered_san ?? answer.answered_uci;
  const expected = answer.expected_san ?? answer.expected_uci;
  const verdict = answer.correct
    ? `The student answered review card ${answer.card_id} correctly with ${played}.`
    : `The student missed review card ${answer.card_id}: they played ${played} and the expected move was ${expected}.`;
  return `${verdict}\nPosition (FEN): ${answer.prompt_fen}`;
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
}
