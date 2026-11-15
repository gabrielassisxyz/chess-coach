import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FoundPosition,
  getFoundNote,
  insertFoundPosition,
  setFoundNote,
} from "../db/found-positions.js";
import { listMoves, setGrading } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import { importFinishedGame } from "../import/pgn.js";
import { boundFields, RecordingLog } from "../log.js";
import {
  FOUND_NOTE_SYSTEM_PROMPT,
  type FoundNoteTarget,
  foundNotePrompt,
  foundNoteRejection,
  foundNoteTargetOf,
  generateFoundNotes,
} from "./found-notes.js";
import { type IdeaSession, IdeaSessionError, MAX_IDEA_CHARS } from "./repertoire-ideas.js";

const GOOD_NOTE = "Keeps the pawn chain safe and points the bishop at the weakest spot.";
const FOUND_AT = "2026-11-10T12:00:00.000Z";

/** Answers each prompt from a function a test writes, and keeps every prompt it was given. */
class ScriptedNoteSession implements IdeaSession {
  readonly prompts: string[] = [];

  constructor(private readonly answer: (prompt: string, call: number) => string) {}

  async write(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.answer(prompt, this.prompts.length);
  }
}

const always = (text: string) => new ScriptedNoteSession(() => text);

/** The first line of a prompt that starts with `label`, so a script can read what it was asked. */
const lineOf = (prompt: string, label: string): string =>
  prompt.split("\n").find((line) => line.startsWith(label)) ?? "";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-found-notes-"));
  db = openDatabase(tmp);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// The student plays White, so plies 1, 3 and 5 are theirs: e4, Nf3 and Bb5.
const WHITE_GAME = '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0';
// The student plays Black, so plies 2 and 4 are theirs: e5 and Nc6.
const BLACK_GAME = '[Result "0-1"]\n\n1. e4 e5 2. Nf3 Nc6 0-1';
// Ends on Black's move, so the student, playing White, was to move in the last position.
const ENDED_ON_OPPONENT = '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 1-0';

function importGame(pgn: string, color: "white" | "black", sourceId: string): number {
  const gameId = importFinishedGame(db, {
    pgn,
    playerColor: color,
    source: "pgn",
    sourceId,
    opponent: "rival",
    playedAt: "2026-11-01T12:00:00.000Z",
  });
  if (gameId === null) throw new Error("fixture game was not imported");
  setGrading(db, gameId, "done");
  return gameId;
}

/** What the grader stored for one move: the student's view of the position before it. */
function grade(
  gameId: number,
  ply: number,
  grading: { evalBeforeCp: number; classification: string },
): void {
  db.prepare(
    "UPDATE moves SET eval_before_cp = ?, classification = ? WHERE game_id = ? AND ply = ?",
  ).run(grading.evalBeforeCp, grading.classification, gameId, ply);
}

const fenBefore = (gameId: number, ply: number): string =>
  (
    db.prepare("SELECT fen_before FROM moves WHERE game_id = ? AND ply = ?").get(gameId, ply) as {
      fen_before: string;
    }
  ).fen_before;

interface PositionFixture {
  gameId: number;
  ply: number;
  color?: "white" | "black";
  accepted: string[];
  /** The position's FEN when no move of the game starts from it. */
  fen?: string;
  fromMistake?: boolean;
  fromRepeat?: boolean;
  listed?: boolean;
  foundAt?: string;
}

function addPosition(id: string, fixture: PositionFixture): FoundPosition {
  const position: FoundPosition = {
    id,
    fen: fixture.fen ?? fenBefore(fixture.gameId, fixture.ply),
    color: fixture.color ?? "white",
    phase: "opening",
    fromMistake: fixture.fromMistake ?? false,
    fromRepeat: fixture.fromRepeat ?? false,
    fromDeparture: false,
    acceptedUci: fixture.accepted,
    listed: fixture.listed ?? true,
    reachedGames: 1,
    bestGames: 0,
    lastReachedAt: FOUND_AT,
    gameId: fixture.gameId,
    ply: fixture.ply,
    firstFoundAt: fixture.foundAt ?? FOUND_AT,
  };
  insertFoundPosition(db, position);
  return position;
}

