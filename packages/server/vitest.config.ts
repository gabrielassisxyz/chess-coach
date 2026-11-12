import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The default is one worker per hardware thread but one, which leaves nothing for the rest of
    // the machine, and a test's 5 s counts every moment it waits on what the other workers and
    // processes are using, not only its own work. Half the threads is one worker per physical
    // core on an SMT machine, the share vitest itself takes in watch mode.
    maxWorkers: "50%",
    globalSetup: ["./test/support/temp-root.ts"],
    setupFiles: ["./test/support/temp-root.setup.ts"],
  },
});
