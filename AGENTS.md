# chess-coach: Agent Briefing

> Read before every interaction. Living spec: short, imperative. On every gotcha or
> decision, append one line here.

> **What it is:** a web chess tutor. The student plays on a board in the browser, and a
> Claude Code session, driven through the Agent SDK, coaches: evaluates every move with
> Stockfish, teaches from the mistakes, schedules them for spaced repetition, and serves
> puzzles and a weekly routine. Chat and board are the two inputs; everything persists in
> SQLite.
> **Calibration:** Tier 2 · Phase: work. Personal stakes: a tool the owner uses daily and
> intends to grow. Update the phase as the project moves `work → right → fast`; an agent
> reads this line to decide how much rigor a change deserves.
> **Review gate:** light. The agent self-reviews its own diff in a fresh context before
> commit; no external reviewer until the MVP is in daily use.

## Stack & Commands

- **Stack:** Node 24 + pnpm 11 (`mise.toml`), TypeScript, pnpm workspace with three
  packages: `packages/server` (Fastify, WebSocket, better-sqlite3, Claude Agent SDK,
  Stockfish over UCI, chess.js), `packages/web` (Vite, React, chessground),
  `packages/shared` (types both sides import). `tools/` holds offline Python scripts that
  produce JSON (puzzle generation) and is never part of the runtime.
- **Install:** `pnpm install`
- **Dev:** `pnpm dev` runs both packages. The server listens on `127.0.0.1:3210` (`PORT`
  overrides) and Vite serves the app on `http://localhost:5173`, proxying `/api` and the
  WebSocket. The socket only accepts those two origins; `CHESS_COACH_ALLOWED_ORIGINS`
  (comma-separated) replaces them. A second instance (another checkout, a copied data dir) runs
  its server on another `PORT` and tells Vite with `CHESS_COACH_API_PORT`.
- **Data:** one SQLite file, `data/chess-coach.db`, under the repository root and git-ignored.
  `CHESS_COACH_DATA_DIR` moves it, `CHESS_COACH_CONTENT_DIR` moves the teaching content
  (`content/`). Puzzles are seeded from `content/puzzles` at every server start.
- **Test:** `pnpm test` (vitest, per package). Opt-in flags, off by default and never in
  `bin/ci`: `CHESS_COACH_STOCKFISH=1` runs the real-engine grading suite
  (`pnpm --filter @chess-coach/server test:stockfish`); `CHESS_COACH_SDK=1` runs the live
  Claude session probe (`test:sdk`, stdin closed); `CHESS_COACH_RECORD=<file>` records the SDK
  stream to that file. `CHESS_COACH_CHESSCOM=1` makes one real call to the public Chess.com API
  (`chesscom.real.test.ts`, shape only). `CHESS_COACH_EXPLORER=1` does the same for one Lichess explorer
  call (`explorer.real.test.ts`, needs `LICHESS_API_TOKEN`). `CHESS_COACH_LICHESS_GAMES=1` does it for one
  game of a public account's Lichess export (the last test of `lichess.test.ts`; the export needs no token,
  and `LICHESS_API_TOKEN` is sent when set).
- **Test scratch directories:** the server tests build every scratch path with `os.tmpdir()`, which
  the package's vitest setup (`packages/server/test/support/temp-root.ts`) points at one root per
  run, `chess-coach-tests-<pid>-*`, removed when the run ends; the next run removes a root that a
  killed run left. The root sits under `TMPDIR` when it is set, else on the build disk when the
  machine has the one `bin/ci` uses for Node's compile cache, else in the system temporary
  directory. A test never hard-codes a temporary path: `test/temp-root.test.ts` fails if one does.
- **Failure inventory:** `packages/server/test/failure-inventory.test.ts` names the test that
  proves each failure and restart path (not logged in, API key present, SDK exit mid-turn,
  Stockfish missing, engine fault, dropped socket, restart per game phase, undelivered
  notifications, refresh per activity kind, restart during training) and reads the files from disk. Renaming or
  deleting one of those tests means updating the inventory in the same change.
- **Design:** `packages/web/src/styles/tokens.css` is the only file allowed a colour literal;
  `packages/web/DESIGN-CHECK.md` is the rule-by-screen checklist. Change a screen, re-check
  its column.
- **Typecheck / lint:** `pnpm typecheck`, `pnpm lint` (Biome, lint and format in one)
- **Gate:** `bin/ci`, the exact thing GitHub Actions runs. Green locally means green in CI.
- **After clone:** `bin/install-hooks` once (gitleaks pre-commit, attribution commit-msg).
- **Import:** the Games screen imports Chess.com games by username and month range, Lichess games by
  username and month range, or a pasted PGN, and grades them in the background.
  `CHESS_COACH_USERNAMES` (comma-separated) names the student's accounts so a pasted PGN finds its
  side; without it the form asks for the colour. The Chess.com API is summarised in
  `docs/chesscom-api.md`.
- **Lichess import:** `POST /api/import/lichess {username, from, to}` takes whole UTC months and imports
  every finished standard game of the account in one step, with no list to pick from. The export is
  `GET /api/games/user/{username}` as NDJSON with the PGN inside each line, and it is the only network
  call. Games are stored as source `lichess` with the Lichess id as `source_id`, so a second run adds
  none, and the grader is kicked. The username must match `[A-Za-z0-9_-]{2,30}` before it reaches a URL,
  and a failing one answers 400 with no call. A 429 waits a minute and retries once, then answers 429; an
  answer over 20 MB is refused. The saved or environment token goes only in the `Authorization` header.
  The rating progress reads Chess.com games only, since a Lichess rating is on another scale and mixing
  the two would draw a jump that never happened.
