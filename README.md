# chess-coach

A web chess tutor. You play on a board in the browser; a Claude Code session coaches you:
every move is evaluated with Stockfish, mistakes become spaced-repetition cards, puzzles
and a weekly routine are served from the same place. Chat and board are both inputs; the
server owns the state and keeps it in SQLite.

The teaching method (three expert perspectives, evaluation thresholds, SM-2 scheduling,
level-appropriate language) and the reference material come from
[chess_rocket](https://github.com/suvojit-0x55aa/chess_rocket), reworked into a web
application. This repository is licensed under the GPL v3 for that reason; see `LICENSE`.

## The three screens

- **Play.** A board against Stockfish at an Elo you choose (100 to 3190). Every move you
  make is graded, the evaluation bar follows the position, and the coach in the chat
  column comments on it as the game goes. You can undo, resign or abort, and ask the coach
  to demonstrate a line on the board.
- **Review.** Finished games. Open one, step through it with the buttons or the arrow keys,
  ask the coach about the move you are on, and turn the mistakes into
  spaced-repetition cards.
- **Train.** The cards that are due, answered on the board and rated 0 to 5, and puzzle
  drills by motif. A queue ends with a summary of what was solved and missed.

The chat sits beside every screen. Its header shows whether the server is connected and
whether the coach is idle, thinking or streaming an answer.

## Requirements

- Node 24 and pnpm 11 (`mise install` reads `mise.toml`)
- A `stockfish` binary on `PATH`, or `STOCKFISH_PATH` pointing at one
- Claude Code installed and logged in. The tutor runs through the Agent SDK on your own
  login, so no API key is needed, and the server refuses to start if `ANTHROPIC_API_KEY` or
  `CLAUDE_API_KEY` is set, so that nothing is billed to the API by accident.

## Run

```sh
pnpm install
pnpm dev
```

Open <http://localhost:5173>. The server listens on `127.0.0.1:3210` (`PORT` overrides it)
and the web dev server proxies `/api` to it. The server only accepts browser tabs from
`http://localhost:5173` and `http://127.0.0.1:5173`; `CHESS_COACH_ALLOWED_ORIGINS` takes a
comma-separated list to change that. The same list opens Vite's host check, so one value
covers both: for a tailnet, `tailscale serve --bg 5173` on the machine and
`CHESS_COACH_ALLOWED_ORIGINS=https://<machine>.<tailnet>.ts.net` in the environment is all
it takes to use the app from a phone or a laptop on the tailnet.

If Stockfish is missing the app still opens and says so on the Play screen. If the coach
reports a login problem, run `claude` in a terminal, sign in with `/login` and restart the
server.

## Data

Everything lives in one SQLite file, `data/chess-coach.db`, under the repository root
(`CHESS_COACH_DATA_DIR` moves it). Games, moves, cards, puzzle attempts and the chat
transcript are in it, and the server resumes the coach conversation from it after a
restart. Delete the directory to start from nothing. `data/` is git-ignored.

## Test

`pnpm test` runs every package with no setup and no credential. Two suites need the real
thing and stay off until asked:

```sh
CHESS_COACH_STOCKFISH=1 pnpm --filter @chess-coach/server test:stockfish
CHESS_COACH_SDK=1 pnpm --filter @chess-coach/server test:sdk </dev/null
```

The first grades known positions with the real engine and checks the latency budget; the
second starts a real coach session on your login and checks the tool list it is given.

## Licence

GPL v3, see `LICENSE`. The teaching content under `content/` (prompts, references and
puzzles) comes from [chess_rocket](https://github.com/suvojit-0x55aa/chess_rocket) under the
same licence; `content/NOTICE` lists which files are verbatim and which were adapted. The
board is [chessground](https://github.com/lichess-org/chessground) with the cburnett piece
set, both GPL.

## Develop

`bin/ci` is the gate, identical to what GitHub Actions runs. Run `bin/install-hooks` once
after cloning. Conventions for agents and humans alike are in `AGENTS.md`.