/** After 2...Nc6 with White to move: Bc4 and d4 are accepted, and the game went on with Bb5. */
function addMistake(id: string, fixture: Partial<PositionFixture> = {}): FoundPosition {
  const gameId = importGame(WHITE_GAME, "white", `game-${id}`);
  grade(gameId, 5, { evalBeforeCp: 35, classification: "mistake" });
  return addPosition(id, {
    gameId,
    ply: 5,
    accepted: ["f1c4", "d2d4"],
    fromMistake: true,
    ...fixture,
  });
}

/** After 1...e5 with White to move: d4 is accepted, and the game went on with Nf3. */
function addRepeat(id: string, fixture: Partial<PositionFixture> = {}): FoundPosition {
  const gameId = importGame(WHITE_GAME, "white", `game-${id}`);
  return addPosition(id, { gameId, ply: 3, accepted: ["d2d4"], fromRepeat: true, ...fixture });
}

const noteOf = (id: string): string | null => getFoundNote(db, id);

describe("generateFoundNotes", () => {
  it("writes a note for every listed position that has none, and counts them", async () => {
    addMistake("own:a");
    addRepeat("own:b");
    addRepeat("own:c");
    const session = always(GOOD_NOTE);
    expect(await generateFoundNotes(db, session)).toEqual({
      considered: 3,
      generated: 3,
      rejected: 0,
      empty: 0,
    });
    expect(session.prompts).toHaveLength(3);
    for (const id of ["own:a", "own:b", "own:c"]) expect(noteOf(id)).toBe(GOOD_NOTE);
  });

  it("skips a position that already has a note and every position that is not listed", async () => {
    addMistake("own:noted");
    setFoundNote(db, "own:noted", "A note an earlier run wrote.");
    addMistake("own:left-out", { listed: false });
    addRepeat("own:fresh");
    const session = always(GOOD_NOTE);
    expect(await generateFoundNotes(db, session)).toMatchObject({ considered: 1, generated: 1 });
    expect(session.prompts).toHaveLength(1);
    expect(noteOf("own:noted")).toBe("A note an earlier run wrote.");
    expect(noteOf("own:left-out")).toBeNull();
    expect(noteOf("own:fresh")).toBe(GOOD_NOTE);
  });

  it("writes nothing and asks nothing when every listed position has its note", async () => {
    addRepeat("own:a");
    setFoundNote(db, "own:a", GOOD_NOTE);
    const session = always("Another note.");
    expect(await generateFoundNotes(db, session)).toEqual({
      considered: 0,
      generated: 0,
      rejected: 0,
      empty: 0,
    });
    expect(session.prompts).toEqual([]);
  });

  it("leaves a position empty after two refused texts, and a rerun tries it again", async () => {
    addMistake("own:a");
    const log = new RecordingLog();
    const naming = always("Develop the bishop to c4, where it eyes f7.");
    expect(await generateFoundNotes(db, naming, log)).toEqual({
      considered: 1,
      generated: 0,
      rejected: 2,
      empty: 1,
    });
    expect(naming.prompts).toHaveLength(2);
    expect(noteOf("own:a")).toBeNull();
    expect(log.named("openings.found_note_rejected")).toHaveLength(2);

    expect(await generateFoundNotes(db, always(GOOD_NOTE))).toMatchObject({
      considered: 1,
      generated: 1,
      empty: 0,
    });
    expect(noteOf("own:a")).toBe(GOOD_NOTE);
  });

  it("stores the retry when the first text is refused and the second passes", async () => {
    addMistake("own:a");
    const session = new ScriptedNoteSession((_prompt, call) =>
      call === 1 ? "x".repeat(MAX_IDEA_CHARS + 1) : GOOD_NOTE,
    );
    expect(await generateFoundNotes(db, session)).toEqual({
      considered: 1,
      generated: 1,
      rejected: 1,
      empty: 0,
    });
    expect(noteOf("own:a")).toBe(GOOD_NOTE);
  });

  it("tells the retry why the first text was refused, and the first prompt nothing of the kind", async () => {
    addMistake("own:a");
    const session = new ScriptedNoteSession((_prompt, call) =>
      call === 1 ? "Play d4." : GOOD_NOTE,
    );
    await generateFoundNotes(db, session);
    expect(session.prompts[0]).not.toContain("refused");
    expect(session.prompts[1]).toContain("Your last note was refused because");
    expect(session.prompts[1]).toContain("the text contains the move's notation d4");
  });

  it("stores each text on one line with no padding", async () => {
    addRepeat("own:a");
    await generateFoundNotes(db, always("  Keeps the\n center,\n and frees   the bishop.\n"));
    expect(noteOf("own:a")).toBe("Keeps the center, and frees the bishop.");
  });

  it("asks about the newest find first, so a run cut short covers what the drill serves first", async () => {
    addRepeat("own:old", { foundAt: "2026-11-01T00:00:00.000Z", accepted: ["d2d4"] });
    addRepeat("own:new", { foundAt: "2026-11-09T00:00:00.000Z", accepted: ["g1f3"] });
    addRepeat("own:mid", { foundAt: "2026-11-05T00:00:00.000Z", accepted: ["b1c3"] });
    const session = always(GOOD_NOTE);
    await generateFoundNotes(db, session);
    expect(session.prompts.map((prompt) => lineOf(prompt, "Move to explain"))).toEqual([
      "Move to explain: 2.Nf3",
      "Move to explain: 2.Nc3",
      "Move to explain: 2.d4",
    ]);
  });

  it("keeps what it wrote when the session stops answering, and a rerun picks up the rest", async () => {
    addRepeat("own:a", { foundAt: "2026-11-03T00:00:00.000Z" });
    addRepeat("own:b", { foundAt: "2026-11-02T00:00:00.000Z" });
    addRepeat("own:c", { foundAt: "2026-11-01T00:00:00.000Z" });
    const session = new ScriptedNoteSession((_prompt, call) => {
      if (call === 3) throw new IdeaSessionError("5-hour limit reached");
      return GOOD_NOTE;
    });
    await expect(generateFoundNotes(db, session)).rejects.toThrow("5-hour limit reached");
    expect(noteOf("own:a")).toBe(GOOD_NOTE);
    expect(noteOf("own:b")).toBe(GOOD_NOTE);
    expect(noteOf("own:c")).toBeNull();
    const resumed = always(GOOD_NOTE);
    expect(await generateFoundNotes(db, resumed)).toMatchObject({ considered: 1, generated: 1 });
  });

  it("never rewrites a stored note", () => {
    addRepeat("own:a");
    expect(setFoundNote(db, "own:a", "First.")).toBe(true);
    expect(setFoundNote(db, "own:a", "Second.")).toBe(false);
    expect(noteOf("own:a")).toBe("First.");
  });

  it("logs each refused text cut short of the log's field limit", async () => {
    addMistake("own:a");
    const log = new RecordingLog();
    await generateFoundNotes(db, always("Bc4 ".repeat(5_000)), log);
    const refused = log.named("openings.found_note_rejected");
    expect(refused).toHaveLength(2);
    expect(refused[0]?.fields).toMatchObject({ position_id: "own:a", attempt: 1 });
    expect(refused[1]?.fields).toMatchObject({ position_id: "own:a", attempt: 2 });
    for (const entry of refused) {
      expect(boundFields(entry.fields).truncated).toBe(false);
      expect(String(entry.fields.text).length).toBeLessThanOrEqual(300);
    }
  });
});

