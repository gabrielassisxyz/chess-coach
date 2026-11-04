# chess-coach

A web chess tutor. You play on a board in the browser; a Claude Code session coaches you:
every move is evaluated with Stockfish, mistakes become spaced-repetition cards, puzzles
and a weekly routine are served from the same place. Chat and board are both inputs; the
server owns the state and keeps it in SQLite.

The teaching method (three expert perspectives, evaluation thresholds, SM-2 scheduling,
level-appropriate language) and the reference material come from
[chess_rocket](https://github.com/suvojit-0x55aa/chess_rocket), reworked into a web
application. This repository is licensed under the GPL v3 for that reason; see `LICENSE`.

## Status

Early. The scaffold runs; the tutor does not exist yet.

## Requirements

- Node 24 and pnpm 11 (`mise install` reads `mise.toml`)
- A `stockfish` binary on `PATH`
- Claude Code installed and logged in (the tutor runs through the Agent SDK with your own
  login)

## Run

```sh
pnpm install
pnpm dev
```

The server listens on `127.0.0.1:3000`; the web dev server proxies `/api` to it.

## Develop

`bin/ci` is the gate, identical to what GitHub Actions runs. Run `bin/install-hooks` once
after cloning. Conventions for agents and humans alike are in `AGENTS.md`.
