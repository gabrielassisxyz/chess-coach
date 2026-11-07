import type { CoachTab, LiveGameActivity } from "@chess-coach/shared";
import { useEffect, useState } from "react";
import { Chat } from "./components/Chat.js";
import { CoachActions } from "./components/CoachActions.js";
import { NoticeBanner } from "./components/NoticeBanner.js";
import { PracticeCoachActions } from "./components/PracticeCoachActions.js";
import { StatusChip } from "./components/StatusChip.js";
import { type FetchHealth, useHealth } from "./hooks/useHealth.js";
import { useServer } from "./hooks/useServer.js";
import { Games } from "./screens/Games.js";
import { Play } from "./screens/Play.js";
import { Practice } from "./screens/Practice.js";
import { DEFAULT_COACH_IDLE, useCoachPanel, useTabUnread } from "./state/coach-panel.js";
import { serviceNotice } from "./state/health.js";
import { practiceIdleLabel, practiceWaitingLabel, trainingOf } from "./state/practice.js";
import { contextLineOf } from "./state/practice-item.js";
import { useTheme } from "./state/theme.js";

const SCREENS = ["Play", "Games", "Practice"] as const;
type Screen = (typeof SCREENS)[number];

// Each screen talks to the coach in its own conversation.
const SCREEN_TAB: Record<Screen, CoachTab> = { Play: "play", Games: "games", Practice: "practice" };

export interface AppProps {
  fetchHealth?: FetchHealth;
}

export function App({ fetchHealth }: AppProps = {}) {
  const [screen, setScreen] = useState<Screen>("Play");
  const server = useServer({ tab: SCREEN_TAB[screen] });
  const notice = serviceNotice(useHealth(server.errorCount, fetchHealth ? { fetchHealth } : {}));
  const { theme, toggle: toggleTheme } = useTheme();
  const coach = useCoachPanel(server.coachMessages, server.tab);
  const { play, games, practice } = server.conversations;
  const unreadTabs = useTabUnread(
    { play: play.coachMessages, games: games.coachMessages, practice: practice.coachMessages },
    server.tab,
  );
  const [coachIdle, setCoachIdle] = useState<string | null>(null);
  // The live game underneath a training run, so Play can show it read-only.
  const [liveGame, setLiveGame] = useState<LiveGameActivity | null>(null);
  // An empty board means the game is gone (aborted), so Play must not show it afterwards.
  useEffect(() => {
    if (server.activity?.kind === "live_game") setLiveGame(server.activity);
    if (server.activity === null) setLiveGame(null);
  }, [server.activity]);
  // Practice words the coach's idle state from the activity; Games sets it from the open game.
  // An ended item names the coach's pending reply first, until the chat events clear it.
  const idleLabel =
    (screen === "Practice"
      ? (practiceWaitingLabel(server.activity, server.practiceReplyPending) ??
        practiceIdleLabel(server.activity))
      : coachIdle) ?? DEFAULT_COACH_IDLE;

  const practiceItem = trainingOf(server.activity);
  const contextLine =
    screen === "Practice" && practiceItem && practiceItem.summary === null
      ? contextLineOf(practiceItem, practiceItem.run_motif ?? null)
      : null;

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
              data-unread={unreadTabs[SCREEN_TAB[name]] ? "true" : undefined}
              onClick={() => setScreen(name)}
            >
              {name}
              {unreadTabs[SCREEN_TAB[name]] ? (
                <span
                  className="topbar__dot"
                  data-testid={`tab-unread-${SCREEN_TAB[name]}`}
                  aria-hidden="true"
                />
              ) : null}
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
        {screen === "Play" ? (
          <Play
            server={server}
            notice={notice}
            liveGame={liveGame}
            onGoToPractice={() => setScreen("Practice")}
          />
        ) : null}
        {screen === "Games" ? (
          <Games server={server} onOpenPlay={() => setScreen("Play")} onCoachIdle={setCoachIdle} />
        ) : null}
        {screen === "Practice" ? <Practice server={server} /> : null}
        <Chat
          server={server}
          open={coach.open}
          unread={coach.unread}
          onToggle={coach.toggle}
          idleLabel={idleLabel}
          contextLine={contextLine}
          actions={
            screen === "Play" ? (
              <CoachActions server={server} />
            ) : screen === "Practice" ? (
              <PracticeCoachActions server={server} />
            ) : null
          }
        />
      </main>
    </div>
  );
}
