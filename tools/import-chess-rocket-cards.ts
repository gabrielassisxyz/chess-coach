import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { openDatabase } from "../packages/server/src/db/open.js";
import type { Database } from "../packages/server/src/db/open.js";
import { type NewCard, insertCard } from "../packages/server/src/db/srs.js";
import { dataDir } from "../packages/server/src/paths.js";

export interface UpstreamCard {
  id: string;
  fen: string;
  player_move: string;
  best_move: string;
  cp_loss: number;
  classification: string;
  explanation: string;
  created_at: string;
  next_review: string;
  interval_hours: number;
  ease_factor: number;
  repetitions: number;
}

export interface ImportedCard {
  card: NewCard;
  nextReviewAt: string;
  intervalHours: number;
  easeFactor: number;
  repetitions: number;
}

export interface ImportReport {
  inserted: number;
  skipped: number;
  failed: Array<{ id: string; reason: string }>;
}

function sanToUci(fen: string, san: string): string {
  const move = new Chess(fen).move(san);
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

// Throws when a SAN does not parse on the card's FEN; the caller reports it by upstream id.
export function convertCard(upstream: UpstreamCard): ImportedCard {
  const chess = new Chess(upstream.fen);
  return {
    card: {
      sourceKind: "teaching",
      sourceGameId: null,
      sourceMoveId: null,
      promptFen: upstream.fen,
      studentColor: chess.turn() === "w" ? "white" : "black",
      playedUci: sanToUci(upstream.fen, upstream.player_move),
      expectedUci: sanToUci(upstream.fen, upstream.best_move),
      cpLoss: upstream.cp_loss,
      classification: upstream.classification,
      explanation: upstream.explanation,
      createdAt: upstream.created_at,
    },
    nextReviewAt: upstream.next_review,
    intervalHours: upstream.interval_hours,
    easeFactor: upstream.ease_factor,
    repetitions: upstream.repetitions,
  };
}

// A teaching card has no source move, so the table's unique key never catches a repeat run.
function alreadyImported(db: Database, card: NewCard): boolean {
  return (
    db
      .prepare("SELECT 1 FROM srs_cards WHERE prompt_fen = ? AND expected_uci = ?")
      .get(card.promptFen, card.expectedUci) !== undefined
  );
}

// insertCard schedules a new card as due at creation; the upstream schedule is applied after.
function insertImported(db: Database, imported: ImportedCard): void {
  const inserted = insertCard(db, imported.card);
  if (!inserted) throw new Error("insert returned no row");
  db.prepare(
    "UPDATE srs_cards SET next_review_at = ?, interval_hours = ?, ease_factor = ?, repetitions = ? WHERE id = ?",
  ).run(imported.nextReviewAt, imported.intervalHours, imported.easeFactor, imported.repetitions, inserted.id);
}

export function importCards(db: Database, cards: UpstreamCard[]): ImportReport {
  const report: ImportReport = { inserted: 0, skipped: 0, failed: [] };
  for (const upstream of cards) {
    try {
      const imported = convertCard(upstream);
      if (alreadyImported(db, imported.card)) {
        report.skipped += 1;
        continue;
      }
      db.transaction(() => insertImported(db, imported))();
      report.inserted += 1;
    } catch (error) {
      report.failed.push({ id: upstream.id, reason: (error as Error).message });
    }
  }
  return report;
}

function main(): number {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: import-chess-rocket-cards.ts <path-to-srs_cards.json>");
    return 2;
  }
  const cards = JSON.parse(readFileSync(path, "utf8")) as UpstreamCard[];
  const db = openDatabase(dataDir());
  const report = importCards(db, cards);
  db.close();
  for (const failure of report.failed) {
    console.error(`card ${failure.id} skipped: ${failure.reason}`);
  }
  console.log(`${report.inserted} inserted, ${report.skipped} skipped`);
  return report.failed.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