- **Connections:** the Games screen's Connections panel saves the Lichess API token, the Lichess account
  and the Chess.com account in `settings` (`lichess_api_token`, `lichess_username`,
  `chesscom_username`), through `/api/connections`. A set `LICHESS_API_TOKEN` wins over the saved
  token, and the saved Chess.com account joins `CHESS_COACH_USERNAMES` for a pasted PGN; both are read
  per use. The token is tried against the explorer and the Chess.com account against its profile before
  saving; the Lichess account is only checked against its pattern, with no call, and prefills the
  Lichess import form. The token travels only in a REST body, never over the
  socket, whose `ws.command` logs the whole command, and no route returns it. Writes obey the socket's
  Origin and Host rule, so `CHESS_COACH_ALLOWED_ORIGINS` also governs them.
- **Openings:** `POST /api/openings/generate` turns the first fifteen moves of every graded game into
  "find the best move" puzzles (`own:` ids, source `own-games`, motifs `opening-white` and
  `opening-black`); the import grader runs it after each game. Practice's openings mode drills them. `POST /api/openings/generate {sources: ["explorer"]}` also expands the
  student's first moves with the replies most played at 0-1199 on the Lichess explorer (`explorer:` ids, source
  `lichess-explorer`, cache under `<data dir>/explorer-cache`, at most 2000 requests a run, one per 1.1 s); it
  is opt-in at the call and never runs after an import. `POST /api/openings/generate {sources: ["italian"]}` builds the White Italian drill from the 1800-2499 band against 0-1199 replies (`italian:` ids, source `italian-explorer`, motif `opening-italian`). The explorer now answers 401 without a Lichess API
  token: save one in Connections or set `LICHESS_API_TOKEN`.
  `POST /api/openings/generate {sources: ["repertoire"]}` stores the first Italian variation in `repertoires` and `repertoire_positions` (`openings/from-repertoire.ts`), one expected White move per variation and position. It is opt-in at the call and never runs after an import. Moves 1 to 3 are fixed at 1.e4 e5 2.Nf3 Nc6 3.Bc4 and reach starts there. White's moves read the 1800-2499 group (`ITALIAN_WHITE_RATINGS`): `pickItalianWhiteUci`, the most played within 50 cp of the engine's best, else the best: the usual rule, which now only settles a tie in the style points described below. Before that comes the plan rule, everywhere but on a setup move or a forced one: among the engine's lines within 50 cp of its best, the move whose SAN the unit already plays most often is chosen, and a tie in that count, like a unit that plays none of them, leaves the choice to the style points. Black's replies are walked most played first, so the most common line sets the plan and the rest of the unit keeps it wherever the engine allows; strong players adapt their move to each reply, which a student under 1000 learns and then mixes up at the board. `openings.generate` logs `planChoices`, the White moves the run stored where the plan rule chose. Black's replies read the 0-1199 group (`EXPLORER_RATINGS`): every reply while the product of Black's shares since 3.Bc4 stays at least 1 in 50, with at least 200 games, to ply 30. The variation is named after White's answer to 3...Bc5 (`Classical Variation (4.c3)`), the group is `Italian Game`; the name is given before the walk and follows the answer the walk stores there, which the plan rule can change, and a name another variation of the group already holds is refused with 409 `branch_refused`. A rerun follows the moves already stored, so an expected move never changes under the student, and only a likelier line through the same position moves a row's reach and line. Each White move stores its centipawn loss against the engine's best, `eval_cp` (the engine's evaluation of the position after it, centipawns from White's side with a mate as 10000, as the `analysis` event reads) and the result counts of that position at 0-1199. Its searches run to depth 16 or until a 30 s cap (`capMs` on `SearchRequest`), whichever comes first: at the cap the engine is sent `stop` and the best line of the deepest layer it completed is kept, so a slow position never ends the walk, where a timeout would end it at the same position on every rerun. The `SearchResult` carries that `depth` and `cutByTime`; every other search keeps the 5 s slack and fails past it. Each White move stores the depth as `eval_depth`, the shallowest of the searches behind its centipawn loss, null on a row an earlier run stored; the White answer that a reviewed game adds (`openings/repertoire-review-addition.ts`) is searched under the same cap and stores its depth the same way. A line continues past the coverage goal along the most played reply, up to White's 15th move: where no reply reaches 1 in 50, the one with the most games at 0-1199 is stored with its share and source `mainline` when the position has at least 200 games, else the engine's best reply is stored with no share and source `engine`, and White answers by the rule above. Their reach keeps its usual product, with 0 for an engine reply, so they sit under 1 in 50 and are not required coverage, except where the most played reply has under 200 games; a rerun follows the ones already stored. `openings.generate` logs the run's `ownMoves`, `replies`, `mainlineReplies`, `engineReplies`, `deepestPly`, `positionsCutByTime` (the searches the cap stopped) and `shallowestDepth` (the shallowest depth among those, null when none was stopped).
  A repertoire unit can be built from any root that leaves the Italian setup, not only from the Italian itself: `POST /api/openings/generate {sources: ["repertoire"], root: ["e4", "d5"]}` builds the unit of that root and logs it with the run. A root is a list of SAN moves that starts with 1.e4, plays the setup moves on White's side where the setup has one (e4, Nf3, Bc4), ends on the Black move that leaves it and is at most 8 plies long (`REPERTOIRE_ROOT_MAX_PLY`); the route replays it on a board and refuses anything else with `invalid_root`, storing nothing. The root's own moves are stored as `setup` rows and reach is measured from its last move, so a unit is the Italian's rules started somewhere else: White's answers (with no preference for the setup moves, which only the Italian's own plies have), branching, `mainline` and `engine` replies, the 30 s cap, ply 29 and the evaluations are unchanged. The group is the book's name for the root position (`Scandinavian Defense` for 1.e4 d5), else the root as a line (`1.e4 c6`), and the variation follows the naming rule with the root's last move as the naming reply (`Mieses-Kotroc Variation (2.exd5)`); a rerun finds the unit by its group and adds nothing. A group that already holds the unit of another root, which the book allows (1.e4 e5 2.Nf3 d6 and 1.e4 e5 2.Nf3 d6 3.Bc4 Be7 are both `Philidor Defense`), refuses the second root with 409 `root_conflict` and stores nothing; a unit with only the start of its root stored, which a run cut short at the beginning leaves, is carried on. No column holds a root: a unit's root is its `setup` rows, and `GET /api/repertoires` matches a root to a unit by the Black move its setup ends on. That response also carries `met`, one entry per position that reviewed games with outcome `not_reached` left to by a Black move (`root`, `opening_name`, `games` and the `repertoire_id` of the unit built from that root, null when there is none), most met first. The Practice hub lists those with no unit yet under White openings, each with an Add action that posts the root and shows the new unit's menu when the run ends; a root that has a unit is not listed. The unit counts as soon as its root is stored, so a run that stops at its request limit (`truncated`) or fails leaves a partial unit that the list already takes for the root's drill; the hub keeps such a root on offer until the page is reloaded, and after that running it again takes a POST of the root.
  The Italian Game can hold more than one variation: `POST /api/openings/generate {sources: ["repertoire"], branch: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3"]}` builds another variation of the group with White's last move of the branch forced at the position before it and the usual rule everywhere else, named by the naming rule from the forced move (`Giuoco Pianissimo (4.d3)`); a rerun finds it by that name and adds nothing, and a run cut short is carried on the same way. A branch is the Italian setup, then legal moves, ending on a White move from the 4th to the 15th; it takes no root, and the route refuses anything else with 400 `invalid_branch`. The generator refuses with 409 `branch_refused`, storing nothing, when no Italian variation exists yet, when the first one never reaches the position (the forced move would never be played) and when the move is the first variation's own move there (it would only copy it); the first variation's own answer to 3...Bc5 gives that variation's name, so that branch finds it and adds nothing. The book's branch points come from the line column of `content/openings/all.tsv` (`loadRepertoireBranchBook`, read at boot): the 32 positions after 3.Bc4 where its lines play more than one White move, the moves ordered by how many lines go through them. `GET /api/repertoires` lists in `branches` the ones the first variation reaches, the likeliest first, each with its `line` and every choice's `variation_name` and the `repertoire_id` of the variation that plays it there (or that a run cut short built with it), null when none does; the openings menu offers them under Italian Game behind Add a variation.
  A rerun never changes a stored move, so a unit stored under an earlier rule is rebuilt: `POST /api/openings/generate {sources: ["repertoire"], rebuild: true}`, with or without `root` or `branch`, walks the unit again from move 1 under the current rule and replaces its rows. The walk stores them under a group of their own (`Italian Game (rebuilding)`, which the openings menu lists while it runs), so the unit, its drills and its game reviews stay as they were meanwhile, and only once it ends one transaction moves them onto the unit, which keeps its id and takes the name its new answer gives, and deletes the old rows. In the same transaction a review card keyed by an old White move is kept, schedule and reviews untouched, while any unit still stores its position and move, and deleted otherwise, since cards are shared across units. A rebuild that fails or that its request limit cuts short (`truncated`) is thrown away and leaves the unit and its cards as they were; running it again resumes from the explorer cache, and a rebuild first clears what a rebuild the process died in left behind. The new rows have no idea text until `repertoire-ideas` runs again, and the rows a reviewed game added (source `game`) go with the old ones, since no walk makes them. A `rebuild` that is not true or false answers 400 `invalid_rebuild`. On a rebuild `openings.generate` logs `rebuild: true` and the result's `cardsKept` and `cardsDeleted`.
  The student weighs White's choice with style points: `POST /api/openings/generate {sources: ["repertoire"], points: {effectiveness: 2, soundness: 2, learnability: 2}}`, three whole numbers that add up to 6, with or without `root`, `branch` or `rebuild`. Left out, the points are the default of 2, 2 and 2 (`REPERTOIRE_DEFAULT_POINTS`); a measure missing or added, a number that is not whole or a split that does not add up to 6 answers 400 `invalid_points` and runs nothing, and only the repertoire source reads them. They choose among the candidates the plan rule leaves: every line within 50 cp of the engine's best where the unit plays none of them, the tied lines where it plays several. A move outside that margin is never chosen, whatever the points, and they never reach a setup move or a forced one. Each measure is rescaled over the candidates at one choice, the best of them scoring 1 and the worst 0, and a candidate's score is its rescaled values times the points on each. Effectiveness is the move's expected score among the games at 0-1199 (`EXPLORER_RATINGS`), its wins plus half its draws over its games. Soundness is the engine's score of its line. Learnability, the plain measure, is the share of the position's games at 0-1199 that play the move, so it says how natural the move is for a student at that level and nothing about the position's depth or its transpositions. Both measures of the student's band come from one more explorer request for the position, made only where at least two candidates remain and the points on effectiveness and learnability are not both 0. A position with under 200 games at 0-1199 says nothing about what students play, so no candidate gains on either measure there, and a move with under 200 games of its own is worth the position's average expected score. A tie in the score goes to the usual rule. The points apply to the positions a run stores: a rerun never changes a stored move under other points, and a unit stored under other points is rebuilt with `rebuild: true`. They are not stored with the unit, and the White answer that a reviewed game adds keeps the usual rule. The result and the `openings.generate` log carry the `points` the run weighed by, the default where none were given. The openings menu holds a Style points control, shown only where an Add is on offer: a split of the 6 points set to 2, 2 and 2 at first, that an Add of an opening or of a variation sends as `points` once it is not 2, 2 and 2, leaving the default to the server. An Add waits until all 6 points are placed.
- **Opening drill families:** `GET /api/openings/drills` groups the opening drill of each colour (the
  puzzles with motif `opening-white` or `opening-black`) by family, the text before the first colon of
  `puzzles.opening_name` (`openingFamilyOf` in shared). An entry has its `opening` (the family, or
  `UNNAMED_OPENING` for the positions with no name, one entry per colour), its `positions`, the
  `attempts_30d` and `first_try_30d` of the last 30 days, and the `repertoire_id` of the first variation
  stored under the same group name on that side, null when none; the most positions come first and the
  unnamed entry last. `start_training {mode: "openings", color, opening}` serves only that family, and
  without `opening` the whole colour, as before. A family the colour does not have is refused with
  `unknown_opening` before any run is written or replaced: it is compared with the stored names, and only
  those reach SQL, as bound parameters. A paused family run resumes from `training_runs.items_json`, so
  the family is stored nowhere. The hub puts each family where it is already listed: a "Positions from
  your games (N)" line in the menu of the opening that has its name, else on the row of the first
  opening met in games of that family, else a row of its own under White openings or a Black openings
  card; the rows wait until the openings met in games have been read. The old per-colour rows that drilled
  every family mixed are gone from the hub, though `start_training` without `opening` still serves them.
- **Lichess puzzles:** `zstdcat lichess_db_puzzle.csv.zst | pnpm --filter @chess-coach/server import:lichess-puzzles`
  adds the whole Lichess puzzle database (`lichess-db:` ids, source `lichess-db`) to the library, reading CSV from
  stdin into the usual data dir and printing rows added, skipped and failed. A row's `FEN` is shown after its first
  move; the rest is the solution. Every theme gets a `puzzle_themes` row and one motif goes in `puzzles.motif`
  (rarest first, `tactics` when none maps). A `PuzzleId` already stored as a `lichess_id` is skipped, so a rerun
  adds nothing. Commits in batches of 5000 rows; the file grows the database to about 3.6 GB, so run it on a copy first.
- **Grading:** a practice move is graded the moment it is dropped (`try_move`). A wrong try leaves
  the item open at the same position; `show_solution` ends it as given up and the board plays the
  solution line. A right answer ends with its move on the board, for a card as for a puzzle's last
  move: `fen` and `exploring.fen` are the position after it. A card given up keeps the position it
  was served in, because `solution_line` is the moves from `fen`. Every try is kept in
  `training_tries`, and puzzle accuracy is first-try solves
  (`puzzle_attempts.first_try`). The coach hears once per item, when it ends, except a puzzle solved first try without a hint: that writes no notification, the state carries `coach_comment: "offered"`, and `ask_coach_about_item {activity_id}` (refused with `stale_activity`, `not_in_training` or `already_requested`) writes it with the position and the solution. A `hint` marks the
  origin square of the expected move, clears on the next try, and makes the solve count as missed.
  Explore is a client mode that routes drops to `explore` instead of grading; Back to puzzle clears
  the line and restores graded drops. The activity carries the item's line so far (`moves`), the
  wrong tries beside their ply (`wrong_tries`) and one outcome per queue position
  (`queue_outcomes`, kept in `training_runs.outcomes_json`).
- **Puzzle rating:** the student's puzzle rating is plain Elo (K 32, start 1200) against the
  library's `difficulty_rating`; a first-try solve wins, anything else loses, an unrated puzzle
  (opening drills) moves nothing. It lives in `settings.puzzle_rating`, is replayed once from
  the stored attempts at boot when absent (`puzzles.rating` log event), and the activity carries it
  as `student_rating` with `rating_change` once a rated puzzle ends; the item carries `rating`. A
  puzzles queue is sampled by index seek (`listPuzzles` with `ratingAround`, never a count) from
  puzzles within 200 points of that number, widening by 200 per side until full and repeating a
  puzzle only when its window has too few new ones, skipping popularity under 50; Any also skips
  all opening material, and a motif with no `puzzle_themes` rows keeps the plain listing. The plain
  listing, used by the coach's puzzle tool and `GET /api/puzzles`, and the motif counts cover only the
  library, never `lichess-db` rows, since they read every matching row. Elo stays over Glicko-2 on
  purpose: against puzzles whose rating does not move and whose deviation is low, simulated runs
  settled on the same level with the same noise, Glicko-2 only arriving 10 to 30 puzzles sooner. A
  puzzle's own rating never moves, since one student's attempts say nothing about a number built
  from many players.
- **Practice runs:** a queue started from the Practice hub is kept in `training_runs`, written with
  each step. Opening a game, starting one or a restart pauses it; the hub offers Resume
  (`resume_training`) and Discard (`discard_training`), and a new start ends it as `replaced`. The
  boot never puts it back on the board by itself. A single item the coach serves is not persisted.
- **Repertoire drill:** `start_training {mode: "repertoire", repertoire_id, scope}` runs a stored
  variation as passes from move 1 (`activity/repertoire-session.ts`): the server plays Black and every
  White move not asked, and stops on the moves still to find. `recommended` takes at most 10 due moves,
  the highest reach first, `due` every due move and `all` every move; a move with no card is new and
  due. A new move is first shown with its answer and rated on a later pass; otherwise only the first
  attempt rates it (SM-2 in `repertoire_cards`, one card per position and move across variations), and
  a miss comes back on a later pass until it is right first time. In `all`, a move not due keeps its
  schedule when right. A wrong try within 50 cp of the engine's best that reaches another named opening
  carries that name. `GET /api/repertoires` lists each variation with what each scope would serve.
  A `level` on the command widens the drill from that repertoire to every variation of its group
  (`group`) or every unit of its side (`side`, the hub's White openings); without one it is the
  variation. The level's moves are merged so that a move two variations share, one card, is served
  once, under the variation where its reach is higher and the older one at a tie; a position that
  expects different moves in two variations asks the one whose line the pass plays. The item's
  `repertoire_id` and `variation_name`, and the drill's `repertoire_id`, name the variation of the
  move in play, and the drill and the paused run carry the `level`. `GET /api/repertoires` counts the
  levels from the same merge in `groups` and `sides`; the menu offers them where a side holds more
  than one opening or an opening more than one variation.
- **Coach conversations:** one per tab (`play`, `games`, `practice`), each its own `coach_sessions`
  row (`tab` column) resumed by its own Claude session id. The live game and the student's chat on
  Play write to `play`, training to `practice`, a question about a stored game to `games`. A tab's
  SDK stream starts on its first message and is closed after 10 idle minutes; at most one turn runs
  at a time across tabs, in arrival order. `new_conversation` closes the tab's row. Starting a game
  or a practice queue from the UI writes a divider (a `system` text row, `{label, at}`). The coach's
  model is pinned by `COACH_MODEL` in `packages/server/src/coach/session.ts`, and auto memory is off.
- **Stockfish:** the server expects a `stockfish` binary on `PATH` (`STOCKFISH_PATH`
  overrides). The engine is a runtime dependency, never vendored.
- **Evaluation cache:** `tools/build_eval_cache.py` turns the Lichess evaluation file into `evals.db`, a SQLite file keyed by a packed position; the binary format and the one pipeline command are in `tools/README.md`, and its tests run with `uv run --no-project --with orjson --with pytest pytest tools/test_build_eval_cache.py`. It is not in `bin/ci`.
- **Engine on Practice:** `analyse {fen, lines 1-5, depth 8-24}` runs the evaluation engine's
  analysis lane on a position and answers that connection with an `analysis` event (lines with
  SAN and a centipawn score from White's side, a mate as 10000). The search stops at the depth or
  after 4 s, whichever first: the request carries `depth` and `capMs` and never `movetime`, which
  would spend the whole 4 s on every position. The event's `depth` is the depth the lines reached,
  and `cutByTime: true` says the cap stopped the search first; the strip takes such an answer for
  the answer to its request, since asking again meets the same cap. It is refused with
  `training_item_open` while an item is open, so the
  engine never helps with the answer, with `not_in_training` or `stale_activity` off the item, and
  with `engine_unavailable` when Stockfish is missing or dead; a request a newer one replaced
  answers nothing. The
  strip's switch, line count and depth are stored in the browser (`chess-coach.engine-prefs`),
  as are the board preferences (`chess-coach.board-prefs`: coordinates, animation, highlights,
  auto-next) beside the board theme.

## Logs

- **Where:** one JSON object per line in `<data dir>/logs/<YYYY-MM-DD>.jsonl` (UTC day), also
  echoed to stdout, so `journalctl --user -u chess-coach.service` has the same lines. Files older
  than 30 days are deleted at boot. Every line has `ts`, `level` (`info`, `warn`, `error`),
  `event` and flat fields; a field over 8 KiB is cut and the line carries `truncated: true`.
  Errors add `error_name`, `error_message` and `stack`. Chat text and tool inputs are logged;
  environment variables, headers and tokens never are.
- **Writing:** every service takes a `Log` (`packages/server/src/log.ts`); tests pass a
  `RecordingLog` and assert on events. No `console.*` in `packages/server/src`.
- **Correlation:** `conn` (one per websocket), `command_id`, `activity_id`, `game_id`,
  `coach_session_id`, `tab` (the coach conversation), `turn` (one per message handed to the coach), `tool_use_id`.
- **Events:** `server.*`, `logs.pruned`, `process.*`, `puzzles.seeded`, `puzzles.rating`, `engine.start`,
  `engine.start_failed`, `engine.fault`, `http.request`, `http.client_error`, `http.error`,
  `ws.connect`,
  `ws.disconnect`, `ws.ping_timeout`, `ws.invalid_frame`, `ws.command`, `ws.command_done`,
  `ws.command_failed` (with the refusal `code`), `activity.change` (`from_kind`, `to_kind`,
  `cause`, and the position for a demo), `game.new`, `game.player_move`, `game.engine_move`,
  `game.undo`, `game.finished`, `game.recovering`, `game.recovered`, `game.recovery_failed`,
  `coach.session`, `coach.started`, `coach.start_failed`, `coach.turn_start`, `coach.tool_call`, `coach.tool_result`, `coach.turn_end`,
  `coach.conversation_reset`, `coach.stream_closed`,
  `coach.turn_failed`, `coach.turn_error`, `coach.permission_request`,
  `coach.permission_resolved`, `training.item_served`, `training.answer`, `srs.rated`,
  `review.cards_created`, `import.*`, `connections.*`, `openings.generate`, `openings.generate_failed`, `import_lichess.progress`, `import_lichess.done`,
  `explorer.failed`, `*.listener_failed`, and `client.*` for what
  the browser reports through `POST /api/client-log` (uncaught errors, socket drops and
  reconnects, every error frame it received).
- **Reading:** with `L=data/logs/$(date -u +%F).jsonl`:
  - everything about one game: `jq -c 'select(.game_id == 16)' $L`
  - every refused or failed command: `jq -c 'select(.event == "ws.command_failed") | {ts, type, code, message, error_message}' $L`
  - every coach turn and how long it took: `jq -c 'select(.event == "coach.turn_end") | {ts, turn, duration_ms, waited_ms, output_tokens}' $L`
  - what the board did and why: `jq -c 'select(.event == "activity.change") | {ts, cause, from_kind, to_kind}' $L`

## Scope (current)

- **Current scope:** a single-user tutor running on the owner's machine with the owner's
  Claude Code login. Don't expand beyond it without a present need; if a change drifts past
  it (multi-tenant, accounts, hosted deployment, API-key billing), STOP and flag it.
- **Work tracker:** `br`. Every unit of work is a bead; `br ready --unassigned` is the queue.

## Worktrees

- Every session works in its own worktree: `bin/worktree new <type>/<kebab-desc>` before the
  first write. The main tree stays on `main` as a clean reference.
- `.worktree-links` lists the git-ignored paths the tool symlinks into each worktree
  (`local`, `.env`, `.beads`, `.ai-jail`). No trailing slash on those in `.gitignore`.

<!-- BEGIN universal-principles v3 -->
## Working principles

- **The human defines the WHAT; the agent decides the HOW.** Plan first for non-trivial
  tasks: show the plan and the to-do list, and wait for approval before building.
- **State assumptions; never pick between readings silently.** If several fit, present
  them. If a simpler approach exists, push back. If the task is impossible as stated, or
  information is missing, say so instead of guessing. This is a bias, not a ritual.
- **Surgical changes — touch only what you must.** Every changed line traces to the task.
  Don't "improve" adjacent code, reformat, or refactor what isn't broken; match existing style
  even if you'd do it differently. Flag unrelated dead code — don't delete it. Remove only the
  imports / variables / functions your own change orphaned.
- **Chesterton's Fence — find the problem before undoing the decision.** A config, a flag, a
  workaround that looks arbitrary is a **fence**: someone put it there, probably to fix
  something that is invisible to you *because the fence is working*. You arrive with no
  history, so absence of a visible reason is evidence of your ignorance, not of its
  uselessness. When your fresh measurement contradicts what the human vaguely remembers
  ("I changed this once, because of some problem"), **your measurement is the suspect first**
  — it may be measuring the case that *isn't* failing. Go find the original problem, then
  decide. *(A CIFS share was benchmarked with a big sequential `dd`, looked fast, and the
  local-disk download dir was "fixed" away — while the actual failure was random writes:
  par2, unrar, torrent piece-writes. Two wrong commits.)*
- **"Flaky" is not a diagnosis — test in the environment the thing actually runs in.** A
  component that fails *consistently* under automation is being **mis-invoked**, not being
  unreliable; "it works when I run it by hand" is not evidence that it works. The shell you
  test in has a TTY, a `$HOME`, an `ssh-agent`, an interactive stdin — the systemd unit, the
  CI job and the scripted harness have none of those, so a passing manual run can be testing
  a different program. Reproduce it *there* (start the unit, `env -u SSH_AUTH_SOCK`,
  `</dev/null`, `--dry-run` to print the real command line) before accepting "unstable" as a
  cause. **When a fix doesn't change the symptom, stop fixing and go look at what is actually
  being executed.** *(An interactive-mode flag with no TTY made one harness fail every review
  panel for weeks, written off as "flaky"; it was the wrong flag.)*
- **KISS and YAGNI — don't build for a need that doesn't exist.** No preventive
  abstractions, no single-use interfaces. Architecture is *extracted* once a pattern proves
  itself in real use, never designed up front. Most over-engineering is doing "right" or
  "fast" before a working thing justifies it. When a solo tool starts being framed as a
  public / multi-tenant / plugin-system / configurable-N-backends platform with no present
  need, STOP and ask — that is a standing duty, not a suggestion.
- **Development cost is not your cost — don't let it pick the design.** Choosing between
  technical options, weight quality, simplicity, robustness and long-term maintainability;
  don't weight how long the work takes. The estimate comes out in human units — days,
  weeks — because that is what the training data measured, and the cheaper option then
  wins on a cost the agent does not pay. This is **not** licence to over-build: KISS and
  YAGNI decide *whether* a thing is needed, and this decides *how well* it is built once
  it is. "That would take a week" is not an argument here; "nothing needs this yet" is.
- **No silent decisions (comprehension debt).** Never make a silent architectural or
  design call — state it and record the rationale, so the reasoning is recoverable later.
- **Real decisions go in the chat, on their own — never via a popup.** Surface the options,
  what each means, the trade-offs, and a recommendation; then decide together. Don't bury
  it mid-text or bundle it with other topics, and don't compress it into a quick-pick widget
  (e.g. AskUserQuestion) — the widget overlays the reasoning instead of showing it. Widgets
  are for trivial short-answer picks only.

## Git: branches, commits, PRs, comments

- **Ask the repo for its default branch; never assume one.** Repos differ — `master` and `main`
  are both common, often in the same person's account — and a wrong guess sends a PR to a branch
  that does not exist, or, worse, has you "fixing" a URL that was right all along.
  `git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||'`, or
  `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.
  Never commit directly to it: branch, then PR.
- **A new repo starts on `main`.** That is the preferred name, and `init.defaultBranch` is
  set to it, so `git init` produces it without anyone choosing. It settles new repos only:
  an existing one keeps the branch it has, because renaming breaks open PRs, CI filters,
  deploy hooks and every permalink into the tree, and buys nothing. The rule above still
  governs everything already in existence — ask, never assume.
- **Branches** — Conventional Branch (conventionalbranch.org): `<type>/<kebab-description>`,
  types `feature/`, `bugfix/`, `hotfix/`, `chore/`, `release/`, `docs/`.
- **Commits** — Conventional Commits (conventionalcommits.org): `<type>(scope): <description>`,
  types `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `style`.
  Breaking change → `!` after the type or a `BREAKING CHANGE:` footer.
- **Atomic commits** — one logical change per commit, each independently green and
  revertible. Never `git add .` blind; split unrelated changes.
- **Always work in your own worktree — mandatory, not conditional.** Parallel sessions
  are opened freely and nothing signals their existence to you, so a "check whether another
  session is here first" step can never be reliable — the honest answer is always "maybe".
  The only collision-proof arrangement is structural: keep the main working tree on the
  default branch as a clean reference and **never work in it** — before your first write
  (commit, branch, rebase, stash; read-only exploration is exempt), create your own worktree
  and do everything there. **When the repo ships a worktree tool, that tool is the only correct
  way to make one** — `bin/worktree new <type>/<kebab-desc>`, or whatever the repo calls it.
  A raw `git worktree add` materialises tracked files and nothing else, so every git-ignored
  path the repo links into a worktree is silently absent, and the tools that read those paths
  fail inside it without saying why: a tracker whose database is git-ignored reports itself
  uninitialised and offers to create a second one. Only where the repo ships no such tool is
  `git worktree add ../<repo>-<task> -b <your-branch> <origin>/<default-branch>` the right
  command. Do this **whether or not** you believe another agent is running — that belief is
  exactly what you cannot verify. Report which worktree/branch you used; remove it once merged.
  Only the human can see all the open sessions.
- **Pull requests** — describe **what + why**. *What*: a 1–3 line summary. *Why* (the bulk):
  decisions, trade-offs, rejected alternatives. The diff shows the what; the PR explains why.
- **Comments** — always **WHY, not WHAT**: explain intent, never restate the obvious
  mechanics. Keep existing comments; they carry intent.

## Code style (baseline)

- Functions: 4–40 lines, one thing each (SRP). Files: under ~500 lines, split by responsibility.
- Names specific and unique — avoid `data`, `handler`, `Manager`, `util`.
- Explicit types. Early returns over nested ifs; max ~2 levels of indentation.
- Inject dependencies; wrap third-party libs behind a thin interface this project owns.
- No duplication — but don't extract *too early*. Tolerate duplication while the pattern is
  still forming; extract the abstraction *from* proven, repeated code, never ahead of it.
- **Refactoring is not automatic.** After a large feature, list the candidates and ask
  before pruning; consolidate once the thing works and the seams are obvious, not before.
<!-- END universal-principles v3 -->

## Tests (TDD)

- Every feature is born with a test; every bugfix with a regression test.
- Tests run with `pnpm test`, no manual setup, no credential. Anything that needs the real
  Stockfish binary or a live Claude session is an integration test behind an explicit
  opt-in flag, never in the default run.
- The Claude session probe is `CHESS_COACH_SDK=1 pnpm --filter @chess-coach/server test:sdk`;
  run it with stdin closed. The SDK needs `strictMcpConfig: true`, or the owner's claude.ai
  connector tools leak into the coach's tool list.
- Mock external I/O (engine process, Claude session, filesystem) with a named fake, not an
  inline stub.
- Before saying "done", run `bin/ci`; report the result.

## Small releases

- Every commit on `main` passes `bin/ci` and is runnable: no "broken commit I fix in the
  next one". Branch, commit, PR conventions are in the universal principles above.
- Closed work is committed before switching tasks; flag it if it has not been.

## Security (habit, not a phase)

- When touching user input, the WebSocket, the filesystem, the engine process or SQL,
  flag the risk and propose the guard (injection, path traversal, unbounded engine time).
- Dependency CVEs are caught by `pnpm audit --audit-level=high` in `bin/ci`.
- The Claude session runs with the owner's login. Tools exposed to it are the chess tools
  only; anything else goes through the permission callback and the UI.

## Prose

- No em-dash. Use a comma, a colon, a semicolon or a full stop. Checked by `bin/ci` over
  Markdown, source comments, config, commit messages and PR text alike.
- Bold marks structure (a bullet lead-in, a table header), never emphasis mid-sentence.
- No process narration anywhere a stranger can read it: no task ids, phase names, review
  rounds, or references to a session. Commit and PR text describe the problem and the
  change, never how the work was organised.
- Comment density is low by default: the non-obvious only, the why and not the what.

## Git & secrets

- Before any commit, show `git status` and `git diff --cached`; confirm no secret is
  staged. The gitleaks pre-commit hook is the deterministic backstop; this habit is the
  probabilistic one.
- Real secrets stay out of git. Only `.env.example` with fake values is committed.

## Post-implementation checklist (run before "done")

1. Commits small and well-described.
2. Refactoring candidates listed (if the change was large).
3. Security risks flagged (if you touched a sensitive surface).
4. This spec updated if behavior, setup, or release flow changed, and any hurdle it gained
   is classified, not just appended.

## Compliance audits

An audit of closed beads (the `beads-compliance-and-completion-verification` skill) writes to
`beads_compliance_audit/`, which `.git/info/exclude` keeps out of git. Here it also follows these
rules:

- **The gate's evidence is GitHub's.** A "Done when: `bin/ci` passes" criterion is checked against
  the `ci` job of the pull request's last head commit, and of the push run on `main`, read with
  `gh`: the job must have concluded `success` on that commit, not been skipped or cancelled. One
  local `bin/ci` run on a machine the audit is loading proves nothing either way.
- **A gap is real when the student can reach it.** Before a behaviour gap is filed or a bead is
  called false-closed, the audit traces the path from the screen to the failing state. A probe that
  shows a server state the screen never keeps is a test gap at most.
- **Lanes follow the skill's tier table.** An audit runs as many lanes as the skill gives for its
  size, two or three for about thirty beads: each lane is a fresh context, and their mutation runs
  share one machine.

## Common hurdles

| hurdle | class | gate |
|---|---|---|
| `pnpm` is a mise shim with no global version; run from the repo so `mise.toml` resolves it | tripwire | none yet |
| Port 3000 is taken on the owner's machine, so the server defaults to 3210; a new listener must not assume 3000 | tripwire | none yet |
| The Agent SDK needs `strictMcpConfig: true`, or the owner's claude.ai connector tools leak into the coach's tool list | tripwire | `session.test.ts` asserts the option; only the opt-in SDK probe proves the tool list |
| A merge that keeps both sides of "append at end of file" can join two functions across the conflict seam, and the result compiles or fails far from the conflict: read the merged hunk, not just the markers | tripwire | none yet |
| `grep` (and `find`) are shell functions in an agent session and silently skip git-ignored trees; use `command grep` | tripwire | none yet |
| The main tree's `node_modules` belongs to `chess-coach.service`, which runs the app from it: never run `pnpm install` there from a session, since an install under another `HOME` rewrites the store path and the service then crash-loops. After merging a change to `pnpm-lock.yaml`, restart the service so its own `pnpm dev` installs. Worktrees have their own `node_modules` and are unaffected | tripwire | none yet |
| `local/` links to the private notes repository, whose own sync may commit and push a new file within minutes: never write a file holding a secret there, even as an intermediate step. Clean or redact it in a scratch directory first | tripwire | none yet |
| A verification step that writes to the live database, such as `POST /api/openings/generate`, needs the owner's go-ahead even when an acceptance criterion names it. Run it against a copy of the data directory, on another `PORT` | tripwire | none yet |
| Biome's formatter turns a unicode escape for an em dash inside a string into the literal character, which the prose check then refuses, UI copy and test fixtures included: write copy without a dash | tripwire | `bin/ci` refuses the result, but only after every test has passed |
| The explorer does not refuse an unlisted `ratings` value: it maps each value to the group containing it (400 means 0-999), so a value that is not a listed boundary (0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500) quietly asks for another group | tripwire | none yet |
| A migration runs inside a transaction, where `PRAGMA foreign_keys = OFF` does nothing, so rebuilding `games` (create, copy, drop, rename) cascades into `moves`, clears `srs_cards.source_game_id` and trips `difficulty_changes.game_id`: to change a column of `games`, add the new one, copy it over, drop the old one and rename the new one, as `019_lichess_game_source.sql` does | tripwire | `migration-019.test.ts` holds it for that migration only |

**A hurdle promoted to a gate is deleted from this table, not duplicated.** The gate is the
instruction; a line here restating it only dilutes the ones still unguarded.
