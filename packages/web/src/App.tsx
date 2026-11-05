import { useState } from "react";
import { Chat } from "./components/Chat.js";
import { NoticeBanner } from "./components/NoticeBanner.js";
import { StatusChip } from "./components/StatusChip.js";
import { type FetchHealth, useHealth } from "./hooks/useHealth.js";
import { useServer } from "./hooks/useServer.js";
import { Games } from "./screens/Games.js";
import { Play } from "./screens/Play.js";
import { Practice } from "./screens/Practice.js";
import { useCoachPanel } from "./state/coach-panel.js";
import { serviceNotice } from "./state/health.js";
import { useTheme } from "./state/theme.js";

const SCREENS = ["Play", "Games", "Practice"] as const;
type Screen = (typeof SCREENS)[number];

export interface AppProps {
  fetchHealth?: FetchHealth;
}

export function App({ fetchHealth }: AppProps = {}) {
  const server = useServer();
  const notice = serviceNotice(useHealth(server.errorCount, fetchHealth ? { fetchHealth } : {}));
  const { theme, toggle: toggleTheme } = useTheme();
  const coach = useCoachPanel(server.coachMessages);
  const [screen, setScreen] = useState<Screen>("Play");

  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="topbar__wordmark">chess-coach</h1>
        <nav className="topbar__tabs" aria-label="Screens">
          {SCREENS.map((name) => (
            <button
              key={name}
              type="button"
              className="topbar__tab"
              aria-current={name === screen ? "page" : undefined}
              onClick={() => setScreen(name)}
            >
              {name}
            </button>
          ))}
          <button type="button" className="topbar__tab" disabled>
            Routine
            <span className="topbar__soon">soon</span>
          </button>
        </nav>
        <StatusChip server={server} notice={notice} />
        <button type="button" className="button topbar__theme" onClick={toggleTheme}>
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </header>
      <NoticeBanner message={server.lastError} onDismiss={server.dismissError} />
      <main className="frame" data-coach={coach.open ? "open" : "collapsed"}>
        {screen === "Play" ? <Play server={server} notice={notice} /> : null}
        {screen === "Games" ? <Games server={server} /> : null}
        {screen === "Practice" ? <Practice server={server} /> : null}
        <Chat server={server} open={coach.open} unread={coach.unread} onToggle={coach.toggle} />
      </main>
    </div>
  );
}
