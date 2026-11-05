import type { ServerApi } from "../hooks/useServer.js";
import { connectionChipText } from "../state/coach-panel.js";
import type { ServiceNotice } from "../state/health.js";

export interface StatusChipProps {
  server: Pick<ServerApi, "connection" | "reconnectAttempt">;
  notice: ServiceNotice | null;
}

// Present only when something is wrong. A lost connection outranks a missing engine because
// the health answer it would be read from may be stale.
function chipText({ server, notice }: StatusChipProps): string | null {
  if (server.connection === "reconnecting" && server.reconnectAttempt > 0) {
    return connectionChipText(server.reconnectAttempt);
  }
  if (notice?.reason === "stockfish_missing") return "Engine not found";
  return null;
}

export function StatusChip(props: StatusChipProps) {
  const text = chipText(props);
  if (!text) return null;
  return (
    <span className="chip" role="status" data-testid="status-chip">
      <span className="chip__dot" aria-hidden="true" />
      {text}
    </span>
  );
}
