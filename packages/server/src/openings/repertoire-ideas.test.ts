import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { COACH_MODEL } from "../coach/session.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  type NewRepertoireOwnMove,
  setRepertoireIdea,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { boundFields, RecordingLog } from "../log.js";
import {
  generateRepertoireIdeas,
  type IdeaQueryFn,
  type IdeaSession,
  IdeaSessionError,
  ideaPrompt,
  ideaRejection,
  MAX_IDEA_CHARS,
  sdkIdeaSession,
} from "./repertoire-ideas.js";

const GOOD_IDEA = "Develops with a threat: the bishop eyes the weakest point in Black's camp.";

/** Answers each prompt from a function a test writes, and keeps every prompt it was given. */
class ScriptedIdeaSession implements IdeaSession {
  readonly prompts: string[] = [];

  constructor(private readonly answer: (prompt: string, call: number) => string) {}

  async write(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.answer(prompt, this.prompts.length);
  }
}

const always = (text: string) => new ScriptedIdeaSession(() => text);

/** The SAN a prompt asks to explain, so a script can answer with exactly what the check forbids. */
const moveOf = (prompt: string): string => /Move to explain: \d+\.(\S+)/.exec(prompt)?.[1] ?? "";

interface StoredRow {
  id: number;
  kind: string;
  move_san: string;
  idea: string | null;
}

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-ideas-"));
  db = openDatabase(tmp);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const ownMove = (
  repertoireId: number,
  line: string[],
  san: string,
  uci: string,
  evalCp: number,
): NewRepertoireOwnMove => ({
  repertoireId,
  positionKey: `${repertoireId}-${line.length}`,
  ply: line.length + 1,
  line,
  reach: 1,
  openingName: null,
  uci,
  san,
  share: null,
  source: "engine",
  cpLoss: 0,
  evalCp,
  results: null,
});

/**
 * Four White moves, three Black replies on the way, and a Black repertoire that must be ignored.
 * `deepestFirst` stores the moves in the opposite order of their plies.
 */
