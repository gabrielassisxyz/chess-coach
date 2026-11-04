import { describe, expect, it } from "vitest";
import type {
  GameEndNotification,
  NotificationContent,
  TurnNotification,
} from "../game/notifications.js";
import { renderNotifications } from "./notify.js";

const FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function turn(ply: number, overrides: Partial<TurnNotification> = {}): TurnNotification {
  return {
    type: "turn",
    game_id: 1,
    ply,
    move_number: Math.ceil(ply / 2),
    player_san: "Nf3",
    player_uci: "g1f3",
    cp_loss: 10,
    classification: "great",
    best_san: "d4",
    engine_reply_san: "Nc6",
    fen: FEN,
    ...overrides,
  };
}

const end: GameEndNotification = {
  type: "game_end",
  game_id: 1,
  result: "0-1",
  termination: "resign",
  player_color: "white",
  fen: FEN,
  costliest_moves: [
    { ply: 3, san: "Nf3", cp_loss: 200, classification: "mistake", best_san: "d4" },
    { ply: 5, san: "Bc4", cp_loss: 200, classification: "mistake", best_san: null },
  ],
};

describe("renderNotifications", () => {
  it("renders one row in full with move label, grade, best move, reply and position", () => {
    const text = renderNotifications([turn(3, { cp_loss: 320, classification: "blunder" })]);
    expect(text).toContain("The student played 2. Nf3 (blunder, cp loss 320; best was d4).");
    expect(text).toContain("The engine replied 2... Nc6.");
    expect(text).toContain(`Position now (FEN): ${FEN}`);
    expect(text).not.toContain("Several updates");
  });

  it("says so when the move ended the game", () => {
    const text = renderNotifications([turn(3, { engine_reply_san: null })]);
    expect(text).toContain("no reply");
  });

  it("folds two rows: the current position, the earlier notable move, the last one in full", () => {
    const text = renderNotifications([
      turn(1, { player_san: "e4", cp_loss: 150, classification: "inaccuracy", best_san: "d4" }),
      turn(3, { cp_loss: 5 }),
    ]);
    expect(text).toContain("Several updates arrived while you were busy (2 in all).");
    expect(text).toContain(`Current position after move 2 (FEN): ${FEN}`);
    expect(text).toContain("- 1. e4 (inaccuracy, cp loss 150; best was d4)");
    expect(text).toContain("The latest move in full:\nThe student played 2. Nf3");
    expect(text.indexOf("Current position")).toBeLessThan(text.indexOf("Earlier moves"));
    expect(text.indexOf("Earlier moves")).toBeLessThan(text.indexOf("The latest move"));
  });

  it("lists only the earlier moves at or above 81 cp among five", () => {
    const text = renderNotifications([
      turn(1, { player_san: "a3", cp_loss: 80 }),
      turn(3, { player_san: "b3", cp_loss: 81, classification: "inaccuracy" }),
      turn(5, { player_san: "c3", cp_loss: 400, classification: "blunder" }),
      turn(7, { player_san: "h3", cp_loss: 0, classification: "best" }),
      turn(9, { player_san: "Nf3", cp_loss: 500, classification: "blunder" }),
    ]);
    expect(text).toContain("(5 in all)");
    expect(text).toContain("- 2. b3 (inaccuracy, cp loss 81");
    expect(text).toContain("- 3. c3 (blunder, cp loss 400");
    expect(text).not.toContain("1. a3");
    expect(text).not.toContain("4. h3");
    expect(text).toContain("The student played 5. Nf3 (blunder, cp loss 500");
  });

  it("states that nothing earlier was notable when every cp loss is under 81", () => {
    const rows = [1, 3, 5, 7, 9].map((ply) => turn(ply, { cp_loss: 80 }));
    const text = renderNotifications(rows);
    expect(text).toContain("No earlier move lost 81 cp or more.");
    expect(text).not.toContain("Earlier moves with");
    expect(text).toContain("The latest move in full:");
  });

  it("renders a resignation alone with the costliest moves in order", () => {
    const text = renderNotifications([end]);
    expect(text).toContain("The game is over: 0-1 by resignation. The student played white.");
    expect(text).toContain("- 2. Nf3 (mistake, cp loss 200; best was d4)");
    expect(text).toContain("- 3. Bc4 (mistake, cp loss 200; no better move was found)");
  });

  it("appends the end of the game after the last move when they arrive together", () => {
    const items: NotificationContent[] = [turn(1), end];
    const text = renderNotifications(items);
    expect(text).toContain("The latest move in full:");
    expect(text.indexOf("The latest move")).toBeLessThan(text.indexOf("The game is over"));
    expect(text).not.toContain("No earlier move");
  });
});
