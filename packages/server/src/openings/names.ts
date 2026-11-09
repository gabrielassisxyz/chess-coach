import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpeningName } from "@chess-coach/shared";
import { positionKey } from "./from-games.js";

/** Where the Lichess openings table lives under the content directory. */
export const OPENING_TABLE_FILE = join("openings", "all.tsv");

const COLUMNS = ["eco", "name", "pgn", "uci", "epd"];

export class OpeningTableError extends Error {}

export interface OpeningNames {
  /** How many positions carry a name. */
  readonly size: number;
  /** The name of one position, whatever its move counters; null when the table has none. */
  ofPosition(fen: string): OpeningName | null;
  /** The name of the last named position of a game, given the position after each ply in order. */
  ofGame(fensAfterEachPly: Iterable<string>): OpeningName | null;
}

// Keyed by position and not by move text: one opening arises from several move orders, and a
// text lookup misses every transposition.
function namesOver(byPosition: ReadonlyMap<string, OpeningName>): OpeningNames {
  const ofPosition = (fen: string): OpeningName | null => byPosition.get(positionKey(fen)) ?? null;
  return {
    size: byPosition.size,
    ofPosition,
    ofGame(fensAfterEachPly) {
      let named: OpeningName | null = null;
      for (const fen of fensAfterEachPly) named = ofPosition(fen) ?? named;
      return named;
    },
  };
}

/** Stands in where no table is loaded: every game stays unnamed. */
export const NO_OPENING_NAMES: OpeningNames = namesOver(new Map());

/**
 * Reads the tab-separated table (eco, name, pgn, uci, epd) the Lichess openings repository builds.
 * A row that is not what the lookup assumes throws with its line, so a bad update fails at boot.
 */
export function parseOpeningTable(text: string, label: string = OPENING_TABLE_FILE): OpeningNames {
  const [header, ...rows] = text.split(/\r?\n/);
  if (header !== COLUMNS.join("\t")) {
    throw new OpeningTableError(`${label}:1: expected the columns ${COLUMNS.join(", ")}`);
  }
  const byPosition = new Map<string, OpeningName>();
  rows.forEach((row, index) => {
    if (row === "") return;
    const line = index + 2;
    const cells = row.split("\t");
    const [eco, name, , , epd] = cells;
    if (cells.length !== COLUMNS.length || !eco || !name || !epd) {
      throw new OpeningTableError(`${label}:${line}: expected ${COLUMNS.length} filled columns`);
    }
    const key = positionKey(epd);
    const named = byPosition.get(key);
    if (named) {
      throw new OpeningTableError(
        `${label}:${line}: ${name} repeats the position of ${named.name}`,
      );
    }
    byPosition.set(key, { eco, name });
  });
  return namesOver(byPosition);
}

export function loadOpeningNames(contentDir: string): OpeningNames {
  const file = join(contentDir, OPENING_TABLE_FILE);
  return parseOpeningTable(readFileSync(file, "utf8"), file);
}