describe("the prompt of a position", () => {
  const promptOf = (position: FoundPosition, refusal: string | null = null): string => {
    const moves = listMoves(db, position.gameId);
    return foundNotePrompt(foundNoteTargetOf(position, moves), refusal);
  };

  it("gives the position, the side to move, the phase and the moves that led to it", () => {
    const position = addMistake("own:a");
    const prompt = promptOf(position);
    expect(lineOf(prompt, "Position (FEN)")).toBe(`Position (FEN): ${position.fen}`);
    expect(lineOf(prompt, "Side to move")).toBe("Side to move: White");
    expect(lineOf(prompt, "Phase")).toBe("Phase: opening");
    expect(lineOf(prompt, "Moves so far")).toBe(
      "Moves so far in the game shown: 1.e4 e5 2.Nf3 Nc6",
    );
  });

  it("gives the best accepted move and the engine's evaluation, and no other accepted move", () => {
    const prompt = promptOf(addMistake("own:a"));
    expect(lineOf(prompt, "Move to explain")).toBe("Move to explain: 3.Bc4");
    expect(lineOf(prompt, "Engine evaluation")).toBe(
      "Engine evaluation with best play: +0.35 pawns (positive favors White)",
    );
    expect(prompt).not.toMatch(/\bd4\b/);
  });

  it("carries the move the student played when the position came from a mistake", () => {
    const prompt = promptOf(addMistake("own:a"));
    expect(lineOf(prompt, "The student played")).toBe(
      "The student played 3.Bb5 here in that game, which the engine rated a mistake",
    );
  });

  it("does not carry the student's move for a repeat, and leaks nothing past the position", () => {
    const prompt = promptOf(addRepeat("own:a"));
    expect(prompt).not.toContain("The student played");
    expect(prompt).not.toContain("Nf3");
    expect(lineOf(prompt, "Moves so far")).toBe("Moves so far in the game shown: 1.e4 e5");
    expect(lineOf(prompt, "Move to explain")).toBe("Move to explain: 2.d4");
  });

  it("carries the student's move for a position that is both a mistake and a repeat", () => {
    const prompt = promptOf(addMistake("own:a", { fromRepeat: true }));
    expect(prompt).toContain("The student played 3.Bb5");
  });

  it("numbers a Black move with an ellipsis and reads the evaluation from White's side", () => {
    const gameId = importGame(BLACK_GAME, "black", "game-black");
    grade(gameId, 4, { evalBeforeCp: 15, classification: "good" });
    const position = addPosition("own:black", {
      gameId,
      ply: 4,
      color: "black",
      accepted: ["g8f6"],
    });
    const prompt = promptOf(position);
    expect(lineOf(prompt, "Side to move")).toBe("Side to move: Black");
    expect(lineOf(prompt, "Move to explain")).toBe("Move to explain: 2...Nf6");
    expect(lineOf(prompt, "Engine evaluation")).toContain("-0.15 pawns");
  });

  it("leaves the evaluation out for a game the grader has not scored, and the line for a game that is gone", () => {
    const ungraded = importGame(WHITE_GAME, "white", "game-ungraded");
    const position = addPosition("own:a", {
      gameId: ungraded,
      ply: 3,
      accepted: ["d2d4"],
      fromRepeat: true,
    });
    expect(promptOf(position)).not.toContain("Engine evaluation");
    const withoutGame = foundNotePrompt(foundNoteTargetOf(position, []), null);
    expect(lineOf(withoutGame, "Moves so far")).toBe(
      "Moves so far in the game shown: not available",
    );
    expect(withoutGame).not.toContain("Engine evaluation");
  });

  it("keeps the whole line, with no grading and no student move, when the game ended on the opponent's move", () => {
    const gameId = importGame(ENDED_ON_OPPONENT, "white", "game-ended");
    const moves = listMoves(db, gameId);
    const position = addPosition("own:end", {
      gameId,
      ply: moves.length + 1,
      fen: moves.at(-1)?.fenAfter ?? "",
      accepted: ["e1g1"],
      fromMistake: true,
      fromRepeat: true,
    });
    const target = foundNoteTargetOf(position, moves);
    expect(target.line).toEqual(moves.map((move) => move.san));
    expect(target.evalCp).toBeNull();
    expect(target.played).toBeNull();
    const prompt = foundNotePrompt(target, null);
    expect(lineOf(prompt, "Move to explain")).toBe("Move to explain: 5.O-O");
    expect(prompt).not.toContain("The student played");
  });

  it("adds the refusal after the facts when a text was refused", () => {
    const prompt = promptOf(addRepeat("own:a"), "the text is empty");
    expect(prompt.split("\n").slice(-1)[0]).toBe(
      "Your last note was refused because the text is empty. Write a different one.",
    );
  });

  it("is written under instructions that keep the move, its square and the student's move out", () => {
    expect(FOUND_NOTE_SYSTEM_PROMPT).toContain("Never write the move");
    expect(FOUND_NOTE_SYSTEM_PROMPT).toContain(`At most ${MAX_IDEA_CHARS} characters`);
    expect(FOUND_NOTE_SYSTEM_PROMPT).toContain("student's own move");
  });
});

