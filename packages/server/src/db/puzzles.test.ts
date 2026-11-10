import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentDir } from "../paths.js";
import { seedPuzzles } from "../puzzles/seed.js";
import { type Database, openDatabase } from "./open.js";
import { getPuzzle, listMotifs, listPuzzles, recordPuzzleAttempt } from "./puzzles.js";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-puzzles-"));
  db = openDatabase(tmp);
  seedPuzzles(db, contentDir());
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const attempt = (puzzleId: string, solved: boolean) =>
  recordPuzzleAttempt(db, {
    puzzleId,
    attemptedAt: "2026-01-01T00:00:00.000Z",
    solved,
    answered: ["a1a2"],
    failedPly: solved ? null : 0,
    firstTry: solved,
    tries: solved ? 0 : 1,
    gaveUp: !solved,
  });

// Deterministic source for the shuffle, so the order is stable in tests.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("listPuzzles", () => {
  it("orders by attempts, then id, so unseen puzzles come first", () => {
    attempt("forks:0", false);
    attempt("forks:0", true);
    attempt("forks:1", true);
    const all = listPuzzles(db, { motif: "fork", limit: 50 }, seededRandom(7)).puzzles;
    expect(all.at(-1)?.id).toBe("forks:0");
    expect(all.at(-2)?.id).toBe("forks:1");
    expect(all.at(-1)).toMatchObject({ attempts: 2, solved: 1 });
  });

  it("shuffles within equal attempt counts, stably for one seed", () => {
    const first = listPuzzles(db, { motif: "pin", limit: 28 }, seededRandom(11)).puzzles.map(
      (p) => p.id,
    );
    const second = listPuzzles(db, { motif: "pin", limit: 28 }, seededRandom(11)).puzzles.map(
      (p) => p.id,
    );
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(28);
  });

  it("gives different orders for different seeds over unseen puzzles", () => {
    const first = listPuzzles(
      db,
      { motif: "back_rank_mate", limit: 30 },
      seededRandom(1),
    ).puzzles.map((p) => p.id);
    const second = listPuzzles(
      db,
      { motif: "back_rank_mate", limit: 30 },
      seededRandom(2),
    ).puzzles.map((p) => p.id);
    expect(first).not.toEqual(second);
    expect([...first].sort()).toEqual([...second].sort());
  });

  it("defaults to 10, caps at 50 and floors at 1", () => {
    expect(listPuzzles(db).puzzles).toHaveLength(10);
    expect(listPuzzles(db, { limit: 500 }).puzzles).toHaveLength(50);
    expect(listPuzzles(db, { limit: 0 }).puzzles).toHaveLength(1);
  });

  it("returns an empty list with a zero total for an empty motif", () => {
    expect(listPuzzles(db, { motif: "nope" })).toEqual({ total: 0, puzzles: [] });
  });

  it("reports the whole matching inventory as total", () => {
    expect(listPuzzles(db, { motif: "pin", limit: 3 }).total).toBe(28);
  });

  it("never selects the solution columns", () => {
    const first = listPuzzles(db).puzzles[0] as object;
    expect(Object.keys(first).sort()).toEqual(
      ["attempts", "difficulty", "explanation", "fen", "id", "motif", "solved"].sort(),
    );
  });
});

interface SampleFixture {
  themes?: string;
  motif?: string;
  popularity?: number | null;
}

// Lichess ids are five random base-62 characters; the fixtures use the same shape.
function randomId(random: () => number): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let id = "";
  for (let i = 0; i < 5; i++) id += alphabet[Math.floor(random() * alphabet.length)];
  return id;
}

// One row in `puzzles`, and one in `puzzle_themes` for each word of `themes`.
function addSamplePuzzle(id: string, rating: number | null, fixture: SampleFixture = {}): void {
  db.prepare(
    `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation,
                          difficulty_rating, popularity, themes)
     VALUES (?, 'lichess', ?, 'intermediate', 'fen', '[]', '[]', '', ?, ?, ?)`,
  ).run(id, fixture.motif ?? "lichess", rating, fixture.popularity ?? null, fixture.themes ?? null);
  if (rating === null) return;
  for (const theme of fixture.themes?.split(" ") ?? []) {
    db.prepare("INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)").run(
      theme,
      rating,
      id,
    );
  }
}

