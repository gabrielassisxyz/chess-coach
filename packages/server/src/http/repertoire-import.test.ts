import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteImportedResponseSchema,
  ImportPgnInvalidResponseSchema,
  ImportPgnResponseSchema,
  RepertoireImportRefusalSchema,
  type RepertoiresResponse,
  RepertoiresResponseSchema,
  type TrainingActivity,
} from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptedEngine } from "../../test/fakes/scripted-engine.js";
import { ActivityService } from "../activity/service.js";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
import { introduceRepertoireCard } from "../db/repertoire-cards.js";
import { createRepertoireVariation } from "../db/repertoires.js";
import { GameService } from "../game/service.js";
import { RecordingLog } from "../log.js";
import { readPgnRepertoire } from "../openings/pgn-repertoire.js";
import { ReviewDesk } from "../srs/review.js";
import { DEFAULT_ALLOWED_ORIGINS } from "../ws/origin.js";

// The reader is the real one, wrapped so that a test can tell whether a request got as far as it.
vi.mock("../openings/pgn-repertoire.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openings/pgn-repertoire.js")>();
  return { ...actual, readPgnRepertoire: vi.fn(actual.readPgnRepertoire) };
});

const AT = "2026-11-21T20:00:00.000Z";
const ALLOWED = { origin: "http://localhost:5173", host: "localhost:5173" };
const IMPORT_URL = "/api/repertoires/import-pgn";

const FOREIGN_ORIGIN = { origin: "http://evil.example", host: "localhost:5173" };
const BAD_HEADERS: Array<[string, Record<string, string>]> = [
  // A rebinding page is same-origin to itself, so its Host and Origin agree; only the list stops it.
  ["a rebinding page", { origin: "http://evil.example:3210", host: "evil.example:3210" }],
  ["a foreign origin", FOREIGN_ORIGIN],
  ["a foreign host", { origin: "http://localhost:5173", host: "evil.example:3210" }],
  ["no origin", { host: "localhost:5173" }],
];

const BF4_REASON = "Develops outside the pawn chain before ...e6 closes it in.";
const E3_REASON = "Opens a retreat for the bishop.";

// White's London as a file: the student's reason follows two of the moves, as a comment.
const LONDON_FILE = `1. d4 d5 2. Bf4 {${BF4_REASON}} Nf6 3. e3 {${E3_REASON}} e6 4. Nf3 *`;
// The same file with 4.c3 for 4.Nf3, and no reasons.
const LONDON_EDITED = "1. d4 d5 2. Bf4 Nf6 3. e3 e6 4. c3 *";
// The same file with 3.Nf3 for 3.e3, which leaves the reason of 3.e3 with no row.
const LONDON_WITHOUT_E3 = `1. d4 d5 2. Bf4 {${BF4_REASON}} Nf6 3. Nf3 e6 *`;

// The Caro-Kann as Black: White's alternatives are variations, since Black keeps one answer to a
// position. Twelve moves of the main line are Black's, and the lines at moves 3 and 4 add five more.
const CARO_KANN_FILE = [
  "1. e4 c6 2. d4 d5",
  "3. Nc3 (3. e5 Bf5 4. Nf3 e6 5. Be2 c5) 3... dxe4",
  "4. Nxe4 (4. Bc4 Nf6 5. Nxe4 Bf5) 4... Bf5",
  "5. Ng3 Bg6 6. h4 h6 7. Nf3 Nd7 8. h5 Bh7 9. Bd3 Bxd3 10. Qxd3 e6 11. Bf4 Ngf6 12. O-O-O Be7 *",
].join(" ");

const LONDON = { side: "white", group: "London System", variation: "Main line", pgn: LONDON_FILE };

const readerOf = vi.mocked(readPgnRepertoire);

let tmp: string;
let db: Database;
let log: RecordingLog;
let app: FastifyInstance;

