import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type PuzzleResultNotification,
  renderNotifications,
  type SrsAnswerNotification,
  type TrainingSummaryNotification,
} from "../../src/coach/notify.js";
import { CoachSession } from "../../src/coach/session.js";
import { appendChatMessage } from "../../src/db/chat.js";
import { openDatabase } from "../../src/db/open.js";
import { contentDir } from "../../src/paths.js";
import { FakeSdk } from "../fakes/fake-sdk.js";
import { makeWorld } from "../fakes/fake-world.js";

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const srs: SrsAnswerNotification = {
  type: "srs_answer",
  card_id: 4,
  prompt_fen: FEN,
  answered_uci: "e2e4",
  answered_san: "e4",
  expected_uci: "d2d4",
  expected_san: "d4",
  correct: false,
};
const puzzle: PuzzleResultNotification = {
  type: "puzzle_result",
  puzzle_id: "f1",
  motif: "fork",
  difficulty: "easy",
  fen: FEN,
  solved: false,
  answered_uci: ["e2e4"],
  expected_uci: "d2d4",
  expected_san: "d4",
};
const summary: TrainingSummaryNotification = {
  type: "training_summary",
  mode: "puzzles",
  solved: 7,
  failed: 3,
};

describe("training notifications", () => {
  it("renders each training row type", () => {
    expect(renderNotifications([srs])).toContain("missed review card 4");
    expect(renderNotifications([puzzle])).toContain("failed the fork puzzle f1");
    expect(renderNotifications([{ ...puzzle, solved: true }])).toContain("solved the fork puzzle");
    expect(renderNotifications([summary])).toContain("7 of 10 puzzles solved, 3 failed");
  });

  it("keeps training rows when several arrive at once", () => {
    const text = renderNotifications([srs, puzzle, summary]);
    expect(text).toContain("missed review card 4");
    expect(text).toContain("failed the fork puzzle f1");
    expect(text).toContain("7 of 10 puzzles solved");
  });

  it("hands a pending srs_answer row to the coach when the session flushes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coach-train-"));
    const db = openDatabase(dataDir);
    const sdk = new FakeSdk();
    const session = new CoachSession({
      db,
      query: sdk.query,
      contentDir: contentDir(),
      dataDir,
      world: makeWorld(db).world,
      env: {},
      log: () => {},
    });
    await session.start();
    appendChatMessage(db, session.ensureSessionId(), {
      role: "user",
      kind: "notification",
      contentJson: JSON.stringify(srs),
    });
    session.flushNotifications();
    await vi.waitFor(() => expect(sdk.userTexts).toHaveLength(1));
    expect(sdk.userTexts[0]).toContain("missed review card 4");
    await session.stop();
  });
});
