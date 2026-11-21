import type { RepertoireSummary } from "@chess-coach/shared";
import { useRef, useState } from "react";
import { type RebuildLine, RunRefusedError, type StylePoints } from "./repertoires-api.js";

// How a rebuild sent from the line's page ended: the line was walked again, the run stopped at its
// request limit, the server was busy with another run, or the run failed. Only the first changes
// the line.
export type LineRebuildOutcome = "rebuilt" | "stopped" | "busy" | "failed";

export interface LineRebuild {
  // The variation a rebuild sent from this page is walking: its request is still open.
  running: number | null;
  // How the last rebuild ended, for the variation it was of, until another starts or a line's page
  // is opened.
  ended: { id: number; outcome: LineRebuildOutcome } | null;
  // Counts the endings, so that whatever was read from the stored moves is read again after each.
  endings: number;
  start(variation: RepertoireSummary, points: StylePoints): Promise<void>;
  // Forgets how the last rebuild ended; a run still going stays.
  dismiss(): void;
}

// A rebuild is held open for minutes, so the page that remembers it has to outlive the line's page:
// the student can leave for the list or another line while it runs, and the list has to follow the
// ending all the same. `refreshList` reads the list again and answers whether it could.
export function useLineRebuild(
  rebuildLine: RebuildLine,
  refreshList: () => Promise<boolean>,
): LineRebuild {
  const [running, setRunning] = useState<number | null>(null);
  const [ended, setEnded] = useState<LineRebuild["ended"]>(null);
  const [endings, setEndings] = useState(0);
  // A second press before the first has rendered must not send a second run.
  const sending = useRef(false);

  const start = async (variation: RepertoireSummary, points: StylePoints): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    setRunning(variation.id);
    setEnded(null);
    let outcome: LineRebuildOutcome;
    try {
      const { truncated } = await rebuildLine(
        { root: variation.root ?? null, branch: variation.branch ?? null },
        points,
      );
      outcome = truncated ? "stopped" : "rebuilt";
    } catch (error) {
      outcome = error instanceof RunRefusedError && error.alreadyRunning ? "busy" : "failed";
    }
    // A list that cannot be read leaves the figures as they were; the ending is told all the same.
    await refreshList();
    sending.current = false;
    setRunning(null);
    setEnded({ id: variation.id, outcome });
    setEndings((count) => count + 1);
  };

  return { running, ended, endings, start, dismiss: () => setEnded(null) };
}

// A rebuild names the variation by the root or the branch it was built from, and posting neither
// rebuilds the first variation of the Italian. So a variation with neither is rebuildable only when
// it is that one, the oldest of its group; a variation stored before its branch was recorded would
// otherwise walk the first one again under points meant for it. A line read from a PGN file has
// neither and is often the oldest of its group, but the builder never made it, so it is not
// rebuildable at all: its file is the source of its moves.
export function rebuildNamesLine(
  variation: RepertoireSummary,
  group: readonly RepertoireSummary[],
): boolean {
  if (variation.origin === "pgn") return false;
  if (variation.root != null || variation.branch != null) return true;
  return group.every((other) => other.id >= variation.id);
}