describe("foundNoteRejection", () => {
  const accepted = [
    { san: "Bc4", uci: "f1c4" },
    { san: "Nf3", uci: "g1f3" },
    { san: "exd5+", uci: "e4d5" },
  ];
  /** The reason a text is refused, or "accepted": a failure then reads as a string, not a null. */
  const verdict = (text: string): string => foundNoteRejection(text, accepted) ?? "accepted";

  it("accepts a text that names no accepted move and none of their squares", () => {
    expect(verdict(GOOD_NOTE)).toBe("accepted");
    expect(verdict("a".repeat(MAX_IDEA_CHARS))).toBe("accepted");
  });

  it("refuses an empty text", () => {
    expect(verdict("")).toBe("the text is empty");
  });

  it("refuses a text over the character limit", () => {
    expect(verdict("a".repeat(MAX_IDEA_CHARS + 1))).toBe(
      `the text is ${MAX_IDEA_CHARS + 1} characters and the limit is ${MAX_IDEA_CHARS}`,
    );
  });

  it.each([
    ["the best move", "It plays Bc4 to eye the weak pawn", "Bc4"],
    ["the best move in lower case", "bc4 is the idea", "Bc4"],
    ["a second accepted move", "Strong players answer with Nf3 here", "Nf3"],
    ["a capture with its check sign left out", "Taking with exd5 opens the file", "exd5+"],
  ])("refuses a text naming %s", (_name, text, san) => {
    expect(verdict(text)).toBe(`the text contains the move's notation ${san}`);
  });

  it.each([
    ["the best move", "The bishop heads for c4 and eyes the weak pawn", "c4"],
    ["a second accepted move", "A knight on f3 controls the center", "f3"],
    ["a capture", "Something lands on d5 and opens a file", "d5"],
  ])("refuses a text naming the square of %s", (_name, text, square) => {
    expect(verdict(text)).toBe(`the text names the square ${square} the piece moves to`);
  });

  it("refuses castling written with letters or with zeros, and the king's square", () => {
    const castle = [{ san: "O-O", uci: "e1g1" }];
    expect(foundNoteRejection("The king castles with O-O at once", castle)).toContain("O-O");
    expect(foundNoteRejection("The king castles with 0-0 at once", castle)).toContain("O-O");
    expect(foundNoteRejection("The king reaches g1 behind its pawns", castle)).toContain("g1");
    expect(foundNoteRejection("The king hides behind its pawns", castle)).toBeNull();
  });

  it("checks a text against every accepted move, not only the first", () => {
    const refusals = accepted.map((move) =>
      foundNoteRejection(`Think about ${move.san}`, accepted),
    );
    for (const refusal of refusals) expect(refusal).not.toBeNull();
  });
});

describe("foundNoteTargetOf", () => {
  it("falls back to the move's own notation when an accepted move is not legal in the position", () => {
    const position = addRepeat("own:a", { accepted: ["a1a8"] });
    const target: FoundNoteTarget = foundNoteTargetOf(position, listMoves(db, position.gameId));
    expect(target.accepted).toEqual([{ san: "a1a8", uci: "a1a8" }]);
  });
});
