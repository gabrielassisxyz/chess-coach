import { MAX_SAY_LENGTH } from "@chess-coach/shared";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";
import { coachErrorHint } from "../state/coach-hint.js";
import { coachStateWords, DEFAULT_COACH_IDLE } from "../state/coach-panel.js";
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

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export interface ChatProps {
  server: ServerApi;
  open?: boolean;
  unread?: boolean;
  onToggle?(): void;
  // What the coach is doing while it is not working on an answer; each screen words its own.
  idleLabel?: string;
}

export function Chat({
  server,
  open = true,
  unread = false,
  onToggle = () => {},
  idleLabel = DEFAULT_COACH_IDLE,
}: ChatProps) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const { items } = server;

  useEffect(() => {
    if (open && items.length > 0) endRef.current?.scrollIntoView?.({ block: "end" });
  }, [items, open]);

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

  if (!open) {
    return (
      <aside className="coach coach--collapsed" aria-label="Coach">
        <button
          type="button"
          className="coach__strip"
          aria-label={unread ? "Expand coach panel, new message" : "Expand coach panel"}
          onClick={onToggle}
        >
          {unread ? <span className="coach__dot" data-testid="coach-unread" /> : null}
          <span className="coach__strip-label">Coach</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="coach chat" aria-label="Coach">
      <header className="chat__header">
        <h2 className="chat__title">Coach</h2>
        <span className="chat__state" role="status" aria-live="polite">
          {coachStateWords(server, idleLabel)}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="Collapse coach panel"
          onClick={onToggle}
        >
          <Icon>
            <path d="M6 3l5 5-5 5" />
          </Icon>
        </button>
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
          className="input composer__input"
          aria-label="Message to the coach"
          placeholder="Think out loud…"
          value={draft}
          maxLength={MAX_SAY_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer__row">
          <span className="composer__hint">Enter to send</span>
          <button
            type="button"
            className="icon-button icon-button--primary"
            aria-label="Send"
            onClick={submit}
          >
            <Icon>
              <path d="M3 8h10M9 4l4 4-4 4" />
            </Icon>
          </button>
        </div>
      </div>
    </aside>
  );
}
