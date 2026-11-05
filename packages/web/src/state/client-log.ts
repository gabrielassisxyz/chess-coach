export type ClientLogLevel = "info" | "warn" | "error";

export interface ClientReport {
  level: ClientLogLevel;
  event: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export type ReportSender = (report: ClientReport) => void;

// The server refuses a report over 16 KiB; text is cut well below that so the rest still fits.
const MAX_TEXT = 8 * 1024;
// A page stuck in an error loop must not flood the server's log.
const MAX_REPORTS_PER_PAGE = 200;

function cut(text: string): string {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

export function postReport(report: ClientReport, post: typeof fetch = fetch): void {
  const body = JSON.stringify({
    ...report,
    message: cut(report.message),
    ...(report.stack ? { stack: cut(report.stack) } : {}),
  });
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
