import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** The slice of a child process the engine wrapper needs; tests substitute a fake. */
export interface EngineProcess {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}

export type EngineSpawner = () => EngineProcess;

export function spawnStockfish(
  path: string = process.env.STOCKFISH_PATH ?? "stockfish",
): EngineProcess {
  // No shell: the path comes from the environment and must never be parsed as a command line.
  const child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"], shell: false });
  const lines = createInterface({ input: child.stdout });
  const exitListeners: Array<() => void> = [];
  let exited = false;
  const notifyExit = (): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener();
  };
  child.on("exit", notifyExit);
  // ENOENT and EPIPE arrive as events; without a handler they would crash the server.
  child.on("error", notifyExit);
  child.stdin.on("error", notifyExit);
  return {
    send: (line) => {
      if (!exited) child.stdin.write(`${line}\n`);
    },
    onLine: (listener) => {
      lines.on("line", listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    kill: () => {
      child.kill("SIGKILL");
    },
  };
}
