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
  `bin/ci`: `CHESS_COACH_STOCKFISH=1` runs the real-engine grading suite, the evaluation cache's
  score-sign check and the evaluation queue's niced search (`pnpm --filter @chess-coach/server test:stockfish`); `CHESS_COACH_SDK=1` runs the live
  Claude session probe (`test:sdk`, stdin closed); `CHESS_COACH_RECORD=<file>` records the SDK
  stream to that file. `CHESS_COACH_CHESSCOM=1` makes one real call to the public Chess.com API
  (`chesscom.real.test.ts`, shape only). `CHESS_COACH_EXPLORER=1` does the same for one Lichess explorer
  call (`explorer.real.test.ts`, needs `LICHESS_API_TOKEN`). `CHESS_COACH_LICHESS_GAMES=1` does it for one
  game of a public account's Lichess export (the last test of `lichess.test.ts`; the export needs no token,
  and `LICHESS_API_TOKEN` is sent when set).
- **Test scratch directories:** the server tests build every scratch path with `os.tmpdir()`, which
  the package's vitest setup (`packages/server/test/support/temp-root.ts`) points at one root per
  run, `chess-coach-tests-<pid>-*`, removed when the run ends; the next run removes a root that a
  killed run left. The root sits under `TMPDIR` when it is set, else in the system temporary
  directory, a tmpfs on the owner's machine: on the build disk, waiting on the test databases'
  syncs pushed tests past the 5 s limit on a busy machine. A test never hard-codes a temporary
  path: `test/temp-root.test.ts` fails if one does.
