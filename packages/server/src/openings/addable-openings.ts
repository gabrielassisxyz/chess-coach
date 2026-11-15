import {
  type AddableOpening,
  type AddableOpeningsResponse,
  openingFamilyOf,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import type { Database } from "../db/open.js";
import {
  listMetOpenings,
  repertoireRebuildCopySql,
  repertoireSetupLine,
} from "../db/repertoires.js";
import { EXPLORER_RATINGS, type ExplorerPosition, gamesOf } from "./explorer-client.js";
import type { OpeningNames } from "./names.js";

/** The two explorer positions a run reads: the parents of every addable root. */
export interface AddableExplorer {
  position(fen: string, ratings?: string): Promise<ExplorerPosition>;
}

export interface AddableCandidate {
  root: string[];
  openingName: string;
  family: string;
}

// Black leaves after 1.e4 with the first move, and after 1.e4 e5 2.Nf3 with the second one. Later
// departures are variations of the Italian Game itself, reached by its own line, so they stay out.
const FIRST_LINE: readonly string[] = ["e4"];
const SECOND_LINE: readonly string[] = ["e4", "e5", "Nf3"];
const FIRST_PATH_SAN = "e5";
const SECOND_PATH_SAN = "Nc6";

// The explorer writes castling as king-takes-rook in UCI, so its moves are matched by playing
// the SAN, the way a reviewed game matches its reply.
function addableUciOfSanAt(fen: string, san: string): string | null {
  try {
    const move = new Chess(fen).move(san);
    return `${move.from}${move.to}${move.promotion ?? ""}`;
  } catch {
    return null;
  }
}

function addableShareOf(position: ExplorerPosition, fen: string, uci: string): number | null {
  const total = gamesOf(position);
  const listed = position.moves.find((move) => addableUciOfSanAt(fen, move.san) === uci);
  return listed && total > 0 ? gamesOf(listed) / total : null;
}

function addableFenOf(line: readonly string[]): string {
  const board = new Chess();
  for (const san of line) board.move(san);
  return board.fen();
}

function compareSan(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// Every legal Black reply at this line that the book names, except the path's own move. A reply
// the book never names is no opening to add a line against, so it stays out.
function departuresOf(
  line: readonly string[],
  names: OpeningNames,
  pathSan: string,
): AddableCandidate[] {
  const before = addableFenOf(line);
  const found: AddableCandidate[] = [];
  for (const san of new Chess(before).moves()) {
    if (san === pathSan) continue;
    const after = new Chess(before);
    after.move(san);
    const named = names.ofPosition(after.fen());
    if (!named) continue;
    const family = openingFamilyOf(named.name);
    if (!family) continue;
    found.push({ root: [...line, san], openingName: named.name, family });
  }
  return found;
}

/**
 * One entry per book family Black can leave the 1.e4 path with: the first moves other than e5
 * and the second moves other than Nc6 after 1.e4 e5 2.Nf3. A family reached by several moves
 * keeps its alphabetically first one, so the choice never depends on explorer data.
 */
export function addableCandidates(names: OpeningNames): AddableCandidate[] {
  const departures = [
    ...departuresOf(FIRST_LINE, names, FIRST_PATH_SAN),
    ...departuresOf(SECOND_LINE, names, SECOND_PATH_SAN),
  ].sort((a, b) => compareSan(a.root[a.root.length - 1] ?? "", b.root[b.root.length - 1] ?? ""));
  const byFamily = new Map<string, AddableCandidate>();
  for (const candidate of departures) {
    if (!byFamily.has(candidate.family)) byFamily.set(candidate.family, candidate);
  }
  return [...byFamily.values()];
}

// The oldest White unit whose setup rows are this root: the line already built for it, if any.
// A unit stores its root the way the board writes it, so the match is on the SAN list.
function addableUnitsByRoot(db: Database): Map<string, number> {
  const ids = db
    .prepare(
      `SELECT id FROM repertoires
       WHERE side = 'white' AND NOT ${repertoireRebuildCopySql("group_name")} ORDER BY id`,
    )
    .all() as Array<{ id: number }>;
  const units = new Map<string, number>();
  for (const { id } of ids) {
    const key = repertoireSetupLine(db, id).join("\n");
    if (key !== "" && !units.has(key)) units.set(key, id);
  }
  return units;
}

async function addableParent(
  explorer: AddableExplorer | null,
  fen: string,
): Promise<ExplorerPosition | null> {
  if (!explorer) return null;
  try {
    return await explorer.position(fen, EXPLORER_RATINGS);
  } catch {
    return null;
  }
}

function compareAddable(a: AddableOpening, b: AddableOpening): number {
  const share = (b.share_0_1199 ?? -1) - (a.share_0_1199 ?? -1);
  if (share !== 0) return share;
  if (b.games !== a.games) return b.games - a.games;
  return compareSan(a.opening_name, b.opening_name);
}

/**
 * Every opening Black can leave the student's 1.e4 path with, with the student's game count
 * from the met openings, the share of explorer games at 0-1199, and the unit already built
 * from the root, if any. Without an explorer, or when it fails, every share is null and the
 * order falls back to games, then name.
 */
export async function listAddableOpenings(
  db: Database,
  names: OpeningNames,
  explorer: AddableExplorer | null,
): Promise<AddableOpeningsResponse> {
  const candidates = addableCandidates(names);
  const firstFen = addableFenOf(FIRST_LINE);
  const secondFen = addableFenOf(SECOND_LINE);
  const [first, second] = await Promise.all([
    addableParent(explorer, firstFen),
    addableParent(explorer, secondFen),
  ]);
  const met = new Map(listMetOpenings(db).map((row) => [row.root.join("\n"), row]));
  const units = addableUnitsByRoot(db);
  const entries: AddableOpening[] = candidates.map((candidate) => {
    const firstMove = candidate.root.length === FIRST_LINE.length + 1;
    const parentFen = firstMove ? firstFen : secondFen;
    const parent = firstMove ? first : second;
    const last = candidate.root[candidate.root.length - 1] ?? "";
    const uci = addableUciOfSanAt(parentFen, last);
    const key = candidate.root.join("\n");
    const seen = met.get(key);
    return {
      root: candidate.root,
      opening_name: candidate.openingName,
      family: candidate.family,
      games: seen?.games ?? 0,
      share_0_1199: parent && uci ? addableShareOf(parent, parentFen, uci) : null,
      repertoire_id: units.get(key) ?? seen?.repertoireId ?? null,
    };
  });
  entries.sort(compareAddable);
  return { entries };
}