const startApp = (): FastifyInstance =>
  buildApp({ db, log, allowedOrigins: DEFAULT_ALLOWED_ORIGINS });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-import-route-"));
  db = openDatabase(tmp);
  log = new RecordingLog();
  app = startApp();
  readerOf.mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const importPgn = (payload: unknown, headers: Record<string, string> = ALLOWED) =>
  app.inject({
    method: "POST",
    url: IMPORT_URL,
    headers: { ...headers, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });

const removeLine = (id: number | string, query = "", headers: Record<string, string> = ALLOWED) =>
  app.inject({ method: "DELETE", url: `/api/repertoires/${id}${query}`, headers });

async function listRepertoires(): Promise<RepertoiresResponse> {
  const response = await app.inject({ method: "GET", url: "/api/repertoires" });
  return RepertoiresResponseSchema.parse(response.json());
}

async function importedId(payload: unknown): Promise<number> {
  const response = await importPgn(payload);
  expect(response.statusCode).toBe(200);
  return ImportPgnResponseSchema.parse(response.json()).summary.repertoire_id;
}

// Every table an import or a delete can touch, so "writes nothing" is a comparison.
function tables() {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    repertoires: all("SELECT * FROM repertoires ORDER BY id"),
    positions: all("SELECT * FROM repertoire_positions ORDER BY id"),
    cards: all("SELECT * FROM repertoire_cards ORDER BY id"),
    reviews: all("SELECT * FROM drill_reviews ORDER BY id"),
    attempts: all("SELECT * FROM repertoire_first_attempts ORDER BY id"),
    runs: all("SELECT * FROM training_runs ORDER BY id"),
  };
}

const ownRowsOf = (repertoireId: number): number =>
  (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM repertoire_positions WHERE repertoire_id = ? AND kind = 'own'",
      )
      .get(repertoireId) as { n: number }
  ).n;

// A line of the file a lot longer than any move text, in a form the reader skips: a % in the first
// column escapes its whole line. The text ends up exactly `bytes` long.
const paddedTo = (pgn: string, bytes: number): string =>
  `${pgn}\n%${"x".repeat(bytes - Buffer.byteLength(pgn) - 2)}`;

const refusalLogged = (code: string) =>
  log.named("repertoire.import_refused").filter((entry) => entry.fields.code === code);

function openDrillService(): ActivityService {
  return new ActivityService({
    db,
    game: new GameService({ db, engine: new ScriptedEngine([]) }),
    training: { desk: new ReviewDesk({ db }) },
  });
}

async function startDrill(service: ActivityService, repertoireId: number) {
  const state = await service.startTraining({ mode: "repertoire", repertoireId, scope: "all" });
  if (state.kind !== "training") throw new Error(`expected training, got ${state.kind}`);
  return state;
}

