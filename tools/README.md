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
