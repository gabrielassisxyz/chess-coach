import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Proof {
  file: string;
  titles: string[];
}

interface FailureCase {
  name: string;
  proofs: Proof[];
}

// Each case names the tests that prove it by file and exact title. The inventory reads the files
// from disk, so a deleted, renamed or skipped test fails here even though the rest of the suite
// stays green.
const INVENTORY: FailureCase[] = [
  {
    name: "not logged in",
    proofs: [
      {
        file: "server/test/coach/session.test.ts",
        titles: ["reports a login failure as a turn_error carrying the SDK's message"],
      },
    ],
  },
  {
    name: "API key present",
    proofs: [
      {
        file: "server/test/coach/auth.test.ts",
        titles: ["refuses when %s is set and names it"],
      },
      {
        file: "server/test/coach/session.test.ts",
        titles: ["refuses to start with an API key in the environment"],
      },
    ],
  },
  {
    name: "SDK process exit mid-turn",
    proofs: [
      {
        file: "server/test/coach/session.test.ts",
        titles: ["recovers after the SDK process exits mid-turn and answers the next message"],
      },
    ],
  },
  {
    name: "Stockfish missing",
    proofs: [
      {
        file: "server/src/engine/boot.test.ts",
        titles: ["names a binary that exited at startup as stockfish_missing"],
      },
      {
        file: "server/src/app.test.ts",
        titles: ["starts and reports stockfish_missing when the binary cannot be spawned"],
      },
      {
        file: "web/test/health.test.tsx",
        titles: ["shows the install hint and disables New game while Stockfish is missing"],
      },
    ],
  },
  {
    name: "engine fault during a turn",
    proofs: [
      {
        file: "server/src/game/notifications.test.ts",
        titles: ["is reported once and leaves the turn open for the next boot"],
      },
      {
        file: "web/test/health.test.tsx",
        titles: ["names an engine fault and keeps New game disabled"],
      },
      {
        file: "server/src/game/service.test.ts",
        titles: ["retries after an engine failure instead of leaving the game wedged"],
      },
    ],
  },
  {
    name: "WebSocket dropped mid-turn",
    proofs: [
      {
        file: "web/test/useServer.test.tsx",
        titles: [
          "resets transcript and approvals on reconnect and resends nothing",
          "settles the coach turn to idle when the socket drops mid-turn",
        ],
      },
    ],
  },
  {
    name: "server restart in each game phase",
    proofs: [
      {
        file: "server/src/game/service.test.ts",
        titles: [
          "keeps a game waiting for the player's move exactly as it was",
          "finishes a turn cut off after the player's ply was saved, exactly once",
          "finishes a black game whose engine opening was never played",
          "restores a finished game as finished after a restart",
        ],
      },
    ],
  },
  {
    name: "server restart with undelivered notifications",
    proofs: [
      {
        file: "server/test/coach/notifications.test.ts",
        titles: [
          "sends two undelivered rows as one message after a restart, then never again",
          "does not mark an unsent notification as a lost answer on restart",
          "keeps rows written during boot recovery for start() and launches the SDK once",
        ],
      },
    ],
  },
  {
    name: "browser refresh in every activity kind",
    proofs: [
      {
        file: "web/test/refresh.test.tsx",
        titles: [
          "restores a live game with its moves and the chat history",
          "restores a review at the selected ply",
          "restores a card in training with its exposure",
          "restores a puzzle in training at its cursor",
          "restores a demo with the activity it returns to",
          "restores an empty board when no activity is open",
        ],
      },
    ],
  },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `it(` and the `it.each(rows)(` form count; `it.skip(` and `it.todo(` do not, because a test that
// does not run proves nothing.
function declaresTest(source: string, title: string): boolean {
  return new RegExp(`(?:\\bit|\\))\\(\\s*"${escapeRegExp(title)}"`).test(source);
}

describe("failure and restart inventory", () => {
  for (const failure of INVENTORY) {
    describe(failure.name, () => {
      for (const proof of failure.proofs) {
        it(`${proof.file} exists`, () => {
          expect(existsSync(join(PACKAGES, proof.file))).toBe(true);
        });

        for (const title of proof.titles) {
          it(`${proof.file} declares "${title}"`, () => {
            const source = readFileSync(join(PACKAGES, proof.file), "utf8");
            expect(declaresTest(source, title)).toBe(true);
          });
        }
      }
    });
  }
});
