import { useState } from "react";
import { Chat } from "./components/Chat.js";
import { NoticeBanner } from "./components/NoticeBanner.js";
import { type FetchHealth, useHealth } from "./hooks/useHealth.js";
import { useServer } from "./hooks/useServer.js";
import { Play } from "./screens/Play.js";
import { serviceNotice } from "./state/health.js";

const SCREENS = ["Play", "Review", "Train"] as const;
type Screen = (typeof SCREENS)[number];

function Placeholder({ name }: { name: Screen }) {
  return (
    <section className="placeholder" aria-label={name}>
      <p>{name} is not available yet.</p>
    </section>
  );
}

export interface AppProps {
  fetchHealth?: FetchHealth;
}

export function App({ fetchHealth }: AppProps = {}) {
  const server = useServer();
  const notice = serviceNotice(useHealth(server.errorCount, fetchHealth ? { fetchHealth } : {}));
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
      </nav>
      <NoticeBanner message={server.lastError} onDismiss={server.dismissError} />
      <main className="grid">
        {screen === "Play" ? (
          <Play server={server} notice={notice} />
        ) : (
          <Placeholder name={screen} />
        )}
        <Chat server={server} />
      </main>
    </div>
  );
}