function addManySamplePuzzles(count: number, ratingOf: (index: number) => number): string[] {
  const random = seededRandom(99);
  const ids: string[] = [];
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `${randomId(random)}${i}`;
      ids.push(id);
      addSamplePuzzle(id, ratingOf(i), { themes: "fork" });
    }
  })();
  return ids;
}

const ratingOfId = (id: string): number =>
  (getPuzzle(db, id) as { rating: number | null }).rating as number;

const sampledIds = (
  filter: { theme?: string; ratingAround: number; limit?: number },
  seed = 1,
): string[] => listPuzzles(db, filter, seededRandom(seed)).puzzles.map((p) => p.id);

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

function idsSeenAcrossSeeds(filter: {
  theme?: string;
  ratingAround: number;
  limit?: number;
}): Set<string> {
  return new Set(SEEDS.flatMap((seed) => sampledIds(filter, seed)));
}

// A named fake over the real database: it records how many rows each statement handed back.
function rowCountingDatabase(real: Database): { db: Database; counts: () => number[] } {
  const counts: number[] = [];
  const wrapStatement = (statement: object): object =>
    new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (property === "all") counts.push((result as unknown[]).length);
          if (property === "get") counts.push(result === undefined ? 0 : 1);
          return result;
        };
      },
    });
  const wrapped = new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql));
      }
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
  return { db: wrapped, counts: () => counts };
}

