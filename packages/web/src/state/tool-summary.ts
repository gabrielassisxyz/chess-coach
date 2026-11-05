// The coach's tools reach the chat as `mcp__chess__<tool>`; the student only ever sees the tool part.
const TOOL_PREFIX = /^mcp__[a-z]+__/;

export function toolBaseName(name: string): string {
  return name.replace(TOOL_PREFIX, "");
}

type Fields = Record<string, unknown>;

// A tool result arrives either as the SDK's list of text blocks or as a bare string; both carry
// the JSON the server tool returned.
export function parseToolOutput(output: unknown): Fields | null {
  const text = Array.isArray(output)
    ? output
        .map((block) => (block as { text?: unknown } | null)?.text)
        .filter((part): part is string => typeof part === "string")
        .join("")
    : output;
  if (typeof text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Fields) : null;
  } catch {
    return null;
  }
}

function field(source: unknown, key: string): string | null {
  const value = (source as Fields | null)?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function signed(pawns: number): string {
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

function bestLine(result: Fields | null): string | null {
  const lines = result?.lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const first = lines[0] as { score_cp?: unknown; mate?: unknown; pv?: unknown };
  const move = Array.isArray(first.pv) && typeof first.pv[0] === "string" ? first.pv[0] : null;
  if (move === null || typeof first.score_cp !== "number") return null;
  const sign = first.score_cp >= 0 ? "+" : "-";
  const score = first.mate === true ? `${sign}mate` : signed(first.score_cp / 100);
  return `best ${move}, ${score}`;
}

function sentenceFor(base: string, input: unknown, result: Fields | null): string {
  switch (base) {
    case "analyze": {
      const best = bestLine(result);
      return best ? `Analysed the position: ${best}` : "Analysed the position";
    }
    case "show_position":
      return "Showed a position on the board";
    case "make_move":
      return `Played ${field(input, "san") ?? "a move"} on the demo board`;
    case "get_game":
      return "Read the game";
    case "get_progress":
      return "Read your progress";
    case "read_reference":
      return `Read the ${field(input, "name") ?? "teaching"} reference`;
    case "new_game": {
      const elo = field(input, "elo");
      const color = field(input, "color") ?? "white";
      return `Started a new game as ${color}${elo ? ` against ${elo}` : ""}`;
    }
    case "resign_game":
      return "Resigned the game";
    case "create_srs_cards":
      return `Created review cards from game ${field(input, "game_id") ?? ""}`.trim();
    case "add_srs_card":
      return "Saved a review card";
    case "explain_card":
      return `Explained review card ${field(input, "card_id") ?? ""}`.trim();
    case "get_puzzles": {
      const motif = field(input, "motif");
      return motif ? `Picked ${motif} puzzles` : "Picked puzzles";
    }
    case "get_due_cards":
      return "Read the review cards due";
    case "set_difficulty":
      return `Set the engine to ${field(input, "elo") ?? "a new level"}`;
    case "read_routine":
      return "Read the weekly routine";
    case "write_routine":
      return "Saved the weekly routine";
    case "serve_puzzle":
      return "Put a puzzle on the board";
    case "serve_card":
      return "Put a review card on the board";
    default:
      return `Used ${base}`;
  }
}

/** One line of plain English for a tool use; without an output yet it reads as in progress. */
export function toolSummary(name: string, input: unknown, output?: unknown): string {
  const base = toolBaseName(name);
  if (output === undefined) return `${sentenceFor(base, input, null)}…`;
  const result = parseToolOutput(output);
  const refusal = field(result, "error");
  if (refusal !== null) return `${base} refused: ${refusal}`;
  return sentenceFor(base, input, result);
}
