import {
  MAIN_LINE_VARIATION,
  openingFamilyOf,
  type PlayedColour,
  type PlayedOpening,
  type PlayedVariation,
  type PlayedWindow,
  UNNAMED_PLAYED_OPENING,
} from "@chess-coach/shared";
import { type Clock, systemClock } from "../clock.js";
import { listMoves } from "../db/games.js";
import type { Database } from "../db/open.js";
import type { OpeningNames } from "./names.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface PlayedGameRow {
  id: number;
  player_color: "white" | "black";
  result: "1-0" | "0-1" | "1/2-1/2";
  game_date: string;
}

// Finished games with a result, outside the coach, whose date sits inside the window. The date is
// what the game list shows beside each game, so the count and the list never disagree about it.
function playedGames(db: Database, cutoff: string | null, nowIso: string): PlayedGameRow[] {
  const dateFilter =
    cutoff === null
      ? ""
      : "AND COALESCE(played_at, started_at) >= ? AND COALESCE(played_at, started_at) <= ?";
  const params = cutoff === null ? [] : [cutoff, nowIso];
  const rows = db
    .prepare(
      `SELECT id, player_color, result, COALESCE(played_at, started_at) AS game_date
       FROM games
       WHERE finished_at IS NOT NULL AND result IS NOT NULL AND source != 'coach' ${dateFilter}
       ORDER BY id`,
    )
    .all(...params);
  return rows as PlayedGameRow[];
}