describe("listPuzzles around a rating", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM puzzle_themes").run();
    db.prepare("DELETE FROM puzzles").run();
  });

  it("finds a puzzle under every theme it carries", () => {
    addSamplePuzzle("multi", 1200, { themes: "fork sacrifice" });
    addSamplePuzzle("other", 1200, { themes: "pin" });
    expect(sampledIds({ theme: "fork", ratingAround: 1219 })).toEqual(["multi"]);
    expect(sampledIds({ theme: "sacrifice", ratingAround: 1219 })).toEqual(["multi"]);
    expect(listPuzzles(db, { theme: "sacrifice" }).puzzles.map((p) => p.id)).toEqual(["multi"]);
  });

  it("returns a summary with the same keys as the plain listing", () => {
    addSamplePuzzle("only", 1200);
    const [first] = listPuzzles(db, { ratingAround: 1219 }).puzzles;
    expect(first).toEqual({
      id: "only",
      motif: "lichess",
      difficulty: "intermediate",
      fen: "fen",
      explanation: "",
      attempts: 0,
      solved: 0,
    });
  });

  it("returns an empty list when nothing is rated or the theme is unknown", () => {
    addSamplePuzzle("unrated", null);
    expect(listPuzzles(db, { ratingAround: 1219 }).puzzles).toEqual([]);
    expect(listPuzzles(db, { theme: "nope", ratingAround: 1219 }).puzzles).toEqual([]);
  });

  it("stays inside the window while enough puzzles lie in it", () => {
    for (let i = 0; i < 12; i++) addSamplePuzzle(`near${i}`, 1100, { themes: "fork" });
    addSamplePuzzle("far", 1800, { themes: "fork" });
    for (const filter of [{ theme: "fork" }, {}]) {
      const seen = idsSeenAcrossSeeds({ ...filter, ratingAround: 1219, limit: 10 });
      expect(seen).toContain("near0");
      expect(seen).not.toContain("far");
    }
  });

  it("includes both edges of the window and nothing past them", () => {
    addSamplePuzzle("low-edge", 1019);
    addSamplePuzzle("high-edge", 1419);
    addSamplePuzzle("below", 1018);
    addSamplePuzzle("above", 1420);
    const seen = idsSeenAcrossSeeds({ ratingAround: 1219, limit: 2 });
    expect([...seen].sort()).toEqual(["high-edge", "low-edge"]);
  });

  it("reaches the whole 200 points on each side, not a narrower band", () => {
    for (let i = 0; i < 5; i++) {
      addSamplePuzzle(`below${i}`, 1100);
      addSamplePuzzle(`above${i}`, 1340);
    }
    const seen = idsSeenAcrossSeeds({ ratingAround: 1219, limit: 5 });
    expect([...seen].some((id) => id.startsWith("below"))).toBe(true);
    expect([...seen].some((id) => id.startsWith("above"))).toBe(true);
  });

  it("widens until the limit is reached: 3 at 1200 and 2 at 1650 return all 5", () => {
    for (const [i, rating] of [1200, 1200, 1200, 1650, 1650].entries()) {
      addSamplePuzzle(`p${i}`, rating, { themes: "fork" });
    }
    for (const filter of [{ theme: "fork" }, {}]) {
      for (const seed of SEEDS) {
        const ids = sampledIds({ ...filter, ratingAround: 1219, limit: 5 }, seed);
        expect([...ids].sort()).toEqual(["p0", "p1", "p2", "p3", "p4"]);
      }
    }
  });

  it("widens downward as well", () => {
    addSamplePuzzle("near", 1200);
    addSamplePuzzle("far-below", 500);
    expect(sampledIds({ ratingAround: 1219, limit: 5 }).sort()).toEqual(["far-below", "near"]);
  });

  it("widens by 200 per side and stops as soon as the queue is full", () => {
    addSamplePuzzle("centre", 1000);
    addSamplePuzzle("ring-300", 1290);
    addSamplePuzzle("ring-390", 1390);
    addSamplePuzzle("ring-590", 1590);
    const seen = idsSeenAcrossSeeds({ ratingAround: 1000, limit: 2 });
    expect([...seen].sort()).toEqual(["centre", "ring-300", "ring-390"]);
  });

  it("serves a small library, whose ids are not random, when the student is far away", () => {
    for (let i = 0; i < 28; i++) addSamplePuzzle(`forks:${i}`, 900 + i * 32, { themes: "fork" });
    const seen = idsSeenAcrossSeeds({ theme: "fork", ratingAround: 1219, limit: 5 });
    expect(seen.size).toBeGreaterThan(5);
    expect(sampledIds({ theme: "fork", ratingAround: 2600, limit: 50 })).toHaveLength(28);
    expect(sampledIds({ theme: "fork", ratingAround: 100, limit: 50 })).toHaveLength(28);
  });

  it("does not sample popularity 49, and does sample 50 and a null", () => {
    addSamplePuzzle("pop-49", 1200, { themes: "fork", popularity: 49 });
    addSamplePuzzle("pop-50", 1200, { themes: "fork", popularity: 50 });
    addSamplePuzzle("pop-null", 1200, { themes: "fork", popularity: null });
    for (const filter of [{ theme: "fork" }, {}]) {
      const seen = idsSeenAcrossSeeds({ ...filter, ratingAround: 1219, limit: 10 });
      expect([...seen].sort()).toEqual(["pop-50", "pop-null"]);
    }
  });

  it("rejects low popularity in the seek as well as in the direct read", () => {
    // Every rating of the window is populated, so a seek that ignored popularity would land on one.
    for (let rating = 1019; rating <= 1419; rating++) {
      addSamplePuzzle(`low-${rating}`, rating, { popularity: 49 });
    }
    addSamplePuzzle("kept", 1200, { popularity: 50 });
    expect(sampledIds({ ratingAround: 1219, limit: 1 })).toEqual(["kept"]);
    const seen = sampledIds({ ratingAround: 1219, limit: 10 });
    expect(seen).toEqual(["kept"]);
  });

  describe("an Any queue", () => {
    beforeEach(() => {
      addSamplePuzzle("drill", 1200, { motif: "opening-white" });
      addSamplePuzzle("opening-move", 1200, { motif: "opening" });
      addSamplePuzzle("opening-trap", 1200, { motif: "opening_trap" });
      addSamplePuzzle("tagged", 1200, { themes: "opening fork" });
      addSamplePuzzle("tactic", 1200, { themes: "fork" });
    });

    it("never holds opening material, whichever way it is marked", () => {
      expect(idsSeenAcrossSeeds({ ratingAround: 1219, limit: 10 })).toEqual(new Set(["tactic"]));
    });

    it("does not mistake a theme that merely contains the word", () => {
      addSamplePuzzle("like", 1200, { themes: "openingish fork" });
      expect(idsSeenAcrossSeeds({ ratingAround: 1219, limit: 10 })).toEqual(
        new Set(["like", "tactic"]),
      );
    });

    it("rejects opening material in the seek too", () => {
      for (let rating = 1019; rating <= 1419; rating++) {
        addSamplePuzzle(`drill-${rating}`, rating, { motif: "opening-white" });
        addSamplePuzzle(`move-${rating}`, rating, { motif: "opening" });
        addSamplePuzzle(`trap-${rating}`, rating, { motif: "opening_trap" });
        addSamplePuzzle(`tag-${rating}`, rating, { themes: "opening pin" });
      }
      expect(idsSeenAcrossSeeds({ ratingAround: 1219, limit: 3 })).toEqual(new Set(["tactic"]));
    });

    it("leaves a tagged puzzle reachable under its other theme", () => {
      expect(idsSeenAcrossSeeds({ theme: "fork", ratingAround: 1219, limit: 10 })).toEqual(
        new Set(["tagged", "tactic"]),
      );
    });
  });

  describe("attempted puzzles", () => {
    it("are returned only when the window holds too few unattempted ones", () => {
      addSamplePuzzle("seen", 1200, { themes: "fork" });
      addSamplePuzzle("fresh1", 1210, { themes: "fork" });
      addSamplePuzzle("fresh2", 1220, { themes: "fork" });
      attempt("seen", true);
      for (const filter of [{ theme: "fork" }, {}]) {
        expect(idsSeenAcrossSeeds({ ...filter, ratingAround: 1219, limit: 2 })).toEqual(
          new Set(["fresh1", "fresh2"]),
        );
        for (const seed of SEEDS) {
          const queue = listPuzzles(
            db,
            { ...filter, ratingAround: 1219, limit: 3 },
            seededRandom(seed),
          );
          expect(queue.puzzles.map((p) => p.id).sort()).toEqual(["fresh1", "fresh2", "seen"]);
          expect(queue.puzzles[2]).toMatchObject({ id: "seen", attempts: 1, solved: 1 });
        }
      }
    });

    it("are rejected by the seek when every rating of the window is populated", () => {
      const ids = addManySamplePuzzles(401, (i) => 1019 + i);
      for (const id of ids.slice(1)) attempt(id, false);
      expect(sampledIds({ ratingAround: 1219, limit: 1 })).toEqual(ids.slice(0, 1));
      expect(sampledIds({ theme: "fork", ratingAround: 1219, limit: 1 })).toEqual(ids.slice(0, 1));
    });

    it("are preferred least-attempted first", () => {
      addSamplePuzzle("twice", 1200);
      addSamplePuzzle("once", 1200);
      attempt("twice", false);
      attempt("twice", false);
      attempt("once", false);
      expect(sampledIds({ ratingAround: 1219, limit: 1 })).toEqual(["once"]);
    });

    it("stay inside the window too", () => {
      addSamplePuzzle("seen-near", 1200, { themes: "fork" });
      addSamplePuzzle("seen-far", 1700, { themes: "fork" });
      attempt("seen-near", true);
      attempt("seen-far", true);
      for (const filter of [{ theme: "fork" }, {}]) {
        expect(idsSeenAcrossSeeds({ ...filter, ratingAround: 1219, limit: 1 })).toEqual(
          new Set(["seen-near"]),
        );
      }
    });

    it("come from the window before the window widens", () => {
      addSamplePuzzle("seen-near", 1200);
      addSamplePuzzle("fresh-far", 1700);
      attempt("seen-near", true);
      expect(idsSeenAcrossSeeds({ ratingAround: 1219, limit: 1 })).toEqual(new Set(["seen-near"]));
      expect(sampledIds({ ratingAround: 1219, limit: 2 }).sort()).toEqual([
        "fresh-far",
        "seen-near",
      ]);
    });

    it("keep the eligibility rules", () => {
      addSamplePuzzle("seen-unpopular", 1200, { themes: "fork", popularity: 49 });
      addSamplePuzzle("seen-opening", 1200, { themes: "opening fork" });
      attempt("seen-unpopular", true);
      attempt("seen-opening", true);
      expect(sampledIds({ ratingAround: 1219, limit: 5 })).toEqual([]);
      expect(sampledIds({ theme: "fork", ratingAround: 1219, limit: 5 })).toEqual(["seen-opening"]);
      expect(sampledIds({ theme: "pin", ratingAround: 1219, limit: 5 })).toEqual([]);
    });
  });

  it("never holds the same puzzle twice", () => {
    addManySamplePuzzles(60, (i) => 1100 + i * 4);
    for (const filter of [{ theme: "fork" }, {}]) {
      for (const seed of SEEDS) {
        const ids = sampledIds({ ...filter, ratingAround: 1219, limit: 50 }, seed);
        expect(ids).toHaveLength(50);
        expect(new Set(ids).size).toBe(50);
      }
    }
  });

  it("repeats for one seed and differs across seeds", () => {
    addManySamplePuzzles(1000, (i) => 1019 + (i % 401));
    for (const filter of [{ theme: "fork" }, {}]) {
      const first = sampledIds({ ...filter, ratingAround: 1219, limit: 10 }, 5);
      expect(sampledIds({ ...filter, ratingAround: 1219, limit: 10 }, 5)).toEqual(first);
      expect(sampledIds({ ...filter, ratingAround: 1219, limit: 10 }, 6)).not.toEqual(first);
    }
  });

  it("draws the seek's rating from both ends of the window", () => {
    addSamplePuzzle("low-edge", 1019);
    addSamplePuzzle("high-edge", 1419);
    const cycling = (...values: number[]) => {
      let next = 0;
      return () => values[next++ % values.length] as number;
    };
    const pick = (ratingDraw: number): string | undefined =>
      listPuzzles(db, { ratingAround: 1219, limit: 1 }, cycling(ratingDraw, 0)).puzzles[0]?.id;
    expect(pick(0)).toBe("low-edge");
    expect(pick(0.9999999)).toBe("high-edge");
  });

  it("shuffles what the direct read finds in a sparse window", () => {
    addManySamplePuzzles(30, (i) => (i === 0 ? 1019 : i === 1 ? 1419 : 1200));
    expect(idsSeenAcrossSeeds({ ratingAround: 1219, limit: 1 }).size).toBeGreaterThan(10);
  });

  it("does not favour a puzzle that follows a gap in the ratings", () => {
    for (let i = 0; i < 100; i++) addSamplePuzzle(`dense${i}`, 1100 + i);
    addSamplePuzzle("after-gap", 1300);
    const trials = 1000;
    let picks = 0;
    for (let seed = 1; seed <= trials; seed++) {
      if (sampledIds({ ratingAround: 1219, limit: 1 }, seed)[0] === "after-gap") picks += 1;
    }
    expect(picks / trials).toBeLessThan(0.05);
  });

  it("spreads a large window's queue over the window instead of reading its low end", () => {
    addManySamplePuzzles(5000, (i) => 1019 + (i % 401));
    for (const filter of [{ theme: "fork" }, {}]) {
      const ratings = sampledIds({ ...filter, ratingAround: 1219, limit: 50 }).map(ratingOfId);
      expect(Math.min(...ratings)).toBeLessThan(1120);
      expect(Math.max(...ratings)).toBeGreaterThan(1320);
    }
  });

  describe("row bound", () => {
    const counted = (filter: { theme?: string; ratingAround: number; limit: number }): number[] => {
      const counting = rowCountingDatabase(db);
      expect(listPuzzles(counting.db, filter, seededRandom(3)).puzzles).toHaveLength(filter.limit);
      return counting.counts();
    };

    it("counts what it is meant to count", () => {
      addManySamplePuzzles(300, () => 1200);
      const counting = rowCountingDatabase(db);
      expect(counting.db.prepare("SELECT id FROM puzzles").all()).toHaveLength(300);
      expect(counting.counts()).toEqual([300]);
    });

    it("no statement returns more than 200 rows on a window that fills from seeks", () => {
      addManySamplePuzzles(5000, (i) => 1019 + (i % 401));
      for (const filter of [{ theme: "fork" }, {}]) {
        const rows = counted({ ...filter, ratingAround: 1219, limit: 50 });
        expect(Math.max(...rows)).toBeLessThanOrEqual(200);
      }
    });

    it("no statement returns more than 200 rows when the seek keeps missing", () => {
      // Nearly all of them on one rating, so nearly every draw lands on an empty one.
      addManySamplePuzzles(5000, (i) => (i === 0 ? 1019 : i === 1 ? 1419 : 1200));
      for (const filter of [{ theme: "fork" }, {}]) {
        const rows = counted({ ...filter, ratingAround: 1219, limit: 50 });
        expect(Math.max(...rows)).toBe(200);
      }
    });

    it("no statement returns more than 200 rows when all of it has been attempted", () => {
      const ids = addManySamplePuzzles(5000, () => 1200);
      db.transaction(() => {
        for (const id of ids) attempt(id, false);
      })();
      for (const filter of [{ theme: "fork" }, {}]) {
        const rows = counted({ ...filter, ratingAround: 1219, limit: 50 });
        expect(Math.max(...rows)).toBe(200);
      }
    });
  });
});

