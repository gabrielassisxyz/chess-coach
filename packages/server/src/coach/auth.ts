const API_KEY_VARIABLES = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"] as const;

// An API key in the environment makes the SDK bill the API instead of the owner's
// subscription, so the server refuses to start rather than spend money by accident.
export function assertSubscriptionAuth(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of API_KEY_VARIABLES) {
    if (env[name]) {
      throw new Error(
        `${name} is set: the coach must run on the Claude Code login, not an API key. Unset ${name} and start again.`,
      );
    }
  }
}
