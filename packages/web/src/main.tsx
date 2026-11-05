import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyBoardTheme, readBoardTheme } from "./state/board-theme.js";
import { applyTheme, readTheme } from "./state/theme.js";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@lichess-org/chessground/assets/chessground.base.css";
import "@lichess-org/chessground/assets/chessground.cburnett.css";
import "./styles/tokens.css";
import "./styles/chat.css";
import "./styles/focus.css";
import "./styles/board.css";
import "./styles/layout.css";
import "./styles/practice.css";
import "./styles/games.css";
import "./styles/play.css";

// Before the first render, so the page never paints in the wrong theme.
applyTheme(readTheme());
applyBoardTheme(readBoardTheme());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element in index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
