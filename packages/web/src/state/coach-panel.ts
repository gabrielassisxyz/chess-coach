import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";

export const COACH_OPEN_STORAGE_KEY = "chess-coach.coach-open";

export const DEFAULT_COACH_IDLE = "watching the board";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(COACH_OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function storeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(COACH_OPEN_STORAGE_KEY, String(open));
  } catch {
    // Storage can be refused (private mode); the choice then lasts for the session only.
  }
}

export const PHONE_QUERY = "(max-width: 899px)";

// The layout and this hook must agree on where a phone starts, so both read the one query.
export function isPhone(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches === true;
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const query = typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
    if (!query?.addEventListener) return;
    const update = (): void => setPhone(query.matches === true);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

export interface CoachPanel {
  open: boolean;
  unread: boolean;
  toggle(): void;
}

// The dot marks a coach message that started while the panel was closed; opening it is the
// acknowledgement. Comparing counts, never items, keeps a reconnect's replayed transcript quiet.
//
// On a phone the panel is a sheet over the board, so it starts closed on every visit and its
// state is kept apart from the desktop choice instead of overwriting it.
export function useCoachPanel(coachMessages: number): CoachPanel {
  const phone = usePhone();
  const [desktopOpen, setDesktopOpen] = useState(readOpen);
  const [sheetOpen, setSheetOpen] = useState(false);
  const open = phone ? sheetOpen : desktopOpen;
  const [unread, setUnread] = useState(false);
  const seen = useRef(coachMessages);

  useEffect(() => {
    if (coachMessages > seen.current && !open) setUnread(true);
    seen.current = coachMessages;
  }, [coachMessages, open]);

  const toggle = useCallback(() => {
    const next = !open;
    if (phone) setSheetOpen(next);
    else {
      storeOpen(next);
      setDesktopOpen(next);
    }
    if (next) setUnread(false);
  }, [open, phone]);

  return { open, unread, toggle };
}

// One phrase for the panel header. Offline wins because the turn state cannot be known without
// a socket; a pending permission outranks the turn because the coach is blocked on the student.
export function coachStateWords(
  server: Pick<ServerApi, "connection" | "permissions" | "turn">,
  idle: string = DEFAULT_COACH_IDLE,
): string {
  if (server.connection !== "connected") return "offline · reconnecting";
  if (server.permissions.length > 0) return "waiting for you";
  if (server.turn === "thinking") return "thinking";
  if (server.turn === "streaming") return "writing";
  return idle;
}

function ordinal(count: number): string {
  const tens = count % 100;
  if (tens >= 11 && tens <= 13) return `${count}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[count % 10] ?? "th";
  return `${count}${suffix}`;
}

export function connectionChipText(attempt: number): string {
  return `Connection lost · reconnecting (${ordinal(attempt)} try)`;
}
