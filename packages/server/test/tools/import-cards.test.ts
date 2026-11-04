import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  convertCard,
  importCards,
  type UpstreamCard,
} from "../../../../tools/import-chess-rocket-cards.js";
import { type Database, openDatabase } from "../../src/db/open.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/chess-rocket-cards.json", import.meta.url), "utf8"),
) as [UpstreamCard, UpstreamCard, UpstreamCard];

describe("convertCard", () => {
  it("converts SAN to UCI, including a promotion", () => {
    const { card } = convertCard(fixture[2]);
    expect(card.expectedUci).toBe("a2a1n");
    expect(card.playedUci).toBe("e8d7");
    expect(convertCard(fixture[0]).card.expectedUci).toBe("a4c6");
  });

  it("takes the colour from the side to move in the FEN", () => {
    expect(convertCard(fixture[0]).card.studentColor).toBe("white");
    expect(convertCard(fixture[2]).card.studentColor).toBe("black");
  });

  it("copies the scheduling and teaching fields", () => {
    const imported = convertCard(fixture[2]);
    expect(imported).toMatchObject({
      nextReviewAt: "2026-11-05T10:00:00+00:00",
      intervalHours: 24,
      easeFactor: 2.1,
      repetitions: 2,
    });
    expect(imported.card).toMatchObject({
      sourceKind: "teaching",
      sourceGameId: null,
      sourceMoveId: null,
      promptFen: fixture[2].fen,
      cpLoss: 500,
      classification: "mistake",
      explanation: fixture[2].explanation,
      createdAt: fixture[2].created_at,
    });
  });

  it("throws on a SAN that is illegal on the FEN", () => {
    expect(() => convertCard({ ...fixture[0], best_move: "Qh8" })).toThrow();
  });
});

describe("importCards", () => {
  let db: Database;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "import-cards-"));
    db = openDatabase(dir);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const count = (): number =>
    (db.prepare("SELECT count(*) AS n FROM srs_cards").get() as { n: number }).n;

  it("stores the upstream schedule, not the due-now default", () => {
    importCards(db, fixture);
    const row = db.prepare("SELECT * FROM srs_cards WHERE expected_uci = 'a2a1n'").get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      source_kind: "teaching",
      next_review_at: "2026-11-05T10:00:00+00:00",
      interval_hours: 24,
      ease_factor: 2.1,
      repetitions: 2,
      created_at: fixture[2].created_at,
    });
  });

  it("inserts once and skips on the second run", () => {
    expect(importCards(db, fixture)).toEqual({ inserted: 3, skipped: 0, failed: [] });
    expect(importCards(db, fixture)).toEqual({ inserted: 0, skipped: 3, failed: [] });
    expect(count()).toBe(3);
  });

  it("reports a bad SAN by upstream id and keeps going", () => {
    const bad: UpstreamCard = { ...fixture[1], id: "bad-san", best_move: "Qh8" };
    const report = importCards(db, [fixture[0], bad, fixture[2]]);
    expect(report.inserted).toBe(2);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.id).toBe("bad-san");
    expect(count()).toBe(2);
  });
});
