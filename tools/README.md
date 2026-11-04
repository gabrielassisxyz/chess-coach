# tools

Offline Python scripts that produce and check the puzzle files in `content/puzzles/`. They are
not part of the runtime and `bin/ci` does not run them. Run every command from this directory
with [uv](https://docs.astral.sh/uv/); `pyproject.toml` declares `python-chess` and `zstandard`.

| script | command |
|---|---|
| `validate_puzzles.py` | `uv run python validate_puzzles.py` (add `--engine-verify` to check solutions with Stockfish; `STOCKFISH_PATH` overrides the binary) |
| `import_lichess_puzzles.py` | `uv run python import_lichess_puzzles.py --help` (reads `data/lichess_db_puzzle.csv.zst`, downloaded from the Lichess open database) |
| `generate_puzzles.py` | `uv run python generate_puzzles.py --pipeline stockfish` (needs Stockfish on `PATH`) |
| `motif_detector.py` | a library imported by the other three, not run directly |

Inputs that are not committed live under `tools/data/`: the Lichess dump, the openings
database and saved games. The tactical and endgame pipelines of `generate_puzzles.py` need only
Stockfish. Its opening pipeline additionally needs `generate_opening_puzzles.py` and an openings
database, which were not carried over, so use `--pipeline stockfish` or `--pipeline games`.

`validate_puzzles.py` reports `from-games.json` as short of puzzles while that file is empty;
every other file validates.

## Importing the earlier tutor's cards

`import-chess-rocket-cards.ts` is a one-off TypeScript script, run from the repository root:

```
pnpm import:cards <path-to-srs_cards.json>
```

It writes into `data/chess-coach.db` (`CHESS_COACH_DATA_DIR` moves it) through the server's own
`insertCard`, prints `N inserted, M skipped`, and exits non-zero when any card was skipped for
an unparseable move (each is reported with its upstream `id`). A card whose `prompt_fen` and
`expected_uci` already exist is skipped, so a second run inserts nothing.

| upstream | `srs_cards` |
|---|---|
| (none) | `source_kind = 'teaching'`, no game or move |
| `fen` | `prompt_fen` |
| side to move in `fen` | `student_color` |
| `player_move` (SAN) | `played_uci` |
| `best_move` (SAN) | `expected_uci` |
| `cp_loss`, `classification`, `explanation`, `created_at` | same columns |
| `next_review` | `next_review_at` |
| `interval_hours`, `ease_factor`, `repetitions` | same columns |
| `id`, `motif`, `quality_history` | dropped |

Moves are converted from SAN to UCI with chess.js on the card's own FEN.

## Importing the earlier tutor's routine

The same script has a second command that stores the earlier tutor's `routine.md` as the first
weekly routine (`written_by = 'import'`, `week_start = 2026-10-27`):

```
pnpm import:routine <path-to-routine.md>
```

It prints `1 inserted, 0 skipped` the first time and `0 inserted, 1 skipped` after, because a body
identical to an already imported one is not stored again. Em-dashes in the file are replaced with
commas before storing.
