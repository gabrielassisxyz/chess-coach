import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The dev server proxies /api to the backend so the browser talks to one origin and no
// CORS configuration exists anywhere. In production the server serves the built assets.
export default defineConfig({
  plugins: [react()],
  test: { environment: "happy-dom" },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        ws: true,
      },
    },
  },
});
