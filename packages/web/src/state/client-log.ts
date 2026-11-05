export type ClientLogLevel = "info" | "warn" | "error";

export interface ClientReport {
  level: ClientLogLevel;
  event: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export type ReportSender = (report: ClientReport) => void;

// The server refuses a report over 16 KiB, so the whole body is kept under this, in bytes.
const MAX_BODY_BYTES = 15 * 1024;
const MAX_CONTEXT_BYTES = 4 * 1024;
// A page stuck in an error loop must not flood the server's log.
const MAX_REPORTS_PER_PAGE = 200;

const bytes = (text: string): number => new TextEncoder().encode(text).length;

// Halves the longer of the message and the stack until the body fits, with an oversized context
// replaced by a note first: a cut report beats a refused one.
export function fitReport(report: ClientReport): string {
  let message = report.message;
  let stack = report.stack ?? "";
  // A context is a few fields; one this big would crowd out the message it explains.
  const context =
    report.context && bytes(JSON.stringify(report.context)) > MAX_CONTEXT_BYTES
      ? { dropped: "context too large" }
      : report.context;
  const render = (): string =>
    JSON.stringify({
      level: report.level,
      event: report.event,
      message,
      ...(stack ? { stack } : {}),
      ...(context ? { context } : {}),
    });
  let body = render();
  while (bytes(body) > MAX_BODY_BYTES) {
    if (message.length === 0 && stack.length === 0) break;
    if (stack.length > message.length) {
      stack = stack.slice(0, Math.floor(stack.length / 2));
    } else {
      message = message.slice(0, Math.floor(message.length / 2));
    }
    body = render();
  }
  return body;
}

export function postReport(report: ClientReport, post: typeof fetch = fetch): void {
  const body = fitReport(report);
  void post("/api/client-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

let sender: ReportSender = () => undefined;
let sent = 0;

/** Replaces where reports go; the page installs the real one at start, a test installs a fake. */
export function setClientReporter(next: ReportSender): void {
  sender = next;
  sent = 0;
}

export function reportClient(report: ClientReport): void {
  if (sent >= MAX_REPORTS_PER_PAGE) return;
  sent += 1;
  sender(report);
}

function describeReason(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    return { message: reason.message, ...(reason.stack ? { stack: reason.stack } : {}) };
  }
  return { message: String(reason) };
}

/** Sends the page's uncaught errors and rejections to the server log; returns the uninstaller. */
export function installClientLog(target: Window, send: ReportSender): () => void {
  setClientReporter(send);
  const onError = (event: ErrorEvent): void =>
    reportClient({
      level: "error",
      event: "window_error",
      ...describeReason(event.error ?? event.message),
      context: { source: event.filename, line: event.lineno, column: event.colno },
    });
  const onRejection = (event: PromiseRejectionEvent): void =>
    reportClient({ level: "error", event: "unhandled_rejection", ...describeReason(event.reason) });
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
