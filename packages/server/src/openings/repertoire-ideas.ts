import type { Options, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { COACH_MODEL, type CoachQuery } from "../coach/session.js";
import type { Database } from "../db/open.js";
import {
  listWhiteMovesLackingIdea,
  type RepertoireIdeaTarget,
  setRepertoireIdea,
} from "../db/repertoires.js";
import { MATE_SCORE_CP } from "../engine/parse.js";
import { type Log, silentLog } from "../log.js";

export const MAX_IDEA_CHARS = 200;
// The first try and one retry: a text that fails both is left empty rather than bent into shape.
const IDEA_ATTEMPTS = 2;
// A refused text is logged so a bad prompt can be diagnosed, but an answer that ran on would
// otherwise reach the log's own field limit and be cut there, mid-sentence.
const LOGGED_TEXT_CHARS = 300;
// One note is a few seconds of model time; a call that outlasts this is stuck, and a stuck call
// would hold the route's one-run-at-a-time guard until the server restarted.
const IDEA_CALL_TIMEOUT_MS = 180_000;

export interface RepertoireIdeasResult {
  /** White moves that had no idea when the run began. */
  considered: number;
  /** Ideas stored. */
  generated: number;
  /** Texts the check refused; a move that failed both tries adds two. */
  rejected: number;
  /** Moves left without an idea after the retry; a rerun tries them again. */
  empty: number;
}

/** Text in, text out: whatever answers, the batch only sees the words that come back. */
export interface IdeaSession {
  /** Throws `IdeaSessionError` when nothing answers; a bad answer is the check's to refuse. */
  write(prompt: string): Promise<string>;
}

export class IdeaSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdeaSessionError";
  }
}

export interface IdeaMove {
  san: string;
  uci: string;
}

/** Why a text may not be stored, or null when it may. These checks cannot prove the chess right. */
export function ideaRejection(text: string, move: IdeaMove): string | null {
  if (text === "") return "the text is empty";
  if (text.length > MAX_IDEA_CHARS) {
    return `the text is ${text.length} characters and the limit is ${MAX_IDEA_CHARS}`;
  }
  const lowered = text.toLowerCase();
  if (writtenForms(move.san).some((form) => lowered.includes(form))) {
    return `the text contains the move's notation ${move.san}`;
  }
  const square = move.uci.slice(2, 4);
  if (lowered.includes(square)) return `the text names the square ${square} the piece moves to`;
  return null;
}

