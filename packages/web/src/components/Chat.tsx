import { MAX_SAY_LENGTH } from "@chess-coach/shared";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { ServerApi } from "../hooks/useServer.js";
import { coachErrorHint } from "../state/coach-hint.js";
import { coachStateWords, DEFAULT_COACH_IDLE, isConversationStale } from "../state/coach-panel.js";
import { lineCardsByAnchor } from "../state/tool-summary.js";
import type { ChatItem } from "../state/transcript.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { CoachLineCards } from "./PracticeCoachActions.js";
import { ToolCard } from "./ToolCard.js";

// The coach writes Markdown; links would take the student off-site and images
// are not part of the subset, so both render as their text. Raw HTML is never
// parsed because no rehype-raw plugin is added, and React escapes the rest.
const coachMarkdownComponents: Components = {
  a: ({ children }) => <>{children}</>,
  img: ({ alt }) => <>{alt ?? ""}</>,
};

const twoDigits = (value: number): string => String(value).padStart(2, "0");

// The local wall-clock time a divider was written, as the student reads a clock.
function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
}

export function dividerText(label: string, at: string): string {
  const time = clockTime(at);
  return time === "" ? label : `${label} · ${time}`;
}

function ItemView({ item }: { item: ChatItem }) {
  switch (item.type) {
    case "text":
      if (item.role === "assistant") {
        return (
          <div className="message message--assistant message--markdown">
            <ReactMarkdown components={coachMarkdownComponents}>{item.text}</ReactMarkdown>
          </div>
        );
      }
      return <p className="message message--user">{item.text}</p>;
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
    case "divider": {
      const text = dividerText(item.label, item.at);
      return (
        // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot carry the visible label.
        <div className="chat__divider" role="separator" aria-label={text}>
          <span className="chat__divider-label">{text}</span>
        </div>
      );
    }
  }
}

// Offered, never applied: an old conversation is only closed when the student says so.
function FreshStartCard({ onAccept, onDismiss }: { onAccept(): void; onDismiss(): void }) {
  return (
    <div className="chat__suggest" role="note" data-testid="fresh-start-card">
      <p className="chat__suggest-text">Começar uma nova conversa?</p>
      <div className="chat__suggest-actions">
        <button type="button" className="button" onClick={onAccept}>
          Começar
        </button>
        <button type="button" className="button" onClick={onDismiss}>
          Agora não
        </button>
      </div>
    </div>
  );
}

// The card is offered when the panel opens or the student types into a tab whose last message is
// over an hour old. Dismissing it is remembered against that last message, so it stays hidden
// until another one arrives.
function useFreshStartOffer(server: ServerApi, open: boolean) {
  const key = `${server.tab}:${server.lastMessageAt ?? "none"}`;
  const [offered, setOffered] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { lastMessageAt } = server;
  const check = useCallback((): void => {
    if (isConversationStale(lastMessageAt, Date.now())) setOffered(key);
  }, [lastMessageAt, key]);
  useEffect(() => {
    if (open) check();
  }, [open, check]);
  const visible = offered === key && dismissed !== key;
  return {
    visible,
    check,
    dismiss: () => setDismissed(key),
    accept: () => {
      setDismissed(key);
      server.newConversation();
    },
  };
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
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
  // Buttons the screen offers under the latest coach message.
  actions?: ReactNode;
  // One line pinned over the conversation naming what is on the board.
  contextLine?: string | null;
}

// The coach's model, read-only until choosing one is a setting; the server does not report it yet.
export const COACH_MODEL_LABEL = "Claude";

export function Chat({
  server,
  open = true,
  unread = false,
  onToggle = () => {},
  idleLabel = DEFAULT_COACH_IDLE,
  actions = null,
  contextLine = null,
}: ChatProps) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const { items } = server;
  const freshStart = useFreshStartOffer(server, open);

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

  const lineCards = lineCardsByAnchor(items);
  const lastCoachIndex = items.findLastIndex(
    (item) => item.type === "text" && item.role === "assistant",
  );
  const lastCoach = lastCoachIndex === -1 ? null : items[lastCoachIndex];
  const barLine = lastCoach?.type === "text" ? lastCoach.text : idleLabel;

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
          <span className="coach__bar-line" data-testid="coach-bar-line">
            {barLine}
          </span>
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
        <button type="button" className="button chat__new" onClick={server.newConversation}>
          Nova conversa
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Collapse coach panel"
          title="Collapse coach panel"
          onClick={onToggle}
        >
          <Icon>
            <path d="M6 3l5 5-5 5" />
          </Icon>
        </button>
      </header>
      <div className="chat__log">
        <div className="chat__column">
          {contextLine ? (
            <p className="chat__context" data-testid="chat-context">
              {contextLine}
            </p>
          ) : null}
          {server.items.map((item, index) => (
            <Fragment key={item.key}>
              <ItemView item={item} />
              {lineCards.has(item.key) ? (
                <CoachLineCards cards={lineCards.get(item.key) ?? []} server={server} />
              ) : null}
              {index === lastCoachIndex ? actions : null}
            </Fragment>
          ))}
          {lastCoachIndex === -1 ? actions : null}
          {server.permissions.map((request) => (
            <ApprovalCard key={request.requestId} request={request} onAnswer={server.approve} />
          ))}
          {freshStart.visible ? (
            <FreshStartCard onAccept={freshStart.accept} onDismiss={freshStart.dismiss} />
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      <div className="composer">
        <div className="composer__box">
          <textarea
            className="composer__input"
            aria-label="Message to the coach"
            placeholder={contextLine ? "Think out loud…" : "Ask about the position…"}
            value={draft}
            maxLength={MAX_SAY_LENGTH}
            onChange={(event) => {
              setDraft(event.target.value);
              freshStart.check();
            }}
            onKeyDown={onKeyDown}
          />
          <div className="composer__tools">
            <button
              type="button"
              className="icon-button icon-button--quiet composer__tool composer__dictate"
              aria-label="Dictate"
              title="Dictate"
              disabled
            >
              <Icon>
                <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
                <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
              </Icon>
              <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {draft.trim() === "" ? (
              <button
                type="button"
                className="icon-button icon-button--quiet composer__tool"
                aria-label="Voice conversation"
                title="Voice conversation"
                disabled
              >
                <Icon>
                  <path d="M2.5 7v2M5.5 4.5v7M8.5 2.5v11M11.5 5v6M14.5 7v2" />
                </Icon>
              </button>
            ) : (
              <button
                type="button"
                className="icon-button icon-button--primary composer__tool"
                aria-label="Send"
                title="Send"
                onClick={submit}
              >
                <Icon>
                  <path d="M8 13V3M4 7l4-4 4 4" />
                </Icon>
              </button>
            )}
          </div>
        </div>
        <div className="composer__row">
          <span className="composer__model" title="Coach model">
            {COACH_MODEL_LABEL}
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          </span>
          <span className="composer__hint">Enter to send</span>
        </div>
      </div>
    </aside>
  );
}
