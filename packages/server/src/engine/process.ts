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

/**
 * What to execute for the engine. With a niceness it runs under `nice`, which replaces itself with
 * the engine, so the child that is killed or exits is the engine and a background search yields the
 * processor to the game's engines. The `--` keeps a path that starts with a dash from being read as
 * an option.
 */
export function stockfishCommand(
  path: string,
  niceness?: number,
): { command: string; args: string[] } {
  if (niceness === undefined) return { command: path, args: [] };
  return { command: "nice", args: ["-n", String(niceness), "--", path] };
}

export function spawnStockfish(
  path: string = process.env.STOCKFISH_PATH ?? "stockfish",
  niceness?: number,
): EngineProcess {
  // No shell: the path comes from the environment and must never be parsed as a command line.
  const { command, args } = stockfishCommand(path, niceness);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], shell: false });
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
