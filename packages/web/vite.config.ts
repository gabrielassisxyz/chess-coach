import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The dev server proxies /api to the backend so the browser talks to one origin and no
// CORS configuration exists anywhere. In production the server serves the built assets.
//
// Vite refuses a Host header it does not know, which is what makes the app reachable only
// as localhost by default. The same variable the server reads for its Origin check names
// every extra host (a tailnet name behind `tailscale serve`, for instance), so one setting
// opens both doors or neither.
const extraHosts = (process.env.CHESS_COACH_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin !== "")
  .map((origin) => new URL(origin).hostname);

// A second instance beside the daily one (another checkout, a copied database) runs its
// server on another PORT, so the proxy has to be told which one; the default is the server's.
const apiPort = process.env.CHESS_COACH_API_PORT ?? "3210";

export default defineConfig({
  plugins: [react()],
  test: { environment: "happy-dom" },
  server: {
    // "localhost" resolves to ::1 here and proxies dial 127.0.0.1, so the address is
    // explicit; CHESS_COACH_WEB_HOST binds another one, a tailnet address for instance.
    host: process.env.CHESS_COACH_WEB_HOST ?? "127.0.0.1",
    allowedHosts: extraHosts,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
      },
    },
  },
});