// A check or mate sign is not part of how a student would write the move, and castling is also
// written with zeros.
function writtenForms(san: string): string[] {
  const bare = san.replace(/[+#]/g, "").toLowerCase();
  return [bare, bare.replaceAll("o", "0")];
}

const IDEA_SYSTEM_PROMPT = [
  "You write the first hint for one move of a chess opening repertoire. The student plays White",
  "and is shown the position; your note says why the move is played, so the student can find it.",
  "",
  "State the idea: the plan the move serves, the piece or square it pressures, the weakness it",
  "targets or the problem it prevents. Write for a club player rated about 1200, in plain words.",
  "",
  "Rules:",
  "- Never write the move, its algebraic notation or the square the piece moves to.",
  `- At most ${MAX_IDEA_CHARS} characters: one or two sentences, no markdown, no quotation marks.`,
  "- Claim only what the position supports. The evaluation is there to keep you honest about how",
  "  good the position is: do not quote it, and do not call the position better or worse than it says.",
  "- Answer with the note and nothing else.",
].join("\n");

function numberedMoves(sans: string[]): string {
  return sans.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}.${san}` : san)).join(" ");
}

function evaluationText(evalCp: number): string {
  if (evalCp >= MATE_SCORE_CP) return "White has a forced mate";
  if (evalCp <= -MATE_SCORE_CP) return "Black has a forced mate";
  const sign = evalCp > 0 ? "+" : "";
  return `${sign}${(evalCp / 100).toFixed(2)} pawns (positive favors White)`;
}

/** Everything the text is written from, and nothing else: no other move of the line is a hint. */
export function ideaPrompt(target: RepertoireIdeaTarget, refusal: string | null): string {
  const moveNumber = Math.floor(target.line.length / 2) + 1;
  const lines = [
    `Variation: ${target.variationName}`,
    `Moves so far: ${target.line.length > 0 ? numberedMoves(target.line) : "none, this is the first move"}`,
    `Move to explain: ${moveNumber}.${target.san}`,
    `Engine evaluation after the move: ${evaluationText(target.evalCp)}`,
  ];
  if (refusal)
    lines.push("", `Your last note was refused because ${refusal}. Write a different one.`);
  return lines.join("\n");
}

const tidy = (text: string): string => text.replace(/\s+/g, " ").trim();

async function writeOneIdea(
  session: IdeaSession,
  target: RepertoireIdeaTarget,
  log: Log,
): Promise<{ text: string | null; rejected: number }> {
  let refusal: string | null = null;
  let rejected = 0;
  for (let attempt = 1; attempt <= IDEA_ATTEMPTS; attempt += 1) {
    const text = tidy(await session.write(ideaPrompt(target, refusal)));
    refusal = ideaRejection(text, target);
    if (refusal === null) return { text, rejected };
    rejected += 1;
    log.warn("openings.idea_rejected", {
      position_id: target.id,
      ply: target.ply,
      attempt,
      reason: refusal,
      text: text.slice(0, LOGGED_TEXT_CHARS),
    });
  }
  return { text: null, rejected };
}

/**
 * Writes the idea of every White move that has none, one move at a time. Each text is stored as it
 * passes the check, so a run that stops partway keeps what it wrote and a rerun picks up the rest;
 * a move whose texts both fail stays empty and is tried again by the next run.
 */
export async function generateRepertoireIdeas(
  db: Database,
  session: IdeaSession,
  log: Log = silentLog,
): Promise<RepertoireIdeasResult> {
  const targets = listWhiteMovesLackingIdea(db);
  const result: RepertoireIdeasResult = {
    considered: targets.length,
    generated: 0,
    rejected: 0,
    empty: 0,
  };
  for (const target of targets) {
    const written = await writeOneIdea(session, target, log);
    result.rejected += written.rejected;
    if (written.text === null) result.empty += 1;
    else if (setRepertoireIdea(db, target.id, written.text)) result.generated += 1;
  }
  return result;
}

/** The slice of the Agent SDK's `query` this batch uses: one prompt, one answer. */
export type IdeaQueryFn = (params: { prompt: string; options: Options }) => CoachQuery;

export interface SdkIdeaSessionDeps {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function failureText(message: SDKResultMessage): string {
  if (message.subtype === "success") return message.result || "the session reported an error";
  return message.errors.join("; ") || message.subtype;
}

/**
 * Asks the model through the Agent SDK under the owner's Claude Code login, with the coach's
 * restrictions: only the options passed here, no settings, no connectors, no tools. Every note is
 * its own session, so no earlier note colors a later one and nothing is saved to disk.
 */
export function sdkIdeaSession(query: IdeaQueryFn, deps: SdkIdeaSessionDeps): IdeaSession {
  const timeoutMs = deps.timeoutMs ?? IDEA_CALL_TIMEOUT_MS;
  const options: Options = {
    cwd: deps.cwd,
    // An empty list loads no user, project or local settings, so the owner's CLAUDE.md and skills
    // never reach the model.
    settingSources: [],
    systemPrompt: IDEA_SYSTEM_PROMPT,
    // Without this the CLI also connects the owner's claude.ai connectors and offers their tools.
    strictMcpConfig: true,
    model: COACH_MODEL,
    // The SDK replaces the child's environment with this, so it has to carry the inherited one.
    env: { ...(deps.env ?? process.env), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    // `tools: []` is how the installed SDK disables every built-in tool.
    tools: [],
    maxTurns: 1,
    persistSession: false,
  };
  return {
    async write(prompt) {
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), timeoutMs);
      let stream: CoachQuery | undefined;
      try {
        stream = query({ prompt, options: { ...options, abortController } });
        for await (const message of stream) {
          if (message.type !== "result") continue;
          if (message.subtype !== "success" || message.is_error) {
            throw new IdeaSessionError(failureText(message));
          }
          return message.result;
        }
        throw new IdeaSessionError("the session ended without an answer");
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new IdeaSessionError(`no answer within ${timeoutMs} ms`);
        }
        // Whatever stops the session, the route should name the session and not the engine.
        if (error instanceof IdeaSessionError) throw error;
        throw new IdeaSessionError(error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timer);
        stream?.close?.();
      }
    },
  };
}
