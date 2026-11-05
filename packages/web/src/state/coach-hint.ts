const AUTH_PATTERN = /\bauth|log(?:ged)?[ -]?in|\/login|api key/i;
const PROCESS_PATTERN = /\bsdk\b|claude code process|process exited|spawn/i;

export function isCoachAuthError(message: string): boolean {
  return AUTH_PATTERN.test(message);
}

// Only failures with a fix the student can apply get a suggestion; any other turn_error
// shows the server's message alone rather than a guess.
export function coachErrorHint(message: string): string | null {
  if (AUTH_PATTERN.test(message)) {
    return "Run `claude` in a terminal, sign in with /login, then restart the server.";
  }
  if (PROCESS_PATTERN.test(message)) {
    return "Check that `claude` starts in a terminal, then send your message again.";
  }
  return null;
}
