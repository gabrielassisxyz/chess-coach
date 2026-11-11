import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/support/temp-root.ts"],
    setupFiles: ["./test/support/temp-root.setup.ts"],
  },
});