// The moves up to a ply, numbered the way the idea prompt numbers them: 1.e4 e5 2.Nf3 Nc6.
function playedLineLabel(sans: readonly string[]): string {
  return sans.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}.${san}` : san)).join(" ");
}

interface NamedPly {
  index: number;
  family: string;
  fullName: string;
}

// The variation of a full opening name: the text after its colon, or the main line.
function variationOf(fullName: string): string {
  const colon = fullName.indexOf(":");
  if (colon === -1) return MAIN_LINE_VARIATION;
  return fullName.slice(colon + 1).trim() || MAIN_LINE_VARIATION;
}

interface CountedGame {
  colour: "white" | "black";
  mine: boolean;
  family: string;
  fullName: string;
  variation: string;
  openingLine: string;
  variationLine: string;
  win: boolean;
  draw: boolean;
  loss: boolean;
  date: string;
  id: number;
}

// One game, counted: its family is the last named position over all its moves, and the side that
// chose it played the move reaching the first position named with that family.
function countGame(
  row: PlayedGameRow,
  sans: readonly string[],
  named: readonly NamedPly[],
  isPlayer: readonly boolean[],
): CountedGame {
  const last = named[named.length - 1];
  const wonWhite = row.result === "1-0";
  const drawn = row.result === "1/2-1/2";
  const studentWhite = row.player_color === "white";
  const win = drawn ? false : studentWhite === wonWhite;
  const outcome = { win, draw: drawn, loss: !drawn && !win };
  if (!last) {
    const line = playedLineLabel(sans);
    return {
      colour: row.player_color,
      mine: true,
      family: UNNAMED_PLAYED_OPENING,
      fullName: UNNAMED_PLAYED_OPENING,
      variation: UNNAMED_PLAYED_OPENING,
      openingLine: line,
      variationLine: line,
      ...outcome,
      date: row.game_date,
      id: row.id,
    };
  }
  const firstIndex = named.find((ply) => ply.family === last.family)?.index ?? last.index;
  const familyLine = playedLineLabel(sans.slice(0, firstIndex + 1));
  const variationLine = playedLineLabel(sans.slice(0, last.index + 1));
  return {
    colour: row.player_color,
    mine: isPlayer[firstIndex] ?? false,
    family: last.family,
    fullName: last.fullName,
    variation: variationOf(last.fullName),
    openingLine: familyLine,
    variationLine,
    ...outcome,
    date: row.game_date,
    id: row.id,
  };
}

interface VariationTally {
  name: string;
  fullName: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  date: string;
  id: number;
  line: string;
}

interface OpeningTally {
  opening: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  date: string;
  id: number;
  line: string;
  variations: Map<string, VariationTally>;
}

function isMoreRecent(date: string, id: number, best: { date: string; id: number }): boolean {
  return date > best.date || (date === best.date && id > best.id);
}

function tallyGame(into: Map<string, OpeningTally>, counted: CountedGame): void {
  let opening = into.get(counted.family);
  if (!opening) {
    opening = {
      opening: counted.family,
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      date: counted.date,
      id: counted.id,
      line: counted.openingLine,
      variations: new Map(),
    };
    into.set(counted.family, opening);
  }
  opening.games += 1;
  if (counted.win) opening.wins += 1;
  else if (counted.draw) opening.draws += 1;
  else opening.losses += 1;
  if (isMoreRecent(counted.date, counted.id, opening)) {
    opening.date = counted.date;
    opening.id = counted.id;
    opening.line = counted.openingLine;
  }
  let variation = opening.variations.get(counted.fullName);
  if (!variation) {
    variation = {
      name: counted.variation,
      fullName: counted.fullName,
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      date: counted.date,
      id: counted.id,
      line: counted.variationLine,
    };
    opening.variations.set(counted.fullName, variation);
  }
  variation.games += 1;
  if (counted.win) variation.wins += 1;
  else if (counted.draw) variation.draws += 1;
  else variation.losses += 1;
  if (isMoreRecent(counted.date, counted.id, variation)) {
    variation.date = counted.date;
    variation.id = counted.id;
    variation.line = counted.variationLine;
  }
}

function compareVariations(a: PlayedVariation, b: PlayedVariation): number {
  if (b.games !== a.games) return b.games - a.games;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.full_name !== b.full_name) return a.full_name < b.full_name ? -1 : 1;
  return 0;
}

function compareOpenings(a: PlayedOpening, b: PlayedOpening): number {
  if (b.games !== a.games) return b.games - a.games;
  if (a.opening !== b.opening) return a.opening < b.opening ? -1 : 1;
  return 0;
}

function buildOpening(tally: OpeningTally): PlayedOpening {
  const variations: PlayedVariation[] = [...tally.variations.values()].map((row) => ({
    name: row.name,
    full_name: row.fullName,
    line: row.line,
    games: row.games,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
  }));
  variations.sort(compareVariations);
  return {
    opening: tally.opening,
    line: tally.line,
    games: tally.games,
    wins: tally.wins,
    draws: tally.draws,
    losses: tally.losses,
    variations,
  };
}

// Named openings most games first, then by name; the unnamed one always last.
function buildSide(into: Map<string, OpeningTally>): PlayedOpening[] {
  const unnamed = into.get(UNNAMED_PLAYED_OPENING);
  const named: PlayedOpening[] = [];
  for (const tally of into.values()) {
    if (tally.opening === UNNAMED_PLAYED_OPENING) continue;
    named.push(buildOpening(tally));
  }
  named.sort(compareOpenings);
  return unnamed ? [...named, buildOpening(unnamed)] : named;
}

/**
 * Counts the student's finished games with a result, outside the coach, by opening and
 * variation, per colour and over the window. A game's opening is the last named position over
 * all its moves, the way the game list shows it; it is the student's choice when the student
 * played the move reaching the first position named with its family.
 */
export function listPlayedOpenings(
  db: Database,
  names: OpeningNames,
  window: PlayedWindow,
  clock: Clock = systemClock,
): { white: PlayedColour; black: PlayedColour } {
  const now = clock.now();
  const nowIso = now.toISOString();
  const cutoff =
    window === "all" ? null : new Date(now.getTime() - Number(window) * DAY_MS).toISOString();
  const mineWhite = new Map<string, OpeningTally>();
  const againstWhite = new Map<string, OpeningTally>();
  const mineBlack = new Map<string, OpeningTally>();
  const againstBlack = new Map<string, OpeningTally>();
  for (const row of playedGames(db, cutoff, nowIso)) {
    const moves = listMoves(db, row.id);
    const sans = moves.map((move) => move.san);
    const named: NamedPly[] = [];
    for (const [index, move] of moves.entries()) {
      const found = names.ofPosition(move.fenAfter);
      if (!found) continue;
      const family = openingFamilyOf(found.name);
      if (!family) continue;
      named.push({ index, family, fullName: found.name.trim() });
    }
    const counted = countGame(
      row,
      sans,
      named,
      moves.map((move) => move.isPlayer),
    );
    const mine = counted.colour === "white" ? mineWhite : mineBlack;
    const against = counted.colour === "white" ? againstWhite : againstBlack;
    tallyGame(counted.mine ? mine : against, counted);
  }
  const side = (
    mine: Map<string, OpeningTally>,
    against: Map<string, OpeningTally>,
  ): PlayedColour => {
    const mineList = buildSide(mine);
    const againstList = buildSide(against);
    const games =
      mineList.reduce((total, entry) => total + entry.games, 0) +
      againstList.reduce((total, entry) => total + entry.games, 0);
    return { games, mine: mineList, against: againstList };
  };
  return { white: side(mineWhite, againstWhite), black: side(mineBlack, againstBlack) };
}