describe("the plain listing and imported puzzles", () => {
  function addRow(id: string, source: string, motif: string): void {
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
       VALUES (?, ?, ?, 'easy', '8/8/8/8/8/8/8/K6k w - - 0 1', '[]', '[]', 'why')`,
    ).run(id, source, motif);
  }

  beforeEach(() => {
    db.prepare("DELETE FROM puzzles").run();
    addRow("library", "generated", "fork");
    addRow("imported", "lichess-db", "fork");
    addRow("imported-only", "lichess-db", "tactics");
  });

  it("lists only the library, and counts only the library", () => {
    const listing = listPuzzles(db, { motif: "fork" });
    expect(listing.puzzles.map((puzzle) => puzzle.id)).toEqual(["library"]);
    expect(listing.total).toBe(1);
    expect(listPuzzles(db).puzzles.map((puzzle) => puzzle.id)).toEqual(["library"]);
  });

  it("counts motifs over the library only", () => {
    expect(listMotifs(db)).toEqual([{ motif: "fork", count: 1 }]);
  });
});

describe("listPuzzles by stored opening name", () => {
  function addNamed(id: string, motif: string, openingName: string | null): void {
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, opening_name)
       VALUES (?, 'own-games', ?, 'beginner', '8/8/8/8/8/8/8/K6k w - - 0 1', '["a1a2"]', '["Ka2"]', 'why', ?)`,
    ).run(id, motif, openingName);
  }

  const idsOf = (openingNames: readonly (string | null)[]): string[] =>
    listPuzzles(db, { motif: "opening-white", openingNames, limit: 50 }, seededRandom(1))
      .puzzles.map((puzzle) => puzzle.id)
      .sort();

  beforeEach(() => {
    addNamed("own:italian", "opening-white", "Italian Game");
    addNamed("own:piano", "opening-white", "Italian Game: Giuoco Piano");
    addNamed("own:ruy", "opening-white", "Ruy Lopez");
    addNamed("own:bare", "opening-white", null);
    addNamed("own:black", "opening-black", "Italian Game");
  });

  it("serves the positions carrying one of the names, of the motif asked for", () => {
    expect(idsOf(["Italian Game"])).toEqual(["own:italian"]);
    expect(idsOf(["Italian Game", "Italian Game: Giuoco Piano"])).toEqual([
      "own:italian",
      "own:piano",
    ]);
  });

  it("serves the positions with no name for null, alone or beside names", () => {
    expect(idsOf([null])).toEqual(["own:bare"]);
    expect(idsOf(["Ruy Lopez", null])).toEqual(["own:bare", "own:ruy"]);
  });

  it("counts the matching positions in the total", () => {
    const listing = listPuzzles(db, {
      motif: "opening-white",
      openingNames: ["Italian Game", "Italian Game: Giuoco Piano"],
      limit: 1,
    });
    expect(listing.total).toBe(2);
    expect(listing.puzzles).toHaveLength(1);
  });

  it("serves nothing for an empty list, instead of failing on the forced index", () => {
    expect(listPuzzles(db, { motif: "opening-white", openingNames: [] })).toEqual({
      total: 0,
      puzzles: [],
    });
  });

  it("keeps serving every position of the motif when no name is given", () => {
    expect(listPuzzles(db, { motif: "opening-white", limit: 50 }).puzzles).toHaveLength(4);
  });
});

describe("getPuzzle and recordPuzzleAttempt", () => {
  it("reads the solution back as a list", () => {
    expect(getPuzzle(db, "forks:0")?.solution).toEqual(["b5c7", "e8f8", "a1c1"]);
    expect(getPuzzle(db, "missing:0")).toBeNull();
  });

  it("refuses an attempt for an unknown puzzle", () => {
    expect(() => attempt("missing:0", true)).toThrow(/FOREIGN KEY/);
  });
});
