import { useState } from "react";
import { parseToolOutput, toolBaseName, toolSummary } from "../state/tool-summary.js";
import type { ChatItem } from "../state/transcript.js";

export function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

// One quiet line per tool use; the raw input and result stay one click away for whoever wants them.
export function ToolCard({ item }: { item: Extract<ChatItem, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="tool-line" data-testid="tool-card">
      <button
        type="button"
        className="tool-line__summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {toolSummary(item.name, item.input, item.result?.output, item.result?.isError)}
      </button>
      {open ? (
        <div className="tool-line__details">
          <div className="card__name">{toolBaseName(item.name)}</div>
          <pre className="card__body">{pretty(item.input)}</pre>
          {item.result ? (
            <div className="card__result" data-testid="tool-result">
              <pre className="card__body">
                {pretty(parseToolOutput(item.result.output) ?? item.result.output)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
