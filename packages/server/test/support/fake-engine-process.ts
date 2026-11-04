import { readFileSync } from "node:fs";
import type { EngineProcess } from "../../src/engine/process.js";

const FIXTURE_DIR = new URL("../fixtures/uci/", import.meta.url);

/** Recorded Stockfish output, keyed by the FEN each block searched. */
export function loadFixture(name: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of readFileSync(new URL(`${name}.txt`, FIXTURE_DIR), "utf8").split("\n")) {
    if (line.startsWith("# fen: ")) {
      current = [];
      blocks.set(line.slice("# fen: ".length), current);
    } else if (line && !line.startsWith("#")) {
      current?.push(line);
    }
  }
  return blocks;
}

export interface GoRequest {
  fen: string;
  command: string;
  emit: (line: string) => void;
}

/**
 * A scripted stand-in for a Stockfish process. It answers the handshake itself and hands
 * every `go` to the test, so a test decides whether, when and what the engine says.
 */
export class FakeEngineProcess implements EngineProcess {
  readonly sent: string[] = [];
  killed = false;
  private fen = "";
  private readonly lineListeners: Array<(line: string) => void> = [];
  private readonly exitListeners: Array<() => void> = [];

  constructor(
    private readonly onGo: (request: GoRequest) => void,
    private readonly answersQuit = true,
  ) {}

  send(line: string): void {
    this.sent.push(line);
    queueMicrotask(() => this.respond(line));
  }

  onLine(listener: (line: string) => void): void {
    this.lineListeners.push(listener);
  }

  onExit(listener: () => void): void {
    this.exitListeners.push(listener);
  }

  kill(): void {
    this.killed = true;
  }

  emit(line: string): void {
    for (const listener of this.lineListeners) listener(line);
  }

  exit(): void {
    for (const listener of this.exitListeners) listener();
  }

  private respond(line: string): void {
    if (line === "uci") this.emit("uciok");
    else if (line === "isready") this.emit("readyok");
    else if (line.startsWith("position fen ")) this.fen = line.slice("position fen ".length);
    else if (line.startsWith("go ")) {
      this.onGo({ fen: this.fen, command: line, emit: (out) => this.emit(out) });
    } else if (line === "quit" && this.answersQuit) this.exit();
  }
}

export function replayFixture(fixture: Map<string, string[]>): (request: GoRequest) => void {
  return ({ fen, emit }) => {
    const lines = fixture.get(fen);
    if (!lines) throw new Error(`no recorded output for ${fen}`);
    for (const line of lines) emit(line);
  };
}