- **Failure inventory:** `packages/server/test/failure-inventory.test.ts` names the test that
  proves each failure and restart path (not logged in, API key present, SDK exit mid-turn,
  Stockfish missing, engine fault, evaluation cache unset or missing, evaluation queue engine fault or
  restart, dropped socket, restart per
  game phase, undelivered
  notifications, refresh per activity kind, restart during training, restart during a rebuild) and reads the files from disk. Renaming or
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
- **Openings:** `POST /api/openings/generate` (alone or with `sources: ["own"]`) records in
  `found_positions` (`openings/from-games.ts`) the positions worth practising from every graded,
  finished game, and the import grader runs it after each game. Three rules find them, the starting
  position never counting: the position before a student move from ply 2 on classified
  `inaccuracy`, `mistake` or `blunder` (`from_mistake`); a position with the student to move that two
  or more games reached from ply 2 on, a game that ended on the opponent's move counting its last
  position (`from_repeat`); and, in a White game, the position after the opponent's move that left a
  stored unit at ply 29 or earlier, which is the review row's `left_ply` on `not_reached` at an even
  ply, `reply_added` or `reply_not_stored` (`from_departure`). A position found several ways is one
  row, keyed by its `own:` id. A new one is searched once, at depth 16 with five lines and a 10 s cap,
  the result used at the depth reached, and `accepted_uci` stores the first moves of the lines less
  than 30 cp below the best, best first; a stored one is never searched again. Its flags,
  `reached_games`, `best_games` (games whose move there was `best`), `last_reached_at` (`played_at`,
  else `finished_at`) and the game shown, `game_id` and `ply` (the latest game with a mistake there,
  else the latest that reached it), are refreshed on every run, and a stored position no rule finds
  any more, as after a game deleted by hand, keeps its row with its flags cleared. A position is
  `listed` with one to four accepted moves that hold every best move graded there and none of the
  moves the student played there as a mistake, and a repeat with one to five whatever the grading
  says. A listed one is also a one-move puzzle (`own:` id, source `own-games`, answered by the first
  accepted move, motif `<phase>-<colour>`), the phase coming from `openings/game-phase.ts`: `endgame`
  at 6 pieces or fewer besides kings and pawns, else `opening` up to ply 30, else `middlegame`, from
  the lowest ply the position was reached at. A puzzle row already stored under the id is left as it
  is, and the `own:` puzzles of the earlier rule, which took every student move of the first fifteen
  moves, keep their rows and attempts. `openings.generate` logs `candidates`, `listed`,
  `fromMistake`, `fromRepeat`, `fromDeparture`, `searched` and `created`. Practice's openings mode
  drills the `opening-white` and `opening-black` puzzles. `POST /api/openings/generate {sources: ["explorer"]}` also expands the
  student's first moves with the replies most played at 0-1199 on the Lichess explorer (`explorer:` ids, source
  `lichess-explorer`, cache under `<data dir>/explorer-cache`, at most 2000 requests a run, one per 1.1 s); it
  is opt-in at the call and never runs after an import. `POST /api/openings/generate {sources: ["italian"]}` builds the White Italian drill from the 1800-2499 band against 0-1199 replies (`italian:` ids, source `italian-explorer`, motif `opening-italian`). The explorer now answers 401 without a Lichess API
  token: save one in Connections or set `LICHESS_API_TOKEN`.
  `POST /api/openings/generate {sources: ["repertoire"]}` stores the first Italian variation in `repertoires` and `repertoire_positions` (`openings/from-repertoire.ts`), one expected White move per variation and position. It is opt-in at the call and never runs after an import. Moves 1 to 3 are fixed at 1.e4 e5 2.Nf3 Nc6 3.Bc4 and reach starts there. White's moves read the 1800-2499 group (`ITALIAN_WHITE_RATINGS`): `pickItalianWhiteUci`, the most played within 50 cp of the engine's best, else the best: the usual rule, which now only settles a tie in the style points described below. Before that comes the plan rule, everywhere but on a setup move or a forced one: among the engine's lines within 50 cp of its best, the move whose SAN the unit already plays most often is chosen, and a tie in that count, like a unit that plays none of them, leaves the choice to the style points. Black's replies are walked most played first, so the most common line sets the plan and the rest of the unit keeps it wherever the engine allows; strong players adapt their move to each reply, which a student under 1000 learns and then mixes up at the board. `openings.generate` logs `planChoices`, the White moves the run stored where the plan rule chose. Black's replies read the 0-1199 group (`EXPLORER_RATINGS`): every reply while the product of Black's shares since 3.Bc4 stays at least 1 in 50, with at least 200 games, to ply 30. The variation is named after White's answer to 3...Bc5 (`Classical Variation (4.c3)`), the group is `Italian Game`; the name is given before the walk and follows the answer the walk stores there, which the plan rule can change, and a name another variation of the group already holds is refused with 409 `branch_refused`. A rerun follows the moves already stored, so an expected move never changes under the student, and only a likelier line through the same position moves a row's reach and line. Each White move stores its centipawn loss against the engine's best, `eval_cp` (the engine's evaluation of the position after it, centipawns from White's side with a mate as 10000, as the `analysis` event reads) and the result counts of that position at 0-1199. Its searches run to depth 16 or until a 30 s cap (`capMs` on `SearchRequest`), whichever comes first: at the cap the engine is sent `stop` and the best line of the deepest layer it completed is kept, so a slow position never ends the walk, where a timeout would end it at the same position on every rerun. The `SearchResult` carries that `depth` and `cutByTime`; every other search keeps the 5 s slack and fails past it. Each White move stores the depth as `eval_depth`, the shallowest of the searches behind its centipawn loss, null on a row an earlier run stored; the White answer that a reviewed game adds (`openings/repertoire-review-addition.ts`) is searched under the same cap and stores its depth the same way. A line continues past the coverage goal along the most played reply, up to White's 15th move: where no reply reaches 1 in 50, the one with the most games at 0-1199 is stored with its share and source `mainline` when the position has at least 200 games, else the engine's best reply is stored with no share and source `engine`, and White answers by the rule above. Their reach keeps its usual product, with 0 for an engine reply, so they sit under 1 in 50 and are not required coverage, except where the most played reply has under 200 games; a rerun follows the ones already stored. `openings.generate` logs the run's `ownMoves`, `replies`, `mainlineReplies`, `engineReplies`, `deepestPly`, `positionsCutByTime` (the searches the cap stopped) and `shallowestDepth` (the shallowest depth among those, null when none was stopped).
  A repertoire unit can be built from any root that leaves the Italian setup, not only from the Italian itself: `POST /api/openings/generate {sources: ["repertoire"], root: ["e4", "d5"]}` builds the unit of that root and logs it with the run. A root is a list of SAN moves that starts with 1.e4, plays the setup moves on White's side where the setup has one (e4, Nf3, Bc4), ends on the Black move that leaves it and is at most 8 plies long (`REPERTOIRE_ROOT_MAX_PLY`); the route replays it on a board and refuses anything else with `invalid_root`, storing nothing. The root's own moves are stored as `setup` rows and reach is measured from its last move, so a unit is the Italian's rules started somewhere else: White's answers (with no preference for the setup moves, which only the Italian's own plies have), branching, `mainline` and `engine` replies, the 30 s cap, ply 29 and the evaluations are unchanged. The group is the book's name for the root position (`Scandinavian Defense` for 1.e4 d5), else the root as a line (`1.e4 c6`), and the variation follows the naming rule with the root's last move as the naming reply (`Mieses-Kotroc Variation (2.exd5)`); a rerun finds the unit by its group and adds nothing. A group that already holds the unit of another root, which the book allows (1.e4 e5 2.Nf3 d6 and 1.e4 e5 2.Nf3 d6 3.Bc4 Be7 are both `Philidor Defense`), refuses the second root with 409 `root_conflict` and stores nothing; a unit with only the start of its root stored, which a run cut short at the beginning leaves, is carried on. No column holds a root: a unit's root is its `setup` rows, and `GET /api/repertoires` matches a root to a unit by the Black move its setup ends on. The same response says with each unit what it was built from, so that a rebuild can name it again: `root`, the moves of its `setup` rows when its group is not `Italian Game` and they form a valid root, else null, so that a variation of the Italian, whose setup is the same five moves whatever it was built at, has none, and so does a unit whose run stored no setup row, which has nothing to read; and `branch`, the line a variation of the Italian was built at, stored in `repertoires.branch_san` because no row marks the forced move, and null for any other unit and for a variation built before the column. Posting a unit's `root` or `branch` as listed, null included, with `rebuild: true` rebuilds that unit and no other, and posting both null rebuilds the first Italian variation. That response also carries `met`, one entry per position that reviewed games with outcome `not_reached` left to by a Black move (`root`, `opening_name`, `games` and the `repertoire_id` of the unit built from that root, null when there is none), most met first. The Openings page lists those with no unit yet on the second tab of the panel that Add an opening… opens after the last White card (the first tab lists every addable opening, see Addable openings), each with an Add action that posts the root and shows the new opening's card when the run ends; a root that has a unit is not listed there. The unit counts as soon as its root is stored, so a run that stops at its request limit (`truncated`) or fails leaves a partial unit that the list already takes for the root's drill; the hub keeps such a root on offer until the page is reloaded, and after that running it again takes a POST of the root.
  The Italian Game can hold more than one variation: `POST /api/openings/generate {sources: ["repertoire"], branch: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3"]}` builds another variation of the group with White's last move of the branch forced at the position before it and the usual rule everywhere else, named by the naming rule from the forced move (`Giuoco Pianissimo (4.d3)`); a rerun finds it by that name and adds nothing, and a run cut short is carried on the same way. A branch is the Italian setup, then legal moves, ending on a White move from the 4th to the 15th; it takes no root, and the route refuses anything else with 400 `invalid_branch`. The generator refuses with 409 `branch_refused`, storing nothing, when no Italian variation exists yet, when the first one never reaches the position (the forced move would never be played) and when the move is the first variation's own move there (it would only copy it); the first variation's own answer to 3...Bc5 gives that variation's name, so that branch finds it and adds nothing. The book's branch points come from the line column of `content/openings/all.tsv` (`loadRepertoireBranchBook`, read at boot): the 32 positions after 3.Bc4 where its lines play more than one White move, the moves ordered by how many lines go through them. `GET /api/repertoires` lists in `branches` the ones the first variation reaches, the likeliest first, each with its `line` and every choice's `variation_name` and the `repertoire_id` of the variation that plays it there (or that a run cut short built with it), null when none does; the Openings page offers them on the Italian Game card behind + Add a variation. A rebuild of one variation never touches the other variations of its opening.
  A rerun never changes a stored move, so a unit stored under an earlier rule is rebuilt: `POST /api/openings/generate {sources: ["repertoire"], rebuild: true}`, with or without `root` or `branch`, walks the unit again from move 1 under the current rule and replaces its rows. The walk stores them in a copy under a group of their own (`Italian Game (rebuilding)`), which no part of the app reads but the rebuild: game reviews, the drills of a variation, a group or a side, the start of a drill, `GET /api/repertoires` with its met and addable openings, and the ideas run all leave out every group that ends with ` (rebuilding)` (`REPERTOIRE_REBUILD_GROUP_SUFFIX` in `db/repertoires.ts`, checked inside each reader's SQL), so the unit, its drills and its game reviews stay as they were meanwhile and no card is made from the copy. While it runs, `GET /api/repertoires` carries the unit's id as `rebuilding_id`, null otherwise and held in memory only, and the Openings page says Being rebuilt beside that variation's name, its Train still starting. Only once it ends does one transaction move the rows onto the unit, which keeps its id and takes the name its new answer gives, and delete the old rows. In the same transaction a review card keyed by an old White move is kept, schedule and reviews untouched, while any unit still stores its position and move, and deleted otherwise, since cards are shared across units. A rebuild that fails or that its request limit cuts short (`truncated`) is thrown away and leaves the unit and its cards as they were; running it again resumes from the explorer cache. A copy that a process stopped in the middle of a rebuild left behind is removed at boot, before the server listens, and logged once per group as `openings.rebuild_copy_removed` with the `group` and the `rows` removed, nothing being logged when there is none; the unit's own rows, cards and reviews stay as they were, and a rebuild also clears such a copy before it starts. The new rows have no idea text until `repertoire-ideas` runs again, and the rows a reviewed game added (source `game`) go with the old ones, since no walk makes them. A `rebuild` that is not true or false answers 400 `invalid_rebuild`. On a rebuild `openings.generate` logs `rebuild: true` and the result's `cardsKept` and `cardsDeleted`.
  The student weighs White's choice with style points: `POST /api/openings/generate {sources: ["repertoire"], points: {effectiveness: 2, soundness: 2, learnability: 2}}`, three whole numbers that add up to 6, with or without `root`, `branch` or `rebuild`. Left out, the points are the default of 2, 2 and 2 (`REPERTOIRE_DEFAULT_POINTS`); a measure missing or added, a number that is not whole or a split that does not add up to 6 answers 400 `invalid_points` and runs nothing, and only the repertoire source reads them. They choose among the candidates the plan rule leaves: every line within 50 cp of the engine's best where the unit plays none of them, the tied lines where it plays several. A move outside that margin is never chosen, whatever the points, and they never reach a setup move or a forced one. The style points choose White's moves from the end of the root on, before move 4 included, wherever the rule chooses (in 1.e4 d5, 2.exd5 or 2.Nc3). Each measure is rescaled over the candidates at one choice, the best of them scoring 1 and the worst 0, and a candidate's score is its rescaled values times the points on each. Effectiveness is the move's expected score among the games at 0-1199 (`EXPLORER_RATINGS`), its wins plus half its draws over its games. Soundness is the engine's score of its line. Learnability, the plain measure, is the share of the position's games at 0-1199 that play the move, so it says how natural the move is for a student at that level and nothing about the position's depth or its transpositions. Both measures of the student's band come from one more explorer request for the position, made only where at least two candidates remain and the points on effectiveness and learnability are not both 0. A position with under 200 games at 0-1199 says nothing about what students play, so no candidate gains on either measure there, and a move with under 200 games of its own is worth the position's average expected score. A tie in the score goes to the usual rule. The points apply to the positions a run stores: a rerun never changes a stored move under other points, and a unit stored under other points is rebuilt with `rebuild: true`. A unit keeps the points it was created or rebuilt with in `repertoires` (`points_effectiveness`, `points_soundness` and `points_learnability`, null together for a unit created before they were stored), and `GET /api/repertoires` returns them as `points`; a run that only adds rows to a stored unit leaves them as they are, and a rebuild that fails or that its request limit cuts short leaves the unit with its old points and its old rows. The White answer that a reviewed game adds keeps the usual rule. The result and the `openings.generate` log carry the `points` the run weighed by, the default where none were given. The Openings page holds a Style points control in each panel an Add is offered from: a split of the 6 points set to 2, 2 and 2 at first, that an Add of an opening or of a variation sends as `points` once it is not 2, 2 and 2, leaving the default to the server. An Add waits until all 6 points are placed.
- **Opening drill families:** `GET /api/openings/drills` groups the opening drill of each colour (the
  puzzles with motif `opening-white` or `opening-black`) by family, the text before the first colon of
  `puzzles.opening_name` (`openingFamilyOf` in shared). An entry has its `opening` (the family, or
  `UNNAMED_OPENING` for the positions with no name, one entry per colour), its `positions`, the
  `attempts_30d` and `first_try_30d` of the last 30 days, and the `repertoire_id` of the first variation
  stored under the same group name on that side, null when none; the most positions come first and the
  unnamed entry last. `start_training {mode: "openings", color, opening}` serves only that family, and
  without `opening` the whole colour, as before. A family the colour does not have is refused with
  `unknown_opening` before any run is written or replaced: it is compared with the stored names, and only
  those reach SQL, as bound parameters. The run stores the items it was drawn with in
  `training_runs.items_json` and no family. The web no longer reads the route or sends the command: the
  Openings page draws no line, row or card for a family, and the positions those drills served are the
  From my games page's. The server keeps accepting both, and `start_training` without `opening` still
  serves a whole colour.
- **Addable openings:** `GET /api/openings/addable` lists every book family Black can leave the 1.e4 path with (first moves other than e5, second moves other than Nc6 after 1.e4 e5 2.Nf3), one entry per family with the root, the book name, the student's game count from `met[]`, the share at 0-1199 and the unit already built, if any. A family reached by several moves keeps its alphabetically first one. The shares come from two explorer reads (after 1.e4 and after 1.e4 e5 2.Nf3) and are null without a token or on failure. The first tab of the Add an opening panel draws it (`fetchAddableOpeningsFromServer`): it is read when the panel opens, never with the page, and again whenever an add ends, so that a row built meanwhile says so; the search narrows the list already read and asks the server nothing.
- **Openings page figures:** each entry of `repertoires[]` and of `groups` in `GET /api/repertoires` (a group is an opening, the variations that share its name) carries `moves_total`, `remembered_30d`, `in_line`, `covered_percent` and `line`, computed at request time with nothing stored (`http/repertoire-summary.ts`). `moves_total` is the White moves the variation stores, its setup moves included; for an opening it is the union of its variations, a move two of them share counted once, as the drill merges them. `remembered_30d` is `{right, of}`, the first attempts the line drill rated in the 30 days before the request (`repertoire_first_attempts`), summed over the variations of an opening, since an attempt belongs to one variation. `in_line` is `{stayed, of}` over `repertoire_game_reviews`: `in_book`, `reply_added` and `reply_not_stored` stayed, `departed` left, and `not_reached` and `other_side` are in neither count because they carry the Italian's id as a fallback, not the variation the game met; the sum over an opening is exact since a game is reviewed against one variation. `covered_percent` is the walk behind `GET /api/repertoires/:id/coverage` (`repertoireCoveredPercent`, no explorer or engine call), null while nothing is stored; for an opening the walk runs over the rows of all its variations at once, so a reply is covered when any variation answers it, and where two variations answer one position with different moves it follows the likelier row, the older variation at a tie, and does not visit the other's branch. An opening of one variation reuses that variation's figures instead of walking again. A group's `line` is its setup moves numbered from move 1 (`1.e4 e5 2.Nf3 Nc6 3.Bc4`, `1.e4 d5`), null while no setup move is stored. A variation's `line` runs from the end of the setup to the White move it is named after: `3...Bc5 4.d3` for the first Italian variation (the White move stored right after 3...Bc5), `2.exd5` for the first unit of a root (the move stored right after the root), the rest of its stored branch for a variation built at a branch point (`3...Nf6 4.Ng5`), and null for any other variation of a group and for a first variation whose answer is not stored. The figures and `line` are optional in the shared schemas, like `points`, `root` and `branch`, so a fixture need not carry them.
- **Openings page:** `components/PracticeOpenings.tsx` draws the one `GET /api/repertoires` answer
  (`useOpeningAdds` in `components/RepertoireMenu.tsx` reads it and again after each add; the hub no
  longer loads a repertoire list of its own). A header with the side control (All, As White, As Black;
  a colour not shown stays mounted, hidden), then a section for each colour, always both: its
  heading with "N openings · D due" (`sides[].moves.due`), a train button "Train all · N" when it holds
  more than one opening, a card for each entry of `groups` and, for a colour with none, "No opening is
  stored yet." (White) or "No Black line yet. The app does not build Black lines yet." (Black) in a
  dashed box. A card starts closed and opens by its head to a row for each variation, which
  shows the same five cells (Moves, Due now, Remembered 30 days, In line, Coverage) from that
  variation's figures; a cell with nothing measured draws the no-value dash and no bar. Pressing a
  variation's name opens the page of that line (see Line page). A train button (`components/TrainButton.tsx`) reads
  "Train N" with the level's `recommended` count and sends `start_training {mode: "repertoire",
  repertoire_id, scope: "recommended"}` with `level` `side` on a colour, `group` on a card and none on a
  row, the id being the first variation listed at that level; its chevron opens "Everything due N" and
  "All moves N". With nothing recommended it is an outlined "Train all moves" that sends `all`, with no
  menu. "+ Add a variation" is drawn on a card whose book has a choice no variation plays (or whose run
  stopped short) and opens the book's positions under its head; "Add an opening…" is always drawn
  after the last White card and opens in its place the panel of `components/PracticeAddOpening.tsx`,
  which opens on "All openings". Its header holds the title, two tabs and Close, and under it the style
  points control, one split for the page, so that an add waits until all 6 points are placed. "All
  openings" is `GET /api/openings/addable` in the order given, under "Against 1.e4" for a root of two
  moves and "Against 1.e4 e5 2.Nf3" for a root of four, each row a name, its moves (a later move alone,
  the heading saying the path), a pill "N games of yours" when the student met it and Add, or "In your
  openings" for a root with a whole line (a run that stopped short keeps its Add). A search field
  narrows it by name or moves, whatever the case and with or without the dots of the move numbers, and
  a failed read says so with Try again while the second tab keeps working. "From my games (N)" is
  the `met` entries with no line, most games first, each with its games and Add. Both lists stay
  mounted while the other tab shows. An Add posts the entry's root, with the style points only when they
  are not 2, 2 and 2. While an add runs its button reads "Building", every other add and every
  train button is disabled and the status sentences show under the card's head or the Add an opening
  button, kept after the panel closes. The page's styles, the panel's included, are
  `styles/practice-openings.css`; the classes of the style points and the coverage view are in
  `styles/repertoire.css`.
  Each colour that holds a stored opening closes with the block "Puzzles from these openings"
  (`components/PracticeOpeningPuzzles.tsx`), under its cards and, for White, the Add an opening
  button; a colour with no stored opening has none, and the side control hides it with its colour.
  The names it asks about come from `openingPuzzleNamesOf` in `state/opening-puzzles-api.ts`: the
  colour's stored openings in the page's order, then, for White, the families (`openingFamilyOf`) of
  `met[]` in its order, none twice, a `met` entry with no name skipped, at most 12
  (`OPENING_PUZZLE_TILE_LIMIT`). The block reads `GET /api/puzzles/openings` once for each colour
  with those names, and again only when the names change or Try again is pressed, and draws a tile
  for each entry that has puzzles, in the order asked: the name, `first_try_30d` over `played_30d` as
  a whole percentage in the theme tiles' bands (`new` when `played_30d` is 0) and "N puzzles" with
  thousands separators. The tiles are the Overview's theme tiles, classes and measures included. A
  tile sends `start_training {mode: "puzzles", opening: <tag>}` with the entry's `tag` through
  `beginOpeningPuzzles` in `screens/Practice.tsx`, which keeps the tag in the `motif` field of the
  start in flight, so the Overview's theme buttons never take it for their own; a refusal shows on
  this page like any other start. Every tile waits while any start is in flight, while an opening is
  being added (the hub would unmount and lose the page's memory of the add) and while the engine is
  missing. A failed read says `The puzzles of your openings could not be loaded.` with Try again
  inside the block and leaves the rest of the page as it was, and a block whose entries all have no
  puzzle says `No Lichess puzzle comes from these openings.`.
- **Line page:** a variation's name on the Openings page opens that line's own page in the list's
  place (`components/PracticeLine.tsx` and `PracticeLineCoverage.tsx`, rendered by
  `PracticeOpenings`). The hub holds which line is open as `line` in `usePracticeEntry`
  (`state/practice-page.ts`), the first page to take a parameter: the navigation keeps Openings
  chosen, "Openings" in the breadcrumb "Openings › <group name>" and a press on the Openings entry
  return to the list, and the id is kept in memory only, so a reload shows the list. The list stays
  mounted and hidden under the page, so an add or a rebuild in flight is not lost. Opening the page
  reads `GET /api/repertoires` again and takes the variation from it; an id the list no longer
  holds says "This line is no longer stored." The page shows the name, the variation's `line` in
  mono, a Train button with the row's counts and no level, five tiles (Moves in the line, Due now,
  Remembered in 30 days as "R of N", In line as "S of N games", Coverage as a whole percentage, the
  no-value dash for a figure not measured), a Coverage card and a style card. The Coverage card reads
  `GET /api/repertoires/:id/coverage` as the page opens and again after each ending of a rebuild: one
  line "expected score E · soundness S · largest gap: <reply and chance>, or none", then Black's
  replies of one position at a time with the move, "1 in N" and the status, a covered reply with a
  `next` position being a button that goes down into it, and "Up one move". The style card says
  "built with E · S · L" from `points`, or "built before style points", holds three steppers (the
  rows of the style points control, starting at `points`, or 2, 2 and 2 when it is null) and
  "Rebuild with these points", which waits until all 6 points are placed and sends `POST
  /api/openings/generate {sources: ["repertoire"], rebuild: true, root, branch, points}` with the
  variation's `root` and `branch` as the list gives them, null included, and the points as they are,
  2, 2 and 2 included. While the request is open (`useLineRebuild` in `state/line-rebuild.ts`, held
  by the Openings page so that it outlives the line's page) the button reads "Rebuilding…", disabled,
  the page says "This line is being rebuilt. It keeps working as it was until the rebuild ends.",
  Train stays enabled and the list row says Being rebuilt; a page opened while `rebuilding_id` names
  the variation reads the same. When the request ends the list and the coverage are read again and
  one sentence is shown: "The line is rebuilt.", "The rebuild stopped before the end; the line is as
  it was." (`truncated`), "Another opening is being built. Try again when it ends." (409
  `already_running` only, told apart by its body) or "The rebuild failed; the line is as it was."
  with Try again, for any other refusal and for a lost connection. A variation that names neither a
  `root` nor a `branch` is the first Italian variation only if it is the oldest of its group; any
  other was stored before its branch was recorded, and a rebuild posted for it would walk the first
  one under points meant for it, so its button stays disabled and the page says why. "Edit line"
  is not built, since the owner removed it from the design. The stylesheet is
  `styles/practice-openings.css`.
- **Lichess puzzles:** `zstdcat lichess_db_puzzle.csv.zst | pnpm --filter @chess-coach/server import:lichess-puzzles`
  adds the whole Lichess puzzle database (`lichess-db:` ids, source `lichess-db`) to the library, reading CSV from
  stdin into the usual data dir and printing rows added, skipped and failed. A row's `FEN` is shown after its first
  move; the rest is the solution. Every theme gets a `puzzle_themes` row, every opening tag a `puzzle_openings`
  row (Puzzles by opening), and one motif goes in `puzzles.motif` (rarest first, `tactics` when none maps). A `PuzzleId` already stored as a `lichess_id` is skipped, so a rerun
  adds nothing. Commits in batches of 5000 rows; the file grows the database to about 3.6 GB, so run it on a copy first.
- **Deleting a unit:** `pnpm --filter @chess-coach/server delete:repertoire-unit -- --group "King's Pawn Game: McConnell Defense" [--dry-run]` removes the unit the hub's Add built from 1.e4 e5 2.Nf3 Qf6 through `deleteRepertoireUnit` (`db/repertoires.ts`), in one transaction: its positions, game reviews and drill first attempts through the cascade, the cards of its White moves that no other unit stores, and every open run whose queue holds one of its rows or whose current item names it, ended as `discarded`. Once that commits, the games whose review went are reviewed again against the units left, with no message to the coach. It prints the unit, its setup line and the counts; it refuses with exit 1 and writes nothing unless the group holds exactly one variation, rooted at e4 e5 Nf3 Qf6; `--dry-run` runs the delete, prints the same and rolls it back. The group is the book's whole name for the root position, so `King's Pawn Game` alone is refused with the stored groups listed. It never migrates: a database whose applied migrations are not exactly the checkout's is refused, so it runs after the server has started from that checkout. Run it on a copy first, and with no drill of the unit on the board: the delete ends that run's row, but the drill the server holds in memory would go on serving rows that are gone.
- **Card scheduling:** every card the app schedules is scheduled by FSRS-6 through `ts-fsrs`, pinned at
  exactly 5.4.2 and imported by `packages/server/src/srs/fsrs.ts` alone, which `srs/fsrs.test.ts` enforces.
  That is the review cards of the Due cards desk (`srs_cards`), the opening repertoire's move cards
  (`repertoire_cards`) and the positions from the student's games (`found_cards`). The parameters are the
  library's defaults, written out in the module so that an upgrade cannot move a schedule unseen: the
  `default_w` weights, `request_retention` 0.9, a longest interval of 36500 days, Anki's learning steps
  (1 and 10 minutes, relearning 10) and no fuzz, which a deck of a few dozen cards gains nothing from and
  which keeps the interval on a button equal to the interval the card gets. A new card answered Again is
  due in 1 minute, Hard in 6, Good in 10 and Easy in 8 days; answered Good each time it falls due it comes
  back after 10 minutes, then 2, 11, 46 and 163 days; answered Again at its 46-day review it comes back in
  10 minutes and, answered Good then, in 3 days. The three tables hold `fsrs_state` (0 New, 1 Learning, 2
  Review, 3 Relearning), `stability`, `difficulty`, `learning_step`, `lapses`, `interval_hours` (the
  interval the last rating scheduled, a fraction for a step in minutes), `last_reviewed_at` and
  `next_review_at`. A grade is 1 Again, 2 Hard, 3 Good or 4 Easy: `srs_reviews.grade` keeps each rating of
  a review card, and `quality`, the old 0 to 5 scale, stays on the rows written before the grades and is
  NULL on every new one. Only the Due cards desk lets the student choose: four buttons, Again, Hard, Good
  and Easy, each showing the interval its grade gives (`rating_preview`, in hours, keyed "1" to "4"), the
  keys 1 to 4 and Enter on the suggested grade. `rate_card` carries `grade` from 1 to 4 and its schema is
  strict, so a command with a `quality` is refused as `invalid_command`. The drills rate by themselves,
  Good for a pass and Again for a miss: the line drill and the From my games drill on the first attempt,
  and the game review on each stored move a graded game followed (Good) and the one it departed from
  (Again). In all three a right answer on a card that is not yet due keeps its schedule. Each rating of a
  repertoire or found card writes a row in `drill_reviews` (`card_kind`, `card_key`, `reviewed_at`,
  `grade`), in the transaction that moves the card and with no foreign key, so a deleted unit keeps its
  history; the key of a repertoire card is `<position_key> <move_uci>`, a found card's its position id.
  Neither table had a review log, and fitting FSRS's parameters to the student later needs one. Migration
  033 converted the cards the earlier fixed-interval scheduler had set without moving any
  `next_review_at`: a card with no review stayed New, and a rated card became Review with its interval in
  days as `stability` and a
  `difficulty` of 2.1181 when its last review passed or 6.4133 when it failed, the values FSRS gives a new
  card answered Good and Again; `tools/import-chess-rocket-cards.ts` maps the earlier tutor's schedule by
  the same rule. The migration has no down step: undoing it is reverting its change and restoring the
  database backup.
- **Grading:** a practice move is graded the moment it is dropped (`try_move`). A wrong try leaves
  the item open at the same position; `show_solution` ends it as given up and the board plays the
  solution line. A right answer ends with its move on the board, for a card as for a puzzle's last
  move: `fen` and `exploring.fen` are the position after it. A card given up keeps the position it
  was served in, because `solution_line` is the moves from `fen`. A puzzle not solved first try
  becomes a review card, one per puzzle, but a position from the student's games never becomes a
  review card: a puzzle whose id starts with `own:` makes none in any mode, a single puzzle the coach
  serves included, and still writes its `puzzle_attempts` row. Such a position holds no tactic to
  find, and the ones From my games lists are trained by its drill, on a schedule of their own;
  migration 034 deleted the cards the old openings drill had made of these puzzles, with their
  reviews. A card born from a puzzle
  (`srs_cards.puzzle_id`) is reviewed through the puzzle's whole stored solution, when the puzzle is
  still stored, has an odd number of plies from 3 up and starts from the card's position and first
  move; any other card is graded on its own `expected_uci` alone. It stays an item of kind `card` and
  steps through `puzzles/attempt.ts` as a puzzle does: the server plays each reply, a wrong try keeps
  its step and is listed in `wrong_tries` with its ply, any checkmate ends the last step, and
  `show_solution` keeps the position of the step it stopped at, with `solution_line` holding the moves
  left from there. It is rated once, at the end; it writes no `puzzle_attempts` row, moves no puzzle
  rating and creates no card. The desk is told whether every step was right first time, so
  `srs_reviews.correct` is 1 only then and `answered_uci` is the first try of the first step; the
  suggested grade (`suggested_grade`) is 3, Good, when every step was right first time without a hint,
  and 1, Again, after a wrong try or a hint at any step or once the solution was shown. Its
  `srs_answer` notification is amended to describe the step the student missed (the one
  the solution was shown at, else the first wrong try's), with that step's position, the move tried
  and the move expected, and it lists every try. Every try is kept in
  `training_tries`, and puzzle accuracy is first-try solves
  (`puzzle_attempts.first_try`). The coach hears once per item, when it ends, except a puzzle solved first try without a hint: that writes no notification, the state carries `coach_comment: "offered"`, and `ask_coach_about_item {activity_id}` (refused with `stale_activity`, `not_in_training` or `already_requested`) writes it with the position and the solution. A `hint` marks the
  origin square of the expected move, clears on the next try, and makes the solve count as missed.
  The web sends the student's hand drawings as `drawings {activity_id, shapes}` 500 ms after the
  last change, only on Practice while a training item is on the board; the item's notification
  prints "Hint used: yes (+Ns)" or "Hint used: no" and, when drawings exist, a "Drawn" section
  listing each snapshot with its shapes.
  Explore is a client mode that routes drops to `explore` instead of grading; Back to puzzle clears
  the line and restores graded drops. The activity carries the item's line so far (`moves`), the
  wrong tries beside their ply (`wrong_tries`) and one outcome per queue position
  (`queue_outcomes`, kept in `training_runs.outcomes_json`).
- **Puzzle rating:** the student's puzzle rating is plain Elo (K 32, start 1200) against the
  library's `difficulty_rating`; a first-try solve wins, anything else loses, an unrated puzzle
  (opening drills) moves nothing. It lives in `settings.puzzle_rating`, is replayed once from
  the stored attempts at boot when absent (`puzzles.rating` log event), and the activity carries it
  as `student_rating` with `rating_change` once a rated puzzle ends; the item carries `rating`.
  `GET /api/progress` carries the number as `puzzle_rating`. A
  puzzles queue (`start_training {mode: "puzzles", motif}`) accepts any fixed choice
  (`isFixedPracticeMotif`), any stored `puzzles.motif`, or any `puzzle_themes.theme` with stored
  rows, and refuses any other with `empty_queue`; rated library puzzles of `fork`, `pin`, `skewer`,
  `back_rank_mate` (`backRankMate`), `checkmate` (`mate`), `endgame` and `promotion` are indexed
  in `puzzle_themes` on seed. A
  puzzles queue is sampled by index seek (`listPuzzles` with `ratingAround`, never a count) from
  puzzles within 200 points of that number, widening by 200 per side until full and repeating a
  puzzle only when its window has too few new ones, skipping popularity under 50, and a motif with
  no `puzzle_themes` rows keeps the plain listing. An unthemed queue (no `motif`) draws each batch
  of 10 in two parts: 3 puzzles from the themes the app lists as the student's improvement areas,
  and 7 from the unthemed sample, which skips all opening material. The areas are those of the
  last 30 days (`computeThemeStats`), read again for every batch so that a theme that enters or
  leaves the list is followed, and `opening` is never one of them. The 3 places go to the listed
  themes in turn, from one picked with `shuffleRandom`, each by a themed draw around the rating,
  so a boosted puzzle may be opening material. A puzzle already in the run is not added twice, a
  theme that yields no puzzle gives its place to the unthemed sample so that the batch keeps its
  length, and the batch is shuffled before it joins the run. With no improvement area the batch is
  the unthemed sample alone. The run keeps `training_runs.motif` NULL and `run_motif` null, and a
  queue with a motif has no boost. The reserved motif `mix-practice` (`MIX_PRACTICE_MOTIF`)
  starts a queue drawn equally from the improvement areas of the last 30 days, completed to
  three themes from the fourteen motif themes with the fewest attempts, list order on ties.
  Each batch of 10 is split as evenly as it goes, the extra to the weakest first, each share a
  themed draw around the rating, shuffled, with shortfalls passed to the other themes in order;
  the run stores `mix-practice` as its motif and `run_motif`. The plain
  listing, used by the coach's puzzle tool and `GET /api/puzzles`, and the motif counts cover only the
  library, never `lichess-db` rows, since they read every matching row. Elo stays over Glicko-2 on
  purpose: against puzzles whose rating does not move and whose deviation is low, simulated runs
  settled on the same level with the same noise, Glicko-2 only arriving 10 to 30 puzzles sooner. A
  puzzle's own rating never moves, since one student's attempts say nothing about a number built
  from many players.
- **Puzzle themes:** `GET /api/puzzles/themes/stats?days=7|30|90|all` (30 when absent, anything else
  400 `bad_query`) answers the rated puzzle attempts of the window (`ThemeStatsResponseSchema`,
  `progress/theme-stats.ts`), computed at request time with nothing stored: `overall` (`played`,
  `first_try`, `rating_avg`, `performance`, the last two null when nothing was played),
  `overall_previous` (the same over the window of the same length that ends where the asked one
  starts, null for `all`), one `themes` entry per theme played, most played first, with those
  figures and `ranked`, `improvement_areas`, `strengths`, and `unranked`, the number of themes
  played with fewer than 8 attempts. An attempt counts once overall and once under each theme of its puzzle: the keys of
  `puzzles.themes`, or for a puzzle without them its motif through `THEME_OF_MOTIF`; the origin themes
  `master`, `masterVsMaster` and `superGM` are left out everywhere, and an unrated puzzle counts
  nowhere. Performance is the Lichess puzzle dashboard's: the average `difficulty_rating`, minus 500,
  plus 1000 times the share solved first try, rounded. A theme is ranked with 8 or more attempts in
  the window, unless it is a length or goal theme (`oneMove`, `short`, `long`, `veryLong`,
  `equality`, `advantage`, `crushing`), which keeps its figures for the theme grid. The improvement
  areas are the ranked themes below the overall performance with at least one attempt not solved
  first try, weakest first; the strengths are those above it with at least one first-try solve,
  strongest first; both lists break a tie by more attempts and hold at most 8 theme keys. A theme is
  compared with the overall performance of the same window, never with the Elo puzzle rating, which
  is on another scale.
- **Puzzles by opening:** an imported Lichess puzzle keeps the opening of its game in
  `puzzles.opening_tags`, tags separated by spaces from the family to the variation
  (`Italian_Game Italian_Game_Classical_Variation`), and is filed under each of them in
  `puzzle_openings (opening, rating, puzzle_id)`, a table without row ids keyed by all three as
  `puzzle_themes` is. Migration 030 filled it with one row per tag of every stored puzzle with a
  rating, about 2.46 million rows over the owner's 6.2 million puzzles and the slow part of the
  start that applied it, and the import writes the same rows for each puzzle it adds and none for
  one it skips. `start_training {mode: "puzzles", opening: <tag>}` serves the puzzles of one tag
  around the student's rating by the rule a theme follows, ten at a time with no end and nothing
  boosted, and the run keeps `motif` NULL and `run_motif` null. The tag is 1 to 120 letters,
  digits, underscores and hyphens; a start that also names a `motif` is refused with
  `invalid_command`, and a tag no puzzle carries with `empty_queue`, before any run is written or
  replaced. `openingTagOf` (shared) turns an opening name as the app writes it into its tag, as
  Lichess does: accents folded, spaces turned into underscores and every other character that is not
  a letter, a digit or a hyphen dropped, so "Queen's Gambit Declined" is `Queens_Gambit_Declined` and
  "St. George Defense" is `St_George_Defense`. Lichess also files many puzzles of a family under
  `<Family>_Other_variations`, which no name maps to, and Petrov's Defense under both
  `Petrovs_Defense` and the older `Russian_Game`, of which only the first is served.
  `GET /api/puzzles/openings?names=<name>,<name>` (`OpeningPuzzlesResponseSchema`) takes 1 to 40
  names of at most 120 characters, separated by a comma with no space after it, since a comma
  inside a name is always followed by one, and answers `entries`, one per name in the order asked:
  `name`, `tag`, `puzzles` (the rows of the tag, 0 when there are none), and `played_30d` and
  `first_try_30d`, the attempts of the 30 days before the request on the tag's puzzles and the
  first-try solves among them (`tallyOpeningTag`). Anything else answers 400 `bad_query` and reads
  nothing. A name reaches SQL only as its tag, and a tag only as a bound parameter.
- **Overview themes:** the Puzzles by weakness card and the Puzzle themes section of the Overview
  (`components/PracticeWeakness.tsx`, `components/PracticeThemes.tsx`) draw the one 30-day
  `GET /api/puzzles/themes/stats` answer that the hub already reads for the Solved first try tile, so
  a Try again in the card reads it again for all three. The card lists the first 5 `improvement_areas`
  with name, `performance`, a bar and the first-try share, the first row selected until another is
  pressed; Train and the selected theme's name in lower case sends `start_training {mode: "puzzles",
  motif: <theme key>}` and Mix practice sends `motif: "mix-practice"`. With no improvement area the
  card says why in the Improvement areas page's sentences and offers Start a healthy mix and no Mix
  practice; a read that failed says `Your theme statistics could not be loaded.` with Try again in the
  card. The section draws the Healthy mix card, which sends `start_training {mode: "puzzles"}` with no
  motif and shows `overall.first_try` over `overall.played` (no figure when nothing was played), then
  one tile for each of the 54 themes of the table, in its six groups and order, each sending
  `start_training {mode: "puzzles", motif: <key>}`. A tile shows its first-try share in the colour of
  its band (green from 70, amber from 55, red under it), `new` when the answer does not list the
  theme, and no figure while the answer is loading or failed. The note counts the themes of the table
  the answer lists out of 54, so a theme outside the table, as `mate`, adds nothing. None of the
  starts has a size. The web no longer reads `GET /api/puzzles/motifs`, which stays on the server, and
  `Practice` takes no `fetchMotifs`.
- **Practice hub:** with no item on the board, Practice is a frame: a navigation of eight entries in
  two groups (Train: Overview, Puzzle themes, From my games, Openings; Stats: Dashboard, Improvement
  areas, Strengths, Openings played) beside a column that shows one page at a time
  (`components/PracticeHub.tsx`, `state/practice-page.ts`). Seven pages are built: the Overview (the
  day streak, puzzle rating and cards remembered from `GET /api/progress` as three tiles, the Due
  cards card with the Puzzles by weakness card beside it, and a Puzzle themes section, see Overview
  themes), which Puzzle themes shows scrolled to that section, Openings (below), the Dashboard (the
  puzzle tiles, the rating chart, the Improvement areas and Strengths cards and a card of the four
  most played openings), Improvement areas and Strengths, From my games and Openings played (each
  with its own bullet below). The Overview also holds a panel of the positions from the student's
  games in the row of cards. The Openings entry shows the repertoire moves due now, the sum of
  `sides[].moves.due` in the `GET /api/repertoires` answer the Openings page last read, and the From
  my games entry the positions due in the whole list (`counts.due`), each with no number at 0. Every
  page stays mounted while another is shown, and a refused start
  shows on the page it was pressed on. The entry chosen is stored in the browser under
  `chess-coach.practice-page`, so the hub comes back to it after a session and after a reload.
- **Practice runs:** a queue started from the Practice hub is kept in `training_runs`, written with
  each step, and a run is never paused: it ends when it stops being on the board, and its row stays as
  the record, with the reason it ended. `finished` is a queue whose last item is done, `ended` is
  `end_training`, `replaced` is a new start that finds it on the board, and `left` is a game opened or
  started over it, an item the coach serves over a demo shown on it, or a server start that finds it
  still open, which ends every such run before it serves a client. A coach demo over an item that has
  ended does not end the run, and leaving the demo shows the item again. The first reason written
  stays, so a row already ended is never rewritten, and a step that completes after its run ended,
  such as a line drill's try waiting on the engine, leaves the row as it was. What was answered stays
  rated and the rest stays due. There is no `resume_training` or `discard_training`, and neither the
  bootstrap nor the activity event carries a run that is not on the board; `discarded` is only in
  rows written before they were removed and in the runs a unit's delete ends (Deleting a unit). A
  single item the coach serves is not persisted.
  A puzzle queue drawn around the student's rating, of no motif or of a theme the sampler finds, has
  no size and no end of its own. `start_training` takes no `size`: its schema is strict, so a frame
  that still carries one is refused with `invalid_command`. The run starts with a batch of 10
  (`PUZZLE_BATCH_SIZE`), and `next` on the last item draws 10 more the same way, around the rating
  the student has by then, appends them to `training_runs.items_json` (and counts them in `size`)
  and serves the first. None of them is a puzzle the run holds: `drawRatedBatch` asks the sampler
  for the batch plus as many puzzles as the run holds, up to its 50 per call, and drops those the
  run has, so past 40 items a refill can come back short. A refill that finds no puzzle finishes the
  run with its summary, as the last item of any queue does; the student otherwise stops it with End.
  The items of such a run carry `position_in_queue` and no `queue_length`, `queue_outcomes` holds the
  items served so far, and the web heads an item `Puzzle N` with no total, draws one progress
  segment per item served, and never offers Finish training. Every other queue keeps a length and
  ends on its last item: the due cards (20, and one more for each card the run holds, below), the
  opening drills, the Italian drill and a motif that no theme row names (`opening_trap`), which hold
  10 positions at most, and a single item the coach serves.
  A card of a Due cards training that is rated and whose next step falls no more than 20 minutes after
  the rating (`LEARN_AHEAD_MS`, Anki's learn-ahead limit) is held by the run: it joins the queue at
  once, so the item's `queue_length`, `queue_outcomes` and `training_runs.size` grow by one, and the
  stored `items_json` follows the order the items are served in. When the student moves on, a held card
  whose time has come is served before the next queued card, and when no queued card is left the held
  card due first is served even if its time has not come, so the run finishes only when nothing is
  queued and nothing is held. A card served again gets a fresh exposure, the desk's token for one
  answer and one rating, and follows the same rule when rated, so a new card answered Again comes back
  after a minute, then after ten, and leaves the run when its next step is days away. A held card the
  training never reached, because it was ended, left or restarted over, stays due and the next Due
  cards training picks it up by its `next_review_at`. A single card the coach serves has no run to hold
  it in, and the line drill keeps its own retry passes while the From my games drill has none, so
  neither gains the rule.
- **Repertoire drill:** `start_training {mode: "repertoire", repertoire_id, scope}` runs a stored
  variation as passes from move 1 (`activity/repertoire-session.ts`): the server plays Black and every
  White move not asked, and stops on the moves still to find. `recommended` takes at most 10 due moves,
  the highest reach first, `due` every due move and `all` every move; a move with no card is new and
  due. A new move is first shown with its answer and rated on a later pass; otherwise only the first
  attempt rates it (FSRS in `repertoire_cards`, one card per position and move across variations: Good
  for a right first attempt and Again for a miss, which a wrong try, a hint or a shown solution all
  are), and a miss comes back on a later pass until it is right first time. In `all`, a move not due
  keeps its schedule when right. A new move is held back while a sibling's card has an `interval_hours`
  under 72 (`REPERTOIRE_SIBLING_STABLE_HOURS`), which a move answered Good each time crosses at its
  third review, after 10 minutes and 2 days, with 11 days. A wrong try within 50 cp of the engine's best that reaches another named opening
  carries that name. After each asked move is answered, the drill carries its stored idea in `answered`
  and the Practice column shows it as Why with the move number. `GET /api/repertoires` lists each variation with what each scope would serve.
  A `level` on the command widens the drill from that repertoire to every variation of its group
  (`group`) or every unit of its side (`side`, the Openings page's "Train all" button of a colour); without one it is the
  variation. The level's moves are merged so that a move two variations share, one card, is served
  once, under the variation where its reach is higher and the older one at a tie; a position that
  expects different moves in two variations asks the one whose line the pass plays. The item's
  `repertoire_id` and `variation_name`, and the drill's `repertoire_id`, name the variation of the
  move in play, and the drill carries the `level`. `GET /api/repertoires` counts the
  levels from the same merge in `groups` and `sides`; the Openings page draws a button for each.
- **From my games drill:** `start_training {mode: "found", scope, color?, phase?, position?, opening?}` serves
  the listed rows of `found_positions` (see Openings) as one-move exercises through their `own:`
  puzzles (`activity/found-drill.ts`, `TrainingRun`). The scope is required, and a command without
  one is refused as `invalid_command`: `recommended` takes the due cards, the oldest `next_review_at`
  first, then the new positions, the latest `first_found_at` first, at most 10 in all; `due` every
  due card and no new position; `all` every listed position, due, then new, then the rest by
  `next_review_at`. There is no daily cap on new positions. `color`, `phase`, `position` (an id the
  list gives) and `opening` (1 to 120 characters, a full name matching it exactly and a family
  matching every variation of it) narrow the queue as they narrow `GET /api/found-positions`, through the one read both
  use (`listListedFoundPositions`), and are stored nowhere; an empty queue, an id no listed position
  has included or an opening nothing carries, is refused with `empty_queue` before any run is written. A try is right when it is
  any move of the row's `accepted_uci`, and the attempt's copy of the solution becomes the move
  played, so it stays on the board; every other mode still compares with the one solution move. Each
  position keeps its schedule in `found_cards` (`db/found-cards.ts`, the columns of
  `repertoire_cards` keyed by `position_id`): a position with no card is new and due, and the first
  thing done on an item rates it once, Good for a right try and Again for a wrong try, a hint or a
  shown solution, the card being created by that first rating; a right try on a card not yet due
  keeps its schedule. A miss writes no `srs_cards` card, `puzzle_attempts` is written as for any
  puzzle, and the puzzle rating does not move, since these puzzles have no rating. The run's divider
  reads "From my games". `DELETE FROM found_cards` makes every position new again.
- **Found notes:** a listed position can hold a note, `found_positions.note` (nullable), a sentence or two on why
  its best accepted move is played there. `POST /api/openings/generate {sources: ["found-notes"]}`
  (`openings/found-notes.ts`) writes one for every listed position whose `note` is null, the newest
  `first_found_at` first, so a run cut short has covered what the drill serves first. It is the
  `repertoire-ideas` batch applied to these positions and shares its pieces: the `IdeaSession`
  interface, `sdkIdeaSession` (the coach's model, no tools, one turn, `strictMcpConfig: true`, no stored
  session, 180 s a note, with its own system prompt passed in), the 200 character limit and two
  attempts a position. It never runs after an import and is refused 409 `already_running` while it or
  the ideas run runs, the two sharing one guard; a missing generator answers 404
  `found_notes_unavailable`. It logs `openings.generate` with `considered`, `generated`, `rejected`
  and `empty`, and each refused text as `openings.found_note_rejected`. A stored note is never
  rewritten, so `UPDATE found_positions SET note = NULL` is how a note is written again, and a
  position whose two texts were refused stays empty for the next run. The prompt of a position
  gives its FEN, the side to move, the phase, the moves of the shown game that led to it (`game_id`
  and `ply`, nothing after the position), the best accepted move numbered as the game would write it,
  the engine's evaluation with best play read from that game's grading (`eval_before_cp`, left out
  when the game has none or is gone) and, only for a position found from a mistake, the move the student
  played there in that game with its classification; a repeat's prompt does not carry it. The check
  (`foundNoteRejection`) refuses an empty text, one over 200 characters, one that names the written
  form of any accepted move (SAN, with or without its check sign, castling with zeros too) and one
  that names the destination square of any accepted move; the refusal is told to the second attempt.
  The check cannot prove the chess right. A drill of mode `found` carries `note` in its state once an
  item ended solved or with the solution shown: `{san, text}` with the stored note and the best
  accepted move's SAN, since an item solved with another accepted move has no `expected` move to
  name it by, or null when the position has none. It is null while the item is open, a hint included, and
  the field is absent in every other mode, whose puzzles may share the id. The Practice column draws it
  in the item's card under the verdict, as "Why <SAN>" and the text, and draws nothing when it is null
  or before the end.
- **From my games list:** `GET /api/found-positions` (optional `color`, `phase` and `opening`) answers
  `{positions, counts}` (`http/found-positions.ts`, schemas in shared `found-positions.ts`). `opening` takes a full name or a family, as the drill does. A listed
  position carries `id`, `fen`, `color`, `phase`, `section` (`reached` when `from_repeat`, else
  `mistakes`), `from_mistake`, `from_departure`, `opening_name`, `line` (`{first_ply, san}`: the shown
  game's moves from move 1 up to the position, or its last four plies past ply 8), `reached_games`,
  `best_games`, `last_reached_at`, `game` (`id`, `ply`, `opponent`, and `played_at`, the game's own
  date else when it ended, both null once the game is gone), `state` (`new`, `due` or `scheduled`)
  and `next_review_at`, and never the accepted moves or the solution. Section `reached` comes first,
  and inside a section the positions come in the order the `all` drill serves them. `counts` holds
  `total`, `due`, `new`, `recommended`, `all` (those three the lengths of the queues the scopes would
  build now) and `left_out` (the rows with `listed = 0`) under every filter, and `by_phase` and
  `by_section` under the colour and the opening. A colour, phase or opening outside the listed values answers 400
  `invalid_filter` and reads nothing.
- **From my games page:** the Train group's third page (`components/PracticeFound.tsx`, the read and
  the wording in `state/found-api.ts`) draws what that list answers. The hub reads the whole list
  once, for the navigation's number, the Overview's panel and the page; a colour or phase chosen on
  the page is read again from the server (`?color=`, `?phase=`) and the counts follow it, except the
  phase labels, which count from `by_phase`, which the phase chosen does not narrow. Its cards, each with a
  read-only board (`components/MiniBoard.tsx`: chessground with `viewOnly`), are drawn from the first
  time the page is shown. A position is a card in the section its `section` names, so one that
  belongs to both is shown once, in the first, with the Mistake chip. A mistake in the opening is
  titled by the opening and a mistake past it by `Move N · vs <opponent>`, the foot holding the date
  and the other of the two; a position reached more than once shows Reached N×, Found best X of Y
  (green from 70%, amber from 55%, red under, by the exact share) and Last date. The state reads due,
  new or, for a scheduled position, when `next_review_at` comes. Train N sends `start_training`
  with `mode: "found"` and `scope: "recommended"` plus the colour and phase chosen, its menu sends
  `due` and `all`, N at 0 reads Train all positions and sends `all`, and a card's Drill sends
  `scope: "all"` with its `position` and no filter. The Overview's panel reads D due, R recurring of
  N, the first three positions due, and Drill D positions sends `due` (Train all positions sends
  `all` when nothing is due). With no position at all the page and the panel say so, and a read that
  failed says so with Try again. A start in flight anywhere in the hub, a found one or not, disables
  every one of these buttons. A found start the server refuses is explained under the header of the
  page it was pressed on.
- **Openings played page:** the Stats group's last entry (`components/PracticeOpeningsPlayed.tsx`,
  the read and the wording in `state/openings-played-api.ts`) draws `GET /api/openings/played?days=`
  for one side at a time. It reads nothing until it is first shown, opens on As White and 30 days
  and reads again for a period chosen; both colours come in one answer, so the side control reads
  nothing. A side with no game says `No game as White in this period. Import games in Games to see
  your openings here.` (or Black) once, in place of both sections; a section with no opening says
  `No game in this period yet.` in place of its table; a row or a variation with no game is not
  drawn. Each section, Your openings and Played against, lists openings that are buttons opening
  their variations. The first of Your openings is open until the student chooses, and a choice
  survives a change of side or period. A row shows the name, the line, the games, a bar of the wins,
  draws and losses, the score, `round((wins + draws / 2) / games * 100)`, and `w / d / l`; the score
  takes the colour of its band by the rounded figure (green from 70, amber from 55, red under it),
  and a bar draws only the outcomes that happened. A variation shows a Drill when a stored position
  of that colour carries its `full_name`, read from the list the hub already reads for From my
  games, and it starts `start_training {mode: "found", scope: "all", color, opening: <full_name>}`.
  Its button reads Starting while that start is in flight, every start of the hub waits for it, and
  the Overview's panel and From my games do not say Starting for a start they did not make. Under
  900 px a row keeps its name, games and score and a variation keeps its Drill. The Dashboard's card
  lists the four openings with the most games across both colours and both lists in the Dashboard's
  own period, a tie keeping White's lists before Black's and a chosen line before one played
  against, each with its side, and See all opens the page.
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
- **Evaluation cache, on the server:** `packages/server/src/engine/eval-cache.ts` reads that file,
  read-only, from the path in `CHESS_COACH_EVAL_CACHE`; it stays a file of its own because the app's
  database would otherwise grow by tens of gigabytes. Unset, missing or unreadable, the boot logs one
  `eval_cache.unavailable` and every lookup misses, so the app works as it did without one. Only the
  engine's analysis lane looks a position up, for the strip's `analyse` and the coach's `analyze`;
  grading, the drill generators and the repertoire review never do, so a `cp_loss` stays comparable
  within a game at one depth, and `test/grading-wiring.test.ts` fails when a module besides the pool and
  the entry point imports the reader. The position is the first four fields of the FEN as chess.js writes
  them, an en passant square only where a capture is possible, as the file does. A request for N lines at
  depth D hits only on a stored set with at least N lines and a depth of at least D: the deepest such set
  answers with its first N lines at the depth it holds, so a row of one line never answers a request for
  three, and anything else is searched as before. The file scores every line from White's side, a mate as
  moves to mate with that sign; the reader gives the side-to-move score of a search (a mate as 10000), and
  `eval-cache.stockfish.real.test.ts` checks that sign against the engine under
  `CHESS_COACH_STOCKFISH=1`. Castling is stored as the king taking its rook (`e1h1`) and is replayed on the
  board into `e1g1`, while a rook on e1 playing to h1 stays a rook move; a line ends at the first move
  that does not replay. `eval_cache.hit` and `eval_cache.miss` log each lookup with `fen`, `lines`,
  `depth` and `duration_ms`, a hit adding `stored_depth` and `stored_lines` and a miss its `reason`
  (`not_stored` or `insufficient`); `eval_cache.failed` logs a lookup that threw, which answers as a miss.
- **Evaluation queue:** a position the cache could not answer for the analysis lane (the strip's
  `analyse` and the coach's `analyze`, never grading) is queued to be searched deeper in the background,
  so the next visit is answered from the cache. `eval_queue (key, fen, enqueued_at)` in the app's own
  database holds it (migration 032), so a restart keeps it: `key` is the cache's packed key and unique,
  so a position is queued once. The table is ordered by rowid: a position looked at again is moved to
  the front, the position looked at last is searched first, and a 5001st position drops the oldest
  (`EVAL_QUEUE_LIMIT`). Nothing is queued when the cache is unset, missing or unreadable, when the app
  cannot write to the file or the directory beside it (`eval_cache.unavailable` with `reason:
  not_writable`), or when the position's stored row is already as deep as the search goes (depth 30),
  since the cache never replaces a deeper row.
  `EvalQueueWorker` (`engine/eval-queue.ts`) searches one position at a time with 3 lines, to depth 30
  or 60 s, whichever comes first (`QUEUE_SEARCH`), on a Stockfish process of its own with 1 thread
  under `nice -n 19` (`QUEUE_NICENESS`), so it never takes a turn of the pool's engines. It starts no
  search while a game move (`GameService.isBusy`), a grading run (`ImportGrader.isRunning`) or a coach
  turn (`CoachSession.isTurnRunning`) is running, and looks again every 2 s; a search that has started is
  not interrupted. `EvalCacheWriter` (`engine/eval-cache.ts`) opens the file read-write only when the
  first search is about to start, switches it to WAL with `synchronous = NORMAL` (the file is built with
  no journal; the reader keeps its own read-only connection and sees every commit) and writes with
  `INSERT ... ON CONFLICT(key) DO UPDATE ... WHERE excluded.depth > evals.depth`, so a result no deeper
  than the stored row changes nothing. The result is a set labelled source 1, at the depth every line
  reached, with the search's `knodes`; scores go in from White's side, a mate as the 10000 centipawns the
  search maps it to, and castling as the king taking its rook. A set of the row with more lines than the
  result is carried over as the row's second set, the one with the most lines and then the deepest. A
  failed search is logged and its position dropped, with no retry, and the worker waits 30 s before the
  next one; a shutdown kills the search in flight and leaves its position queued. `eval_queue.added`
  logs a position newly queued (`fen`, `queued`, `dropped`), `eval_queue.done` a search finished
  (`outcome` is `stored`, `unchanged` or `empty`, the last for a position with no move to search, with
  `depth`, `lines`, `knodes`, `cut_by_time`, `duration_ms` and `waited_ms`) and `eval_queue.failed` a
  failure (`stage` is `add`, `search` or `loop`). Once the app has written to it the file is in WAL mode,
  with `-wal` and `-shm` beside it while the server runs. `DELETE FROM evals WHERE source = 1` removes
  the rows the app wrote; a row that replaced a Lichess one comes back only with a rebuild.
- **Engine on Practice:** `analyse {fen, lines 1-5, depth 8-24}` runs the evaluation engine's
  analysis lane on a position and answers that connection with an `analysis` event (lines with
  SAN and a centipawn score from White's side, a mate as 10000). The search stops at the depth or
  after 4 s, whichever first: the request carries `depth` and `capMs` and never `movetime`, which
  would spend the whole 4 s on every position. The event's `depth` is the depth the lines reached,
  and `cutByTime: true` says the cap stopped the search first; the strip takes such an answer for
  the answer to its request, since asking again meets the same cap. The event's `source` is `cache`
  when a stored evaluation answered (see Evaluation cache, on the server), at once and at its own
  depth, which is the asked one or deeper, and the strip takes that answer for the answer to its
  request too; `engine` says a search ran. A connection's older `analyse` answers nothing once a
  newer one was sent, since a cached answer can come back before the search for the older one ends.
  The coach's `analyze` reads the cache the same way, for 3 lines at depth 18, and its answer names
  the `depth` and `source`. It is refused with
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
  `coach.permission_resolved`, `training.item_served`, `training.answer`, `training.runs_left` (the runs a server start ended), `srs.rated`,
  `review.cards_created`, `import.*`, `connections.*`, `openings.generate`, `openings.generate_failed`, `openings.rebuild_copy_removed`, `import_lichess.progress`, `import_lichess.done`,
  `explorer.failed`, `eval_cache.hit`, `eval_cache.miss`, `eval_cache.unavailable`,
  `eval_cache.failed`, `eval_queue.added`, `eval_queue.done`, `eval_queue.failed`, `*.listener_failed`, and `client.*` for what
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
  change, never how the work was organised. The `pr-text` job refuses task ids
  (`chess-coach-` plus 3 to 8 lowercase letters or digits) in the PR title, body and
  commits (`bin/task-id-guard`); the scratch names `chess-coach-tools`,
  `chess-coach-probe-`, `chess-coach-ideas-`, `chess-coach-tests-<pid>-<random>` and
  `chess-coach-tmp` are allowlisted.
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
| A join from a small table to `puzzles` is written `CROSS JOIN` with the small table first (`puzzle_attempts a CROSS JOIN puzzles p ON p.id = a.puzzle_id`): the database has no `sqlite_stat1`, so with a plain `JOIN` the planner may walk all 6.2 million Lichess puzzles by an index and probe the small table once per puzzle, seconds for a handful of rows | tripwire | `progress/compute.test.ts`, `progress/theme-stats.test.ts` and `puzzles/rating.test.ts` assert the plan of their own query; a new query has no guard |
| The explorer does not refuse an unlisted `ratings` value: it maps each value to the group containing it (400 means 0-999), so a value that is not a listed boundary (0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500) quietly asks for another group | tripwire | none yet |
| A migration runs inside a transaction, where `PRAGMA foreign_keys = OFF` does nothing, so rebuilding `games` (create, copy, drop, rename) cascades into `moves`, clears `srs_cards.source_game_id` and trips `difficulty_changes.game_id`: to change a column of `games`, add the new one, copy it over, drop the old one and rename the new one, as `019_lichess_game_source.sql` does | tripwire | `migration-019.test.ts` holds it for that migration only |

**A hurdle promoted to a gate is deleted from this table, not duplicated.** The gate is the
instruction; a line here restating it only dilutes the ones still unguarded.
