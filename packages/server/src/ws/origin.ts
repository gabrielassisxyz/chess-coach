export const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

export function allowedOriginsFrom(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CHESS_COACH_ALLOWED_ORIGINS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
}

// Any web page can open a socket to 127.0.0.1 and drive the coach on the owner's quota, so a
// missing Origin is refused too: only a browser tab on an allowed origin gets through. Host is
// pinned to the same set, which is what stops a DNS-rebinding page from passing as local.
export function isUpgradeAllowed(
  headers: { origin?: string | undefined; host?: string | undefined },
  allowedOrigins: readonly string[],
): boolean {
  const { origin, host } = headers;
  if (origin === undefined || host === undefined) return false;
  if (!allowedOrigins.includes(origin)) return false;
  return allowedOrigins.some((allowed) => new URL(allowed).host === host);
}
