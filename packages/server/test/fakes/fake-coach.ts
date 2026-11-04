import type { CoachEvent } from "../../src/coach/events.js";
import type { PermissionRequest } from "../../src/coach/session.js";
import type { CoachPort } from "../../src/ws/hub.js";

// Records what the hub asked of the coach and lets a test push events and permission requests.
export class FakeCoach implements CoachPort {
  sessionRow: { id: number } | undefined;
  readonly sent: string[] = [];
  readonly resolved: { requestId: string; allow: boolean }[] = [];
  knownRequests = new Set<string>();
  failSendWith: Error | undefined;
  private readonly eventListeners = new Set<(event: CoachEvent) => void>();
  private readonly permissionListeners = new Set<(request: PermissionRequest) => void>();

  async send(text: string): Promise<void> {
    if (this.failSendWith) throw this.failSendWith;
    this.sent.push(text);
  }

  resolvePermission(requestId: string, allow: boolean): boolean {
    if (!this.knownRequests.has(requestId)) return false;
    this.resolved.push({ requestId, allow });
    return true;
  }

  onEvent(listener: (event: CoachEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onPermissionRequest(listener: (request: PermissionRequest) => void): () => void {
    this.permissionListeners.add(listener);
    return () => this.permissionListeners.delete(listener);
  }

  emit(event: CoachEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  requestPermission(request: PermissionRequest): void {
    this.knownRequests.add(request.requestId);
    for (const listener of this.permissionListeners) listener(request);
  }
}