describe("POST /api/repertoires/import-pgn: the request", () => {
  const without = (key: string): Record<string, unknown> => {
    const { [key]: _gone, ...rest } = LONDON as Record<string, unknown>;
    return rest;
  };
  // [what is wrong, the body, how the answer starts]
  const INVALID_BODIES: Array<[string, unknown, string]> = [
    ["a side that is neither white nor black", { ...LONDON, side: "grey" }, "side:"],
    ["no side", without("side"), "side:"],
    ["no group", without("group"), "group:"],
    ["a blank group", { ...LONDON, group: "   " }, "group:"],
    ["a group of 121 characters", { ...LONDON, group: "g".repeat(121) }, "group:"],
    ["no variation", without("variation"), "variation:"],
    ["a blank variation", { ...LONDON, variation: "\t " }, "variation:"],
    ["a variation of 121 characters", { ...LONDON, variation: "v".repeat(121) }, "variation:"],
    ["no pgn", without("pgn"), "pgn:"],
    ["an empty pgn", { ...LONDON, pgn: "" }, "pgn:"],
    ["a pgn that is not text", { ...LONDON, pgn: 42 }, "pgn:"],
    ["a pgn of 500001 bytes", { ...LONDON, pgn: paddedTo(LONDON_FILE, 500_001) }, "pgn:"],
    // 250,001 characters and 500,002 bytes: the limit counts bytes.
    [
      "a pgn under 500000 characters and over 500000 bytes",
      { ...LONDON, pgn: "é".repeat(250_001) },
      "pgn:",
    ],
    ["weights of 500001 bytes", { ...LONDON, weights: "w".repeat(500_001) }, "weights:"],
    ["weights that are not text", { ...LONDON, weights: 7 }, "weights:"],
    ["a dry_run that is a string", { ...LONDON, dry_run: "true" }, "dry_run:"],
    ["a dry_run that is a number", { ...LONDON, dry_run: 1 }, "dry_run:"],
    ["a key the schema does not know", { ...LONDON, extra: 1 }, "the body:"],
    // The typo that would otherwise run a real import when a dry one was meant.
    ["a misspelt dry_run", { ...LONDON, dryrun: true }, "the body:"],
    ["a body that is an array", [LONDON], "the body:"],
    ["a body that is null", null, "the body:"],
  ];

  it.each(INVALID_BODIES)(
    "refuses %s with 400 invalid_request and reads nothing",
    async (_what, body, start) => {
      const before = tables();
      const response = await importPgn(body);

      expect(response.statusCode).toBe(400);
      const refusal = RepertoireImportRefusalSchema.parse(response.json());
      expect(refusal.error).toBe("invalid_request");
      expect(refusal.message.startsWith(start)).toBe(true);
      expect(readerOf).not.toHaveBeenCalled();
      expect(tables()).toEqual(before);
      expect(refusalLogged("invalid_request")).toHaveLength(1);
    },
  );

  it("does not echo the PGN or the weights back in a refusal or its log", async () => {
    await importPgn({ ...LONDON, pgn: `${LONDON_FILE} UNIQUEPGNTEXT`, dry_run: "yes" });
    const response = await importPgn({ ...LONDON, side: "grey", weights: "UNIQUEWEIGHTS" });

    expect(response.body).not.toContain("UNIQUE");
    expect(JSON.stringify(log.events)).not.toContain("UNIQUE");
  });

  it("takes the edges of every limit: 120 characters after trimming and exactly 500000 bytes", async () => {
    const group = "g".repeat(120);
    const response = await importPgn({
      ...LONDON,
      group: `  ${group}\n`,
      variation: ` ${"v".repeat(120)} `,
      pgn: paddedTo(LONDON_FILE, 500_000),
    });

    expect(response.statusCode).toBe(200);
    const unit = (await listRepertoires()).repertoires[0];
    expect(unit).toMatchObject({ group_name: group, variation_name: "v".repeat(120) });
  });

  it("treats a body without dry_run as a real run", async () => {
    const response = await importPgn(LONDON);

    expect(ImportPgnResponseSchema.parse(response.json()).dry_run).toBe(false);
    expect((await listRepertoires()).repertoires).toHaveLength(1);
  });

  it("answers a body over 2 MiB with 413 before anything is read", async () => {
    const before = tables();
    const response = await importPgn({ ...LONDON, pgn: "x".repeat(2 * 1024 * 1024) });

    expect(response.statusCode).toBe(413);
    expect(readerOf).not.toHaveBeenCalled();
    expect(tables()).toEqual(before);
  });

  // Two texts at their limit, each a line break per byte, which JSON writes as two characters: the
  // body is about 2 MB, twice Fastify's default limit and under the route's.
  it("takes the largest body the schema allows", async () => {
    const header = "reach\tloss_cp\tline\n";
    const pgn = `${LONDON_FILE}${"\n".repeat(500_000 - Buffer.byteLength(LONDON_FILE))}`;
    const weights = `${header}${"\n".repeat(500_000 - Buffer.byteLength(header))}`;
    const payload = JSON.stringify({ ...LONDON, pgn, weights });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(1_900_000);
    expect(Buffer.byteLength(payload)).toBeLessThan(2 * 1024 * 1024);

    const response = await app.inject({
      method: "POST",
      url: IMPORT_URL,
      headers: { ...ALLOWED, "content-type": "application/json" },
      payload,
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("the origin and the host", () => {
  it.each(BAD_HEADERS)(
    "refuses an import from %s with 403 and writes nothing",
    async (_who, headers) => {
      const before = tables();
      const response = await importPgn(LONDON, headers);

      expect(response.statusCode).toBe(403);
      expect(RepertoireImportRefusalSchema.parse(response.json()).error).toBe("origin_not_allowed");
      expect(readerOf).not.toHaveBeenCalled();
      expect(tables()).toEqual(before);
      expect(refusalLogged("origin_not_allowed")).toHaveLength(1);
    },
  );

  it.each(BAD_HEADERS)(
    "refuses a delete from %s with 403 and removes nothing",
    async (_who, headers) => {
      const id = await importedId(LONDON);
      const before = tables();

      const response = await removeLine(id, "", headers);

      expect(response.statusCode).toBe(403);
      expect(RepertoireImportRefusalSchema.parse(response.json()).error).toBe("origin_not_allowed");
      expect(tables()).toEqual(before);
      expect((await listRepertoires()).repertoires.map((unit) => unit.id)).toEqual([id]);
      expect(log.named("repertoire.import_deleted")).toEqual([]);
    },
  );

  it("decides before the body is read, so a foreign page sending 3 MiB is refused as foreign", async () => {
    const response = await importPgn(
      { ...LONDON, pgn: "x".repeat(3 * 1024 * 1024) },
      FOREIGN_ORIGIN,
    );

    expect(response.statusCode).toBe(403);
  });

  it("follows CHESS_COACH_ALLOWED_ORIGINS when the app is built without a list of its own", async () => {
    vi.stubEnv("CHESS_COACH_ALLOWED_ORIGINS", "https://coach.tail.example");
    await app.close();
    app = buildApp({ db, log });

    const tailnet = { origin: "https://coach.tail.example", host: "coach.tail.example" };
    expect((await importPgn(LONDON, ALLOWED)).statusCode).toBe(403);
    expect((await importPgn(LONDON, tailnet)).statusCode).toBe(200);
    expect((await removeLine(1, "", ALLOWED)).statusCode).toBe(403);
  });
});

describe("a file the reader refuses", () => {
  const ILLEGAL = `1. d4 d5 {SECRETCOMMENT} 2. Bf4 Nf6 3. Ke7 *`;

  it("answers 400 invalid_pgn with the reader's list as it returns it, and writes nothing", async () => {
    const before = tables();
    const response = await importPgn({ ...LONDON, pgn: ILLEGAL });
    const expected = readPgnRepertoire(ILLEGAL, "white");

    expect(response.statusCode).toBe(400);
    const body = ImportPgnInvalidResponseSchema.parse(response.json());
    expect(body.errors).toEqual(expected.errors);
    expect(body.errors[0]).toMatchObject({ code: "illegal_move", move: "Ke7" });
    expect(tables()).toEqual(before);
  });

  it("answers a dry run the same way", async () => {
    const response = await importPgn({ ...LONDON, pgn: ILLEGAL, dry_run: true });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_pgn" });
  });

  // The reader's own text-size problem is not here: the request's schema stops a text that large first.
  it.each<[string, { pgn?: string; weights?: string }]>([
    ["two_answers", { pgn: "1. e4 (1. d4) e5 *" }],
    ["no_moves", { pgn: "   " }],
    ["invalid_pgn", { pgn: "1. d4 d5 {never closed" }],
    ["not_from_start", { pgn: '[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]\n\n1. Ka2 *' }],
    ["invalid_weights", { weights: "not a table" }],
  ])("answers a %s problem as the reader names it", async (code, change) => {
    const before = tables();
    const request = { ...LONDON, ...change };
    const response = await importPgn(request);

    expect(response.statusCode).toBe(400);
    const body = ImportPgnInvalidResponseSchema.parse(response.json());
    expect(body.errors.map((error) => error.code)).toContain(code);
    expect(body.errors).toEqual(readPgnRepertoire(request.pgn, "white", change.weights).errors);
    expect(tables()).toEqual(before);
  });

  it("keeps the reader's cap of 20 problems", async () => {
    const weights = `reach\tloss_cp\tline\n${"half\t3\t1. d4\n".repeat(30)}`;
    const response = await importPgn({ ...LONDON, weights });

    const body = ImportPgnInvalidResponseSchema.parse(response.json());
    expect(body.errors).toHaveLength(20);
  });

  it("logs the codes of the problems and never the text of the file", async () => {
    await importPgn({ ...LONDON, pgn: ILLEGAL });

    expect(refusalLogged("invalid_pgn")).toEqual([
      {
        level: "warn",
        event: "repertoire.import_refused",
        fields: expect.objectContaining({
          operation: "import",
          code: "invalid_pgn",
          side: "white",
          group: "London System",
          variation: "Main line",
          dry_run: false,
          errors: 1,
          error_codes: ["illegal_move"],
        }),
      },
    ]);
    expect(JSON.stringify(log.events)).not.toContain("SECRETCOMMENT");
  });
});

describe("a refusal of the sync", () => {
  const generated = (group: string, variation: string): number =>
    createRepertoireVariation(db, { side: "white", groupName: group, variationName: variation }).id;

  async function expectRefused(payload: unknown, code: string): Promise<void> {
    const before = tables();
    const response = await importPgn(payload);

    expect(response.statusCode).toBe(409);
    const refusal = RepertoireImportRefusalSchema.parse(response.json());
    expect(refusal.error).toBe(code);
    expect(refusal.message.length).toBeGreaterThan(10);
    expect(tables()).toEqual(before);
    expect(refusalLogged(code)).toHaveLength(1);
  }

  it("answers 409 not_imported for a line the app built, and leaves it alone", async () => {
    const id = generated("London System", "Main line");
    await expectRefused(LONDON, "not_imported");
    expect(ownRowsOf(id)).toBe(0);
  });

  it("answers 409 group_taken when the group holds a line the app built", async () => {
    generated("London System", "Built by the app");
    await expectRefused(LONDON, "group_taken");
  });

  it("answers 409 invalid_name for a name that hides as a rebuild's working copy", async () => {
    await expectRefused({ ...LONDON, group: "London System (rebuilding)" }, "invalid_name");
  });

  it("answers 409 empty for a file that holds no move of the student's side", async () => {
    await expectRefused({ ...LONDON, side: "black", pgn: "1. e4 *" }, "empty");
  });

  it("answers 409 drill_open while a drill uses the line, and imports again once it ends", async () => {
    const id = await importedId(LONDON);
    const service = openDrillService();
    const drill = await startDrill(service, id);

    await expectRefused({ ...LONDON, pgn: LONDON_EDITED }, "drill_open");

    await service.endTraining(drill.activity_id);
    expect((await importPgn({ ...LONDON, pgn: LONDON_EDITED })).statusCode).toBe(200);
  });

  it("refuses a dry run for the same reasons", async () => {
    generated("London System", "Main line");
    const response = await importPgn({ ...LONDON, dry_run: true });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "not_imported" });
  });
});

describe("a dry run", () => {
  it("answers what a real run would, and the list does not change", async () => {
    const before = tables();
    const response = await importPgn({ ...LONDON, dry_run: true });

    expect(response.statusCode).toBe(200);
    const dry = ImportPgnResponseSchema.parse(response.json());
    expect(dry.dry_run).toBe(true);
    expect(dry.summary).toMatchObject({ created: true, own_added: 4, own_removed: 0, own_kept: 0 });
    expect(tables()).toEqual(before);
    expect((await listRepertoires()).repertoires).toEqual([]);

    const real = ImportPgnResponseSchema.parse((await importPgn(LONDON)).json());
    expect(real.summary).toEqual(dry.summary);
    expect(real.counts).toEqual(dry.counts);
  });

  it("says what a second import would add, remove and keep, before it does", async () => {
    await importPgn(LONDON);
    const before = tables();

    const dry = ImportPgnResponseSchema.parse(
      (await importPgn({ ...LONDON, pgn: LONDON_EDITED, dry_run: true })).json(),
    );

    expect(dry.summary).toMatchObject({
      created: false,
      own_added: 1,
      own_removed: 1,
      own_kept: 3,
    });
    expect(tables()).toEqual(before);
    const real = ImportPgnResponseSchema.parse(
      (await importPgn({ ...LONDON, pgn: LONDON_EDITED })).json(),
    );
    expect(real.summary).toEqual(dry.summary);
  });
});

describe("a real run", () => {
  it("answers the reader's counts and the sync's summary, and the list shows the unit as imported", async () => {
    const response = await importPgn({
      ...LONDON,
      group: "  London System ",
      variation: " Main line  ",
    });

    expect(response.statusCode).toBe(200);
    const body = ImportPgnResponseSchema.parse(response.json());
    expect(body.dry_run).toBe(false);
    expect(body.counts).toEqual(readPgnRepertoire(LONDON_FILE, "white").counts);
    expect(body.counts).toMatchObject({ games: 1, own_moves: 4, replies: 3, reasons: 2 });
    expect(body.summary).toMatchObject({ created: true, own_added: 4, replies_added: 3 });

    const list = await listRepertoires();
    const unit = list.repertoires.find((entry) => entry.id === body.summary.repertoire_id);
    expect(unit).toMatchObject({
      origin: "pgn",
      side: "white",
      group_name: "London System",
      variation_name: "Main line",
      moves_total: body.counts.own_moves,
    });
    expect(unit?.moves_total).toBe(ownRowsOf(body.summary.repertoire_id));
    expect(list.groups?.map((group) => [group.side, group.group_name])).toEqual([
      ["white", "London System"],
    ]);
  });

  it("hands the weights to the reader, which counts what they matched and the move keeps", async () => {
    const pgn = "1. d4 d5 2. Bf4 *";
    const weights = "reach\tloss_cp\tline\n0.5\t3\t1. d4\n";
    const response = await importPgn({ ...LONDON, pgn, weights });

    const body = ImportPgnResponseSchema.parse(response.json());
    expect(body.counts).toMatchObject({ weights_matched: 1, weights_unmatched: 0 });
    expect(body.counts).toEqual(readPgnRepertoire(pgn, "white", weights).counts);
    const stored = db
      .prepare("SELECT cp_loss, reach FROM repertoire_positions WHERE move_san = 'd4'")
      .get();
    expect(stored).toEqual({ cp_loss: 3, reach: 0.5 });
  });

  it("keeps one unit when the same file comes again, and none of its moves change", async () => {
    const id = await importedId(LONDON);
    const rowIds = () => db.prepare("SELECT id FROM repertoire_positions ORDER BY id").all();
    const before = rowIds();

    const again = ImportPgnResponseSchema.parse((await importPgn(LONDON)).json());

    expect(again.summary).toMatchObject({
      repertoire_id: id,
      created: false,
      own_added: 0,
      own_removed: 0,
      own_kept: 4,
      replies_kept: 3,
    });
    expect(rowIds()).toEqual(before);
    expect((await listRepertoires()).repertoires).toHaveLength(1);
  });

  it("keeps the moves and the reasons the file still holds, and drops the ones it dropped", async () => {
    const id = await importedId(LONDON);
    const ideaOf = (san: string) =>
      db
        .prepare("SELECT idea FROM repertoire_positions WHERE repertoire_id = ? AND move_san = ?")
        .get(id, san) as { idea: string | null } | undefined;
    const d4 = db.prepare("SELECT id FROM repertoire_positions WHERE move_san = 'd4'").get();

    const edited = ImportPgnResponseSchema.parse(
      (await importPgn({ ...LONDON, pgn: LONDON_WITHOUT_E3 })).json(),
    );

    expect(edited.summary).toMatchObject({ own_added: 1, own_removed: 2, own_kept: 2 });
    expect(edited.summary.reasons_removed).toEqual([
      { line: ["d4", "d5", "Bf4", "Nf6"], move: "e3", text: E3_REASON },
    ]);
    expect(db.prepare("SELECT id FROM repertoire_positions WHERE move_san = 'd4'").get()).toEqual(
      d4,
    );
    expect(ideaOf("Bf4")?.idea).toBe(BF4_REASON);
    expect(ideaOf("e3")).toBeUndefined();
  });

  it("imports a Black line next to a White one, in a group of its own", async () => {
    await importPgn(LONDON);
    const black = await importedId({
      side: "black",
      group: "Caro-Kann",
      variation: "Classical",
      pgn: CARO_KANN_FILE,
    });

    const list = await listRepertoires();
    expect(list.repertoires.map((unit) => [unit.side, unit.group_name])).toEqual([
      ["white", "London System"],
      ["black", "Caro-Kann"],
    ]);
    expect(list.sides?.map((entry) => entry.side).sort()).toEqual(["black", "white"]);
    expect(ownRowsOf(black)).toBeGreaterThanOrEqual(12);
  });
});

describe("DELETE /api/repertoires/:id", () => {
  async function importedWithACard(): Promise<number> {
    const id = await importedId(LONDON);
    const own = db
      .prepare("SELECT position_key, move_uci FROM repertoire_positions WHERE move_san = 'Bf4'")
      .get() as { position_key: string; move_uci: string };
    introduceRepertoireCard(db, { positionKey: own.position_key, uci: own.move_uci }, AT);
    return id;
  }
  const cardRows = () => db.prepare("SELECT COUNT(*) AS n FROM repertoire_cards").get();

  it("removes the unit, its moves and the cards no other unit stores, and answers the summary", async () => {
    const id = await importedWithACard();

    const response = await removeLine(id);

    expect(response.statusCode).toBe(200);
    const body = DeleteImportedResponseSchema.parse(response.json());
    expect(body.dry_run).toBe(false);
    expect(body.summary).toMatchObject({
      repertoire_id: id,
      own_removed: 4,
      replies_removed: 3,
      cards_deleted: 1,
      cards_kept: 0,
    });
    expect(body.summary.reasons_removed.map((reason) => reason.text).sort()).toEqual(
      [BF4_REASON, E3_REASON].sort(),
    );
    expect((await listRepertoires()).repertoires).toEqual([]);
    expect(cardRows()).toEqual({ n: 0 });
    expect(ownRowsOf(id)).toBe(0);
  });

  it("answers the same summary with ?dry_run=true and deletes nothing", async () => {
    const id = await importedWithACard();
    const before = tables();

    const dry = DeleteImportedResponseSchema.parse((await removeLine(id, "?dry_run=true")).json());

    expect(dry.dry_run).toBe(true);
    expect(dry.summary).toMatchObject({ own_removed: 4, cards_deleted: 1 });
    expect(tables()).toEqual(before);
    const real = DeleteImportedResponseSchema.parse(
      (await removeLine(id, "?dry_run=false")).json(),
    );
    expect(real.summary).toEqual(dry.summary);
    expect((await listRepertoires()).repertoires).toEqual([]);
  });

  it.each([
    "?dry_run=yes",
    "?dry_run=1",
    "?dry_run=",
    "?dry_run=TRUE",
    "?dry_run=true&dry_run=true",
    // The typo that would otherwise delete for real when a dry run was meant.
    "?dryrun=true",
    "?dry_run=true&force=1",
  ])("answers 400 invalid_request for %s and deletes nothing", async (query) => {
    const id = await importedId(LONDON);
    const before = tables();

    const response = await removeLine(id, query);

    expect(response.statusCode).toBe(400);
    expect(RepertoireImportRefusalSchema.parse(response.json()).error).toBe("invalid_request");
    expect(tables()).toEqual(before);
    expect(refusalLogged("invalid_request")).toHaveLength(1);
  });

  it.each(["abc", "0", "-1", "1.5", "01", "1e3", "12345678901234567890"])(
    "answers 400 invalid_request for the id %s",
    async (id) => {
      const response = await removeLine(id);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_request" });
    },
  );

  it("answers 404 not_found for an id no line has", async () => {
    const before = tables();
    const response = await removeLine(9999);

    expect(response.statusCode).toBe(404);
    expect(RepertoireImportRefusalSchema.parse(response.json()).error).toBe("not_found");
    expect(tables()).toEqual(before);
    expect(refusalLogged("not_found")).toHaveLength(1);
  });

  it("answers 409 not_imported for a line the app built, and keeps it", async () => {
    const { id } = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Classical Variation (4.c3)",
    });
    const before = tables();

    const response = await removeLine(id);

    expect(response.statusCode).toBe(409);
    expect(RepertoireImportRefusalSchema.parse(response.json()).error).toBe("not_imported");
    expect(tables()).toEqual(before);
  });

  it("answers 409 drill_open while a drill uses the line", async () => {
    const id = await importedId(LONDON);
    const service = openDrillService();
    const drill = await startDrill(service, id);
    const before = tables();

    const response = await removeLine(id);

    expect(response.statusCode).toBe(409);
    expect(RepertoireImportRefusalSchema.parse(response.json()).error).toBe("drill_open");
    expect(tables()).toEqual(before);
    expect((await removeLine(id, "?dry_run=true")).statusCode).toBe(409);

    await service.endTraining(drill.activity_id);
    expect((await removeLine(id)).statusCode).toBe(200);
  });

  it("answers 404 for the same id the second time", async () => {
    const id = await importedId(LONDON);
    await removeLine(id);

    expect((await removeLine(id)).statusCode).toBe(404);
  });
});

describe("the log", () => {
  it("records an import with its side, names, counts and duration, and a dry run with dry_run true", async () => {
    await importPgn({ ...LONDON, dry_run: true });
    await importPgn(LONDON);

    const [dry, real] = log.named("repertoire.import");
    expect(dry?.fields).toMatchObject({ dry_run: true });
    expect(real).toMatchObject({ level: "info" });
    expect(real?.fields).toMatchObject({
      side: "white",
      group: "London System",
      variation: "Main line",
      dry_run: false,
      games: 1,
      own_moves: 4,
      replies: 3,
      reasons: 2,
      comments_ignored: 0,
      unanswered_replies: 0,
      weights_matched: 0,
      weights_unmatched: 0,
      created: true,
      own_added: 4,
      own_removed: 0,
      own_kept: 0,
      replies_added: 3,
      cards_deleted: 0,
    });
    const duration = real?.fields.duration_ms;
    expect(Number.isInteger(duration) && (duration as number) >= 0).toBe(true);
  });

  it("records a delete with the unit's id and counts", async () => {
    const id = await importedId(LONDON);
    await removeLine(id, "?dry_run=true");
    await removeLine(id);

    const [dry, real] = log.named("repertoire.import_deleted");
    expect(dry?.fields).toMatchObject({ dry_run: true, repertoire_id: id });
    expect(real).toMatchObject({ level: "info" });
    expect(real?.fields).toMatchObject({
      dry_run: false,
      repertoire_id: id,
      own_removed: 4,
      replies_removed: 3,
      reasons_removed: 2,
      cards_deleted: 0,
      cards_kept: 0,
    });
  });

  it("never carries the text of the file or the reasons written in it", async () => {
    const id = await importedId(LONDON);
    await importPgn({ ...LONDON, pgn: LONDON_WITHOUT_E3 });
    await importPgn({ ...LONDON, pgn: "1. d4 d5 2. Bxx *" });
    await removeLine(id);

    const written = JSON.stringify(log.events);
    for (const text of [BF4_REASON, E3_REASON, "pawn chain", "retreat", "Bxx", "1. d4 d5"]) {
      expect(written).not.toContain(text);
    }
    expect(log.named("repertoire.import")).toHaveLength(2);
    expect(log.named("repertoire.import_deleted")).toHaveLength(1);
  });
});

describe("end to end: import a Black file, then drill it", () => {
  it("lists the line under black and serves a drill whose board is turned to Black after White's first move", async () => {
    const id = await importedId({
      side: "black",
      group: "Caro-Kann",
      variation: "Classical",
      pgn: CARO_KANN_FILE,
    });

    const list = await listRepertoires();
    const unit = list.repertoires.find((entry) => entry.id === id);
    const own = ownRowsOf(id);
    expect(own).toBeGreaterThanOrEqual(12);
    expect(unit).toMatchObject({ side: "black", origin: "pgn", moves_total: own });
    expect(unit?.moves.all).toBe(own);

    const service = openDrillService();
    const state: TrainingActivity = await startDrill(service, id);

    expect(state.orientation).toBe("black");
    expect(state.turn).toBe("black");
    expect((state.moves ?? []).map((move) => [move.san, move.by])).toEqual([["e4", "reply"]]);
    expect(state.status).toBe("prompt");
    expect(state.input_enabled).toBe(true);
    expect(state.item).toMatchObject({ kind: "repertoire", repertoire_id: id });
    expect(state.repertoire).toMatchObject({ first_pass: true, answer: { san: "c6" } });
  });
});

// The routes are meant to be driven by hand with curl, so the page that says how is held to the
// code: a code or an event added without a line there fails here.
describe("AGENTS.md", () => {
  const agents = readFileSync(new URL("../../../../AGENTS.md", import.meta.url), "utf8");
  const between = (from: string, to: string): string =>
    agents.slice(agents.indexOf(from), agents.indexOf(to));
  const imported = between("- **Imported repertoire:**", "- **Card scheduling:**");

  it("states the two routes, every code they answer and the command that sends a file", () => {
    expect(imported).toContain("`POST /api/repertoires/import-pgn`");
    expect(imported).toContain("`DELETE /api/repertoires/:id`");
    const codes = [
      "invalid_request",
      "origin_not_allowed",
      "invalid_pgn",
      "not_imported",
      "group_taken",
      "invalid_name",
      "empty",
      "drill_open",
      "not_found",
    ];
    for (const code of codes) expect(imported).toContain(`\`${code}\``);
  });

  it("gives a command that sends a file with the Origin and Host the guard needs, and one that deletes", () => {
    const [send, remove] = [...imported.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
    expect(send).toContain("jq -n --rawfile pgn");
    expect(send).toContain("curl -sS -X POST http://127.0.0.1:3210/api/repertoires/import-pgn");
    expect(send).toContain("-H 'Origin: http://localhost:5173'");
    expect(send).toContain("-H 'Host: localhost:5173'");
    expect(remove).toContain("curl -sS -X DELETE");
    expect(remove).toContain("-H 'Origin: http://localhost:5173'");
  });

  it("says what a second import keeps and removes, and what leaves an imported line alone", () => {
    const flat = imported.replace(/\s+/g, " ");
    expect(flat).toContain("A second import of the same names");
    expect(flat).toContain("keeps its row, its schedule and its stored reason");
    expect(flat).toContain("`summary.reasons_removed`");
    expect(flat).toContain(
      "left alone by the idea writer, the game review, the rebuild and the coverage figure",
    );
  });

  it("lists the three events in the Logs section", () => {
    const events = between("- **Events:**", "- **Reading:**");
    for (const event of ["import", "import_refused", "import_deleted"]) {
      expect(events).toContain(`\`repertoire.${event}\``);
    }
  });
});
