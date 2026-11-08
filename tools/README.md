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

## Evaluation cache

`build_eval_cache.py` turns `lichess_db_eval.jsonl.zst` (about 22 GB compressed, 417 million
positions) into `evals.db`, a SQLite file of about 41 GB that answers a position by key. It needs
only `orjson` (`uv run --no-project --with orjson python tools/build_eval_cache.py ...`). The
tests run with `uv run --no-project --with orjson --with pytest pytest tools/test_build_eval_cache.py`.

| command | stdin | effect |
|---|---|---|
| `transform` | source JSON lines | writes `hexkey<TAB>depth<TAB>base64value` lines to stdout; the summary and the first 10 failures go to stderr; exits 1 if any line failed |
| `load <new.db>` | sorted transform output | creates the file (refuses one that exists), inserts in batches of 100000, prints `rows=` and `seconds=`; progress on stderr every 50 million rows |
| `verify <db>` | source JSON lines | looks each up by key and compares depth, knodes, scores, mate flags, moves and which sets were kept; exits 1 on the first mismatch or missing row, naming it |

Rows must reach `load` in key order, so each insert appends to the end of the table. The file's
own order is random and inserting in it slows down until it stalls. The hex key is lowercase, so
`LC_ALL=C sort` on it gives the same order as SQLite's blob comparison.

### Build

Run in bash, from the repository root, with `<dest>` a directory on fast storage and `<tmp>` one
with tens of GB free (`sort -T`; the sort spills compressed chunks there).:

```
set -o pipefail
zstdcat /home/gabriel/lichess/lichess_db_eval.jsonl.zst \
  | uv run --no-project --with orjson python tools/build_eval_cache.py transform \
  | LC_ALL=C sort -t "$(printf '\t')" -k1,1 -S 6G --parallel=6 --compress-program=zstd -T <tmp> \
  | uv run --no-project --with orjson python tools/build_eval_cache.py load <dest>/evals.db.tmp
```

Then check every 1000th source line:

```
zstdcat /home/gabriel/lichess/lichess_db_eval.jsonl.zst | awk 'NR % 1000 == 0' \
  | uv run --no-project --with orjson python tools/build_eval_cache.py verify <dest>/evals.db.tmp
```

Rename `evals.db.tmp` to `evals.db` only after both commands exited 0: `transform` fails the
pipeline when a line could not be stored, and `verify` fails on the first wrong row. Stop and
look if the file passes 55 GB or the run passes 3 hours. A failed run is recovered by deleting
`evals.db.tmp` and starting again.

### Format

`evals (key BLOB PRIMARY KEY, source INTEGER NOT NULL, depth INTEGER NOT NULL, value BLOB NOT NULL) WITHOUT ROWID`,
page size 4096. `source` is 0 for Lichess and 1 for local analysis. `depth` is the depth of the
deepest stored set, repeated as a column so a conditional update can read it. All integers are
little-endian.

**Key.** The position is the first four fields of a FEN.

1. 8 bytes of occupancy. Bit 0 is the first square of the FEN placement (a8) and squares run in
   FEN reading order, so a8 is bit 0, h8 bit 7, a7 bit 8 and h1 bit 63.
2. One nibble per occupied square, in the same order, as the index in `PNBRQKpnbrqk`
   (P 0, N 1, B 2, R 3, Q 4, K 5, p 6, n 7, b 8, r 9, q 10, k 11), packed two to a byte with the
   first square in the low nibble, padded with 15 when the count is odd.
3. A 2-byte state: bit 0 is the side to move (1 for black), bits 1 to 4 are castling in the
   order `K Q k q` (none is 0), bits 5 to 8 are the en passant file (a is 0), 15 for none.

The en passant rank is not stored: it is 6 when White is to move and 3 when Black is. A FEN the
key cannot return exactly is a failure: castling other than `-` or letters of `KQkq` in that
order, an en passant square on the wrong rank, a malformed placement, a field count other than
four. `decode_key` rebuilds the text.

**Value.**

1. Format version byte, 1.
2. Set count byte, 1 or 2.
3. The sets. The first is the deepest evaluation. A second follows only when another evaluation
   has more lines than the deepest: the deepest of those with the most lines. Ties on depth keep
   the first in the file.

Each set is `depth u8`, `knodes u32` (capped at 4294967295), `line count u8`, then the lines.
Each line is a `u8` whose low 7 bits are the move count and whose bit 7 marks a mate score, an
`i16` score (centipawns, or moves to mate when the flag is set; clamped to the `i16` range),
then the moves. A line of more than 127 moves keeps the first 127; an empty `line` has zero
moves. An evaluation with no `cp` and no `mate`, a depth over 255 or more than 255 lines is a
failure.

**Move.** A `u16`: from-square in bits 0 to 5, to-square in bits 6 to 11, promotion in bits 12
to 14 (none 0, `n` 1, `b` 2, `r` 3, `q` 4). Squares are numbered from a1 as 0 to h8 as 63, so
this is the opposite rank order from the key's occupancy bits. Moves are stored as the file
writes them, in UCI_Chess960 form, so castling is king-takes-rook (`e1h1`). A rook on e1 can
legally play the same text, so turning it into standard UCI needs the position, and the reader
does that.

`decode_value` returns the sets as `{depth, knodes, lines: [{mate, score, moves}]}`.
`testdata/eval_cache_golden.json` holds source lines with the exact expected key, depth column
and value in hex, for a reader in another language to test against.
