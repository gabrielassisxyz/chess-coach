import { MAX_SAY_LENGTH } from "@chess-coach/shared";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";
import { coachErrorHint } from "../state/coach-hint.js";
import type { ChatItem } from "../state/transcript.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { ToolCard } from "./ToolCard.js";

function ItemView({ item }: { item: ChatItem }) {
  switch (item.type) {
    case "text":
      return <p className={`message message--${item.role}`}>{item.text}</p>;
    case "tool":
      return <ToolCard item={item} />;
    case "turn_error": {
      const hint = coachErrorHint(item.message);
      return (
        <div className="message message--error" role="alert">
          <p>{item.message}</p>
          {hint ? (
            <p className="message__hint" data-testid="error-hint">
              {hint}
            </p>
          ) : null}
        </div>
      );
    }
    case "notice":
      return <p className="notice">{item.text}</p>;
  }
}

export function Chat({ server }: { server: ServerApi }) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const { items } = server;

  useEffect(() => {
    if (items.length > 0) endRef.current?.scrollIntoView?.({ block: "end" });
  }, [items]);

  const submit = (): void => {
    const text = draft.trim();
    if (text === "" || text.length > MAX_SAY_LENGTH) return;
    if (server.say(text)) setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className="chat">
      <header className="chat__header">
        <h1 className="chat__title">chess-coach</h1>
        <div className="chat__state">
          <span className="chat__status" role="status">
            {server.connection === "connected" ? "connected" : "reconnecting"}
          </span>
          {server.connection === "connected" ? (
            <span className="chat__turn" data-turn={server.turn} aria-live="polite">
              {server.turn}
            </span>
          ) : null}
        </div>
      </header>
      <div className="chat__log">
        <div className="chat__column">
          {server.items.map((item) => (
            <ItemView key={item.key} item={item} />
          ))}
          {server.permissions.map((request) => (
            <ApprovalCard key={request.requestId} request={request} onAnswer={server.approve} />
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <div className="composer">
        <textarea
          className="composer__input"
          aria-label="Message to the coach"
          placeholder="Ask the coach"
          value={draft}
          maxLength={MAX_SAY_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="button button--primary" onClick={submit}>
          Send
        </button>
      </div>
    </div>
  );
}
