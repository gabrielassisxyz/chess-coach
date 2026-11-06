import type { CoachTab } from "@chess-coach/shared";
import type { CoachEvent } from "../../src/coach/events.js";
import type { CoachEventListener, PermissionRequest } from "../../src/coach/session.js";
import { createCoachSession } from "../../src/db/chat.js";
import type { Database } from "../../src/db/open.js";
import type { CoachPort } from "../../src/ws/hub.js";

// Records what the hub asked of the coach and lets a test push events and permission requests.
// Given a database, a tab's row is created the first time something needs it, like the real one.
export class FakeCoach implements CoachPort {
  readonly rows: Partial<Record<CoachTab, { id: number }>> = {};
  readonly sent: { text: string; tab: CoachTab }[] = [];
  readonly resolved: { requestId: string; allow: boolean }[] = [];
  readonly newConversations: CoachTab[] = [];
  knownRequests = new Set<string>();
  failSendWith: Error | undefined;
  flushes = 0;
  private readonly eventListeners = new Set<CoachEventListener>();
  private readonly permissionListeners = new Set<(request: PermissionRequest) => void>();

  constructor(private readonly db?: Database) {}

  conversationRow(tab: CoachTab): { id: number } | undefined {
    return this.rows[tab];
  }

  ensureSessionId(tab: CoachTab): number {
    const existing = this.rows[tab];
    if (existing) return existing.id;
    if (!this.db) throw new Error(`the fake coach has no ${tab} row`);
    const row = createCoachSession(this.db, { promptVersion: "fake", tab });
    this.rows[tab] = row;
    return row.id;
  }

  flushNotifications(): void {
    this.flushes += 1;
  }

  async send(text: string, tab: CoachTab): Promise<void> {
    if (this.failSendWith) throw this.failSendWith;
    this.sent.push({ text, tab });
  }

  newConversation(tab: CoachTab): void {
    this.newConversations.push(tab);
    delete this.rows[tab];
  }

  resolvePermission(requestId: string, allow: boolean): boolean {
    if (!this.knownRequests.has(requestId)) return false;
    this.resolved.push({ requestId, allow });
    return true;
  }

  onEvent(listener: CoachEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onPermissionRequest(listener: (request: PermissionRequest) => void): () => void {
    this.permissionListeners.add(listener);
    return () => this.permissionListeners.delete(listener);
  }

  emit(event: CoachEvent, tab: CoachTab = "play"): void {
    for (const listener of this.eventListeners) listener(event, tab);
  }

  requestPermission(request: PermissionRequest): void {
    this.knownRequests.add(request.requestId);
    for (const listener of this.permissionListeners) listener(request);
  }
}
