import { Chess } from "chess.js";
import { type LegalMove, legalMoves } from "../game/snapshot.js";

interface Step {
  uci: string;
  san: string;
}

/** The student's scratch line on top of the position a training item was served in. */
export class Exploration {
  private chess: Chess;
  private steps: Step[] = [];

  constructor(private baseFen: string) {
    this.chess = new Chess(baseFen);
  }

  restart(baseFen: string): void {
    this.baseFen = baseFen;
    this.chess = new Chess(baseFen);
    this.steps = [];
  }

  get fen(): string {
    return this.chess.fen();
  }

  get turn(): "white" | "black" {
    return this.chess.turn() === "w" ? "white" : "black";
  }

  get lineSan(): string[] {
    return this.steps.map((step) => step.san);
  }

  get lastMove(): { from: string; to: string } | null {
    const uci = this.steps.at(-1)?.uci;
    return uci ? { from: uci.slice(0, 2), to: uci.slice(2, 4) } : null;
  }

  legal(): LegalMove[] {
    return legalMoves(this.chess);
  }

  play(uci: string): boolean {
    try {
      const move = this.chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        ...(uci.length === 5 ? { promotion: uci.slice(4) } : {}),
      });
      this.steps.push({ uci, san: move.san });
      return true;
    } catch {
      return false;
    }
  }

  undo(): boolean {
    if (this.steps.length === 0) return false;
    this.chess.undo();
    this.steps.pop();
    return true;
  }

  reset(): boolean {
    if (this.steps.length === 0) return false;
    this.restart(this.baseFen);
    return true;
  }

  // Only the first ply carries a move number, the way a line is quoted in running text.
  line(): string {
    const [, side, , , , number] = this.baseFen.split(" ");
    const first = Number(number ?? 1);
    const head = side === "b" ? `${first}... ` : `${first}. `;
    return head + this.lineSan.join(" ");
  }
}