function seedRepertoires(deepestFirst = false): void {
  const white = createRepertoireVariation(db, {
    side: "white",
    groupName: "Italian Game",
    variationName: "Classical Variation (4.c3)",
  }).id;
  const moves: Array<[string[], string, string, number]> = [
    [[], "e4", "e2e4", 30],
    [["e4", "e5"], "Nf3", "g1f3", 25],
    [["e4", "e5", "Nf3", "Nc6"], "Bc4", "f1c4", 28],
    [["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], "c3", "c2c3", 22],
  ];
  for (const [line, san, uci, evalCp] of deepestFirst ? moves.reverse() : moves) {
    insertRepertoireOwnMove(db, ownMove(white, line, san, uci, evalCp));
  }
  const replies: Array<[string[], string, string]> = [
    [["e4"], "e5", "e7e5"],
    [["e4", "e5", "Nf3"], "Nc6", "b8c6"],
    [["e4", "e5", "Nf3", "Nc6", "Bc4"], "Bc5", "f8c5"],
  ];
  for (const [line, san, uci] of replies) {
    upsertRepertoireReply(db, {
      ...ownMove(white, line, san, uci, 0),
      positionKey: `${white}-reply-${line.length}`,
      share: 0.5,
      source: "explorer",
    });
  }
  const black = createRepertoireVariation(db, {
    side: "black",
    groupName: "Sicilian Defense",
    variationName: "Open Sicilian",
  }).id;
  insertRepertoireOwnMove(db, ownMove(black, ["e4"], "c5", "c7c5", 20));
}

const rowsOf = (): StoredRow[] =>
  db
    .prepare("SELECT id, kind, move_san, idea FROM repertoire_positions ORDER BY id")
    .all() as StoredRow[];

const ideaOf = (san: string, kind = "own"): string | null =>
  rowsOf().find((row) => row.move_san === san && row.kind === kind)?.idea ?? null;

describe("ideaRejection", () => {
  const bishop = { san: "Bc4", uci: "f1c4" };
  /** The reason a text is refused, or "accepted": a failure then reads as a string, not a null. */
  const verdict = (text: string, move = bishop): string => ideaRejection(text, move) ?? "accepted";

  it("lets through a text that explains the move without naming it", () => {
    expect(verdict("The bishop aims at f7, Black's weakest point.")).toBe("accepted");
  });

  it("refuses an empty text", () => {
    expect(verdict("")).toMatch(/empty/);
  });

  it("allows 200 characters and refuses 201", () => {
    expect(verdict("a".repeat(MAX_IDEA_CHARS))).toBe("accepted");
    expect(verdict("a".repeat(MAX_IDEA_CHARS + 1))).toMatch(/201 characters/);
  });

  it("refuses the move's notation, however it is capitalized", () => {
    expect(verdict("Develop with Bc4 toward f7.")).toMatch(/notation Bc4/);
    expect(verdict("Develop with BC4 toward f7.")).toMatch(/notation Bc4/);
  });

  it("refuses castling written with letters or with zeros, and without its check sign", () => {
    const castles = { san: "O-O+", uci: "e1g1" };
    expect(verdict("Castle with O-O at last.", castles)).toMatch(/notation/);
    expect(verdict("Castle with 0-0 at last.", castles)).toMatch(/notation/);
  });

  it("refuses the square the piece moves to, even without the piece letter", () => {
    expect(verdict("The bishop lands on c4 and eyes f7.")).toMatch(/square c4/);
    expect(verdict("The bishop lands on C4 and eyes f7.")).toMatch(/square c4/);
  });

  it("refuses the king's square when the move is castling", () => {
    expect(verdict("The king hides on g1.", { san: "O-O", uci: "e1g1" })).toMatch(/square g1/);
  });

  it("allows a square the piece does not move to", () => {
    expect(verdict("It pressures f7 and keeps d4 in reach.")).toBe("accepted");
  });
});

describe("ideaPrompt", () => {
  const target = {
    id: 1,
    variationName: "Classical Variation (4.c3)",
    ply: 5,
    line: ["e4", "e5", "Nf3", "Nc6"],
    san: "Bc4",
    uci: "f1c4",
    evalCp: 28,
  };

  it("gives the variation, the line so far, the move and the evaluation", () => {
    const prompt = ideaPrompt(target, null);
    expect(prompt).toContain("Variation: Classical Variation (4.c3)");
    expect(prompt).toContain("Moves so far: 1.e4 e5 2.Nf3 Nc6");
    expect(prompt).toContain("Move to explain: 3.Bc4");
    expect(prompt).toContain("Engine evaluation after the move: +0.28 pawns");
  });

  it("says so when the move is the first of the game", () => {
    const prompt = ideaPrompt({ ...target, ply: 1, line: [], san: "e4" }, null);
    expect(prompt).toContain("Moves so far: none");
    expect(prompt).toContain("Move to explain: 1.e4");
  });

  it("reads the evaluation from White's side, with a mate as a mate", () => {
    expect(ideaPrompt({ ...target, evalCp: -40 }, null)).toContain("-0.40 pawns");
    expect(ideaPrompt({ ...target, evalCp: 10000 }, null)).toContain("White has a forced mate");
    expect(ideaPrompt({ ...target, evalCp: -10000 }, null)).toContain("Black has a forced mate");
  });

  it("names the refusal only on a retry", () => {
    expect(ideaPrompt(target, null)).not.toContain("refused");
    expect(ideaPrompt(target, "the text is empty")).toContain("refused because the text is empty");
  });
});

describe("generateRepertoireIdeas", () => {
  it("writes an idea for each White move and for nothing else", async () => {
    seedRepertoires();
    const session = always(GOOD_IDEA);
    const result = await generateRepertoireIdeas(db, session);
    expect(result).toEqual({ considered: 4, generated: 4, rejected: 0, empty: 0 });
    for (const san of ["e4", "Nf3", "Bc4", "c3"]) expect(ideaOf(san)).toBe(GOOD_IDEA);
    expect(rowsOf().filter((row) => row.idea !== null)).toHaveLength(4);
    expect(session.prompts).toHaveLength(4);
  });

  it("asks for the shallowest moves first", async () => {
    seedRepertoires(true);
    const session = always(GOOD_IDEA);
    await generateRepertoireIdeas(db, session);
    expect(session.prompts.map((prompt) => /Move to explain: (\S+)/.exec(prompt)?.[1])).toEqual([
      "1.e4",
      "2.Nf3",
      "3.Bc4",
      "4.c3",
    ]);
  });

  it("generates nothing on a rerun, and leaves a stored text as it is", async () => {
    seedRepertoires();
    await generateRepertoireIdeas(db, always(GOOD_IDEA));
    const second = always("A different text that must never be stored.");
    const result = await generateRepertoireIdeas(db, second);
    expect(result).toEqual({ considered: 0, generated: 0, rejected: 0, empty: 0 });
    expect(second.prompts).toEqual([]);
    expect(ideaOf("Bc4")).toBe(GOOD_IDEA);
  });

  it("does not ask for a move that already has an idea", async () => {
    seedRepertoires();
    db.prepare("UPDATE repertoire_positions SET idea = ? WHERE move_san = 'Nf3'").run("Kept.");
    const session = always(GOOD_IDEA);
    const result = await generateRepertoireIdeas(db, session);
    expect(result.considered).toBe(3);
    expect(session.prompts.some((prompt) => prompt.includes("Move to explain: 2.Nf3"))).toBe(false);
    expect(ideaOf("Nf3")).toBe("Kept.");
  });

  it("refuses a text that names the move, retries once and stores the second", async () => {
    seedRepertoires();
    const session = new ScriptedIdeaSession((prompt) =>
      prompt.includes("refused") ? GOOD_IDEA : `Play ${moveOf(prompt)} to gain time.`,
    );
    const result = await generateRepertoireIdeas(db, session);
    expect(result).toEqual({ considered: 4, generated: 4, rejected: 4, empty: 0 });
    expect(session.prompts).toHaveLength(8);
    expect(session.prompts[1]).toContain("refused because the text contains the move's notation");
    expect(ideaOf("e4")).toBe(GOOD_IDEA);
  });

  it("leaves a move empty after two refusals, and a rerun tries it again", async () => {
    seedRepertoires();
    const stubborn = new ScriptedIdeaSession((prompt) =>
      prompt.includes("3.Bc4") ? "It lands on c4 to aim at f7." : GOOD_IDEA,
    );
    const first = await generateRepertoireIdeas(db, stubborn);
    expect(first).toEqual({ considered: 4, generated: 3, rejected: 2, empty: 1 });
    expect(ideaOf("Bc4")).toBeNull();
    const second = await generateRepertoireIdeas(db, always(GOOD_IDEA));
    expect(second).toEqual({ considered: 1, generated: 1, rejected: 0, empty: 0 });
    expect(ideaOf("Bc4")).toBe(GOOD_IDEA);
  });

  it("never overwrites a text that is already stored", () => {
    seedRepertoires();
    const nf3 = rowsOf().find((row) => row.move_san === "Nf3");
    expect(setRepertoireIdea(db, nf3?.id ?? 0, "First.")).toBe(true);
    expect(setRepertoireIdea(db, nf3?.id ?? 0, "Second.")).toBe(false);
    expect(ideaOf("Nf3")).toBe("First.");
  });

  it("refuses a text over 200 characters", async () => {
    seedRepertoires();
    const result = await generateRepertoireIdeas(db, always("x".repeat(MAX_IDEA_CHARS + 1)));
    expect(result).toEqual({ considered: 4, generated: 0, rejected: 8, empty: 4 });
    expect(rowsOf().every((row) => row.idea === null)).toBe(true);
  });

  it("stores a text on one line with no padding", async () => {
    seedRepertoires();
    await generateRepertoireIdeas(
      db,
      always("  Takes the center,\n and opens the   bishop's diagonal.\n"),
    );
    expect(ideaOf("e4")).toBe("Takes the center, and opens the bishop's diagonal.");
  });

  it("logs each refused text cut short of the log's field limit", async () => {
    seedRepertoires();
    const log = new RecordingLog();
    await generateRepertoireIdeas(db, always("Bc4 ".repeat(5_000)), log);
    const refused = log.named("openings.idea_rejected");
    expect(refused).toHaveLength(8);
    expect(refused[0]?.fields).toMatchObject({ ply: 1, attempt: 1 });
    expect(refused[1]?.fields).toMatchObject({ ply: 1, attempt: 2 });
    for (const entry of refused) {
      expect(boundFields(entry.fields).truncated).toBe(false);
      expect(String(entry.fields.text).length).toBeLessThanOrEqual(300);
    }
  });

  it("keeps what it wrote when the session stops answering", async () => {
    seedRepertoires();
    const session = new ScriptedIdeaSession((_prompt, call) => {
      if (call === 3) throw new IdeaSessionError("5-hour limit reached");
      return GOOD_IDEA;
    });
    await expect(generateRepertoireIdeas(db, session)).rejects.toThrow("5-hour limit reached");
    expect(ideaOf("e4")).toBe(GOOD_IDEA);
    expect(ideaOf("Nf3")).toBe(GOOD_IDEA);
    expect(ideaOf("Bc4")).toBeNull();
    const resumed = always(GOOD_IDEA);
    expect(await generateRepertoireIdeas(db, resumed)).toMatchObject({
      considered: 2,
      generated: 2,
    });
  });
});

describe("through the route", () => {
  const post = (app: ReturnType<typeof buildApp>) =>
    app.inject({
      method: "POST",
      url: "/api/openings/generate",
      payload: { sources: ["repertoire-ideas"] },
    });

  it("fills the column, logs the counts, and generates nothing on a rerun", async () => {
    seedRepertoires();
    const log = new RecordingLog();
    const session = always(GOOD_IDEA);
    const app = buildApp({
      db,
      log,
      generateOpenings: async () => ({ positions: 0, created: 0, updated: 0 }),
      generateRepertoireIdeas: () => generateRepertoireIdeas(db, session, log),
    });
    const first = await post(app);
    const second = await post(app);
    await app.close();
    expect(first.json()).toEqual({
      repertoireIdeas: { considered: 4, generated: 4, rejected: 0, empty: 0 },
    });
    expect(second.json()).toEqual({
      repertoireIdeas: { considered: 0, generated: 0, rejected: 0, empty: 0 },
    });
    expect(session.prompts).toHaveLength(4);
    const logged = log.named("openings.generate")[0];
    expect(logged?.fields).toMatchObject({
      sources: ["repertoire-ideas"],
      result: { repertoireIdeas: { generated: 4, rejected: 0, empty: 0 } },
    });
    expect(boundFields(logged?.fields ?? {}).truncated).toBe(false);
  });
});

describe("sdkIdeaSession", () => {
  const result = (fields: Record<string, unknown>): SDKMessage =>
    ({ type: "result", ...fields }) as unknown as SDKMessage;
  const answered = (text: string): SDKMessage =>
    result({ subtype: "success", is_error: false, result: text });

  /** Plays the stream a test writes for each call, and keeps what the call was made with. */
  class ScriptedIdeaQuery {
    readonly calls: Array<{ prompt: string; options: Options }> = [];
    closed = 0;

    constructor(private readonly stream: (options: Options) => AsyncIterable<SDKMessage>) {}

    readonly query: IdeaQueryFn = ({ prompt, options }) => {
      this.calls.push({ prompt, options });
      return Object.assign(this.stream(options), {
        close: () => {
          this.closed += 1;
        },
      });
    };
  }

  async function* streamOf(...messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
    for (const message of messages) yield message;
  }

  const sessionOver = (fake: ScriptedIdeaQuery, extra: { timeoutMs?: number } = {}) =>
    sdkIdeaSession(fake.query, { cwd: tmp, env: { PATH: "/bin" }, ...extra });

  it("returns the text of the answer", async () => {
    const fake = new ScriptedIdeaQuery(() => streamOf(answered("It frees the bishop.")));
    expect(await sessionOver(fake).write("the prompt")).toBe("It frees the bishop.");
    expect(fake.calls[0]?.prompt).toBe("the prompt");
  });

  it("runs under the coach's restrictions: no connectors, no tools, no settings", async () => {
    const fake = new ScriptedIdeaQuery(() => streamOf(answered("ok")));
    await sessionOver(fake).write("the prompt");
    const options = fake.calls[0]?.options;
    expect(options).toMatchObject({
      strictMcpConfig: true,
      tools: [],
      settingSources: [],
      model: COACH_MODEL,
      maxTurns: 1,
      persistSession: false,
      cwd: tmp,
    });
    expect(options?.mcpServers).toBeUndefined();
    expect(options?.env).toMatchObject({ PATH: "/bin", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(String(options?.systemPrompt)).toContain("Never write the move");
  });

  it("closes the stream once it has the answer", async () => {
    const fake = new ScriptedIdeaQuery(() => streamOf(answered("ok")));
    await sessionOver(fake).write("the prompt");
    expect(fake.closed).toBe(1);
  });

  it("throws when the turn ended on an error", async () => {
    const fake = new ScriptedIdeaQuery(() =>
      streamOf(result({ subtype: "error_max_turns", is_error: true, errors: ["too many turns"] })),
    );
    await expect(sessionOver(fake).write("p")).rejects.toThrow(IdeaSessionError);
    await expect(sessionOver(fake).write("p")).rejects.toThrow("too many turns");
  });

  it("throws the error text when a success result is flagged as an error", async () => {
    const fake = new ScriptedIdeaQuery(() =>
      streamOf(result({ subtype: "success", is_error: true, result: "5-hour limit reached" })),
    );
    await expect(sessionOver(fake).write("p")).rejects.toThrow("5-hour limit reached");
  });

  it("reports a crashed process as the session's own error", async () => {
    async function* crashes(): AsyncGenerator<SDKMessage> {
      yield* [];
      throw new Error("Claude Code process exited with code 1");
    }
    const fake = new ScriptedIdeaQuery(crashes);
    await expect(sessionOver(fake).write("p")).rejects.toThrow(IdeaSessionError);
    await expect(sessionOver(fake).write("p")).rejects.toThrow("exited with code 1");
  });

  it("throws when the stream ends without an answer", async () => {
    const fake = new ScriptedIdeaQuery(() => streamOf());
    await expect(sessionOver(fake).write("p")).rejects.toThrow("without an answer");
  });

  it("gives up on a call that never answers, and closes it", async () => {
    const hangs = (options: Options): AsyncIterable<SDKMessage> => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<SDKMessage>>((_resolve, reject) => {
            options.abortController?.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      }),
    });
    const fake = new ScriptedIdeaQuery(hangs);
    await expect(sessionOver(fake, { timeoutMs: 20 }).write("p")).rejects.toThrow(
      "no answer within 20 ms",
    );
    expect(fake.closed).toBe(1);
  });
});
