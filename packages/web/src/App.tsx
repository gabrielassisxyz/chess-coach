import { useState } from "react";
import { Chat } from "./components/Chat.js";
import { NoticeBanner } from "./components/NoticeBanner.js";
import { type FetchHealth, useHealth } from "./hooks/useHealth.js";
import { useServer } from "./hooks/useServer.js";
import { Play } from "./screens/Play.js";
import { Review } from "./screens/Review.js";
import { Train } from "./screens/Train.js";
import { serviceNotice } from "./state/health.js";
import { useTheme } from "./state/theme.js";

const SCREENS = ["Play", "Review", "Train"] as const;
type Screen = (typeof SCREENS)[number];

export interface AppProps {
  fetchHealth?: FetchHealth;
}

export function App({ fetchHealth }: AppProps = {}) {
  const server = useServer();
  const notice = serviceNotice(useHealth(server.errorCount, fetchHealth ? { fetchHealth } : {}));
  const { theme, toggle: toggleTheme } = useTheme();
  const [screen, setScreen] = useState<Screen>("Play");

  return (
    <div className="shell">
      <nav className="topbar" aria-label="Screens">
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
        <button type="button" className="topbar__tab topbar__theme" onClick={toggleTheme}>
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </nav>
      <NoticeBanner message={server.lastError} onDismiss={server.dismissError} />
      <main className="grid">
        {screen === "Play" ? <Play server={server} notice={notice} /> : null}
        {screen === "Review" ? <Review server={server} /> : null}
        {screen === "Train" ? <Train server={server} /> : null}
        <Chat server={server} />
      </main>
    </div>
  );
}
