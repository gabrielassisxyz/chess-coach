import type { ChatItem } from "../state/transcript.js";

export function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function ToolCard({ item }: { item: Extract<ChatItem, { type: "tool" }> }) {
  return (
    <section className="card" data-testid="tool-card">
      <div className="card__name">{item.name}</div>
      <pre className="card__body">{pretty(item.input)}</pre>
      {item.result ? (
        <div className="card__result" data-testid="tool-result">
          <pre className="card__body">{pretty(item.result.output)}</pre>
        </div>
      ) : null}
    </section>
  );
}
