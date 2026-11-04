# MVP plan

The smallest version of chess-coach that can be used daily without waiting for the next
feature: play a coached game in the browser, review it, and train on the mistakes and on
curated puzzles. Everything listed under "Out of scope" is deferred, not forgotten; it
re-enters as beads once the MVP is in use.

## 1. Goal and scope

**Goal.** One person opens a browser tab, plays a game against the engine while a coach
(a Claude Code session) watches every move, gets a post-game review with the mistakes
turned into spaced-repetition cards, and trains on those cards and on puzzles. All state
survives a server restart and a browser refresh.

**In scope.**

1. Chat with the coach: streaming text, visible tool calls, a transcript that survives a
   refresh and a restart, one coach session resumed across restarts.
2. Board: click a piece, see its legal destinations, click one to move. The server
   evaluates the move, plays the engine reply, and tells the coach about both.
3. Game persistence and review: a finished game can be reopened, stepped through locally,
   and its mistakes turned into SRS cards.
4. Training: due SRS cards and curated puzzles, both answered by playing on the board,
   both graded by the server, cards rescheduled with SM-2.

**Out of scope (deferred).** Progress screen and Elo tracking beyond a stored number,
PGN import from Chess.com, the weekly routine, opening recognition and study, puzzle
generation from the user's own games, automatic difficulty adjustment, a production build
served by the server (the MVP runs through `pnpm dev`), multi-user, hosted deployment,
API-key billing. The README and `AGENTS.md` are updated when this plan lands so they stop
promising the routine.

**Non-goals that shape the design.** No accounts. The layout is a desktop grid with the
board in a square container and the chat beside it; below 900px the chat stacks under the
board, and nothing narrower is tested. No design system beyond the tokens the design note
prescribes (`kernl note read "Design taste.md"`, read before the first screen is built).

## 2. Architecture

One Node process owns all state and talks to two clients: the browser and the coach.

```
browser (React)  <-- WebSocket + HTTP -->  server  <-- Agent SDK, in-process tools -->  coach
                                              |
                                        SQLite, Stockfish
```

**The server is the single writer.** The browser never computes a position; it renders
what the server sends. The coach never holds game state; it calls tools. Both receive the
same `ActivityState` snapshot after every change, so the two views cannot disagree.

**One activity at a time, four kinds.** The server holds exactly one current activity:
`live_game`, `review`, `training` or `demo`. Each has a board, an id and its own rules for
what mutates it and what is persisted:

- `live_game`: the game being played. Only `GameService` mutates it; every ply is
  persisted. Finished games are immutable.
- `review`: a finished game being stepped through. The browser steps locally; nothing is
  persisted except cards the student asks for.
- `training`: one SRS card or one puzzle being answered. The server grades.
- `demo`: a position the coach put on the board with `show_position` and may step with
  `make_move`. Never persisted. Leaving a demo returns to the activity underneath it.

Switching activity is a client command. A live game is never discarded by switching: it
stays the current game and `open_game` on it returns to `live_game`.

**The live game turn loop belongs to `GameService` alone.** The coach has no tool that
moves a piece in a live game. The loop:

1. `new_game(color: "black")` schedules the engine's first move before input is enabled.
2. The browser sends `move`. `GameService` validates it, applies it, persists the ply and
   broadcasts the new state at once, so the piece moves with no engine latency.
3. It then runs the evaluation of the player's move and the play engine's reply on the two
   engine processes, persists the evaluation and the reply ply, broadcasts again, and pushes
   one notification into the coach queue carrying the player's move, its evaluation (cp
   loss, classification, best move) and the engine's reply.
4. If several notifications queue up while a coach turn is still streaming, they are
   coalesced into one message before the next turn, so the coach comments on the current
   position plus any intervening mistakes (cp loss >= 81) instead of narrating stale ones.

Mutations of an activity are serialized through one promise chain per activity, so a
second tab, a tool call and an engine callback cannot interleave.

**The coach is a long-lived Agent SDK `query()` with streaming input.** The server holds
an async queue of user messages; the browser's chat input and the move notifications both
push into it. Messages stream back as typed events, which the server persists (finalized
messages and tool events, never text deltas) and forwards to the browser as `chat` events.
The session id is stored so a restart resumes the same conversation (`resume`). A turn
interrupted by a restart is marked incomplete in the transcript.

**Credentials and runtime directory.** The SDK runs the installed Claude Code binary with
the owner's login; no API key anywhere, and M1 fails its auth probe if an API-key variable
is present in the environment. The coach runs with `cwd` set to the data directory, not the
repository, and with setting sources disabled, so the project's own `CLAUDE.md`, skills and
settings never reach it. The SDK package version is pinned.

**M1 is an architecture gate.** If subscription login, streaming input, resume, in-process
tools or the permission callback do not work as the SDK documents, the plan stops there and
the architecture decision is revisited before M2. There is no nominal fallback topology.

## 3. Data model (SQLite)

Schema lives in `packages/server/src/db/migrations/NNN_*.sql`, applied in order at boot by
a small runner that records applied names in `schema_migrations`. `better-sqlite3`,
synchronous, WAL mode, `PRAGMA foreign_keys=ON`. Timestamps are UTC ISO-8601 text; the
clock is injected so tests can move it. One database file at `<data dir>/chess-coach.db`.

Paths are resolved from an explicit application root, never from `process.cwd()`: pnpm runs
the server package from `packages/server`, so a bare `data/` would land outside the
git-ignored `/data`. `CHESS_COACH_DATA_DIR` and `CHESS_COACH_CONTENT_DIR` override the
defaults, which are the repository's `data/` and `content/`.

```
coach_sessions   id, claude_session_id, started_at, ended_at, prompt_version
chat_messages    id, coach_session_id, seq, role (user|assistant|system), kind
                 (text|tool_use|tool_result|notification|incomplete), content_json,
                 created_at                       UNIQUE(coach_session_id, seq)
games            id, coach_session_id, started_at, finished_at, player_color, target_elo,
                 initial_fen, phase (player_turn|evaluating|engine_turn|finished),
                 result, termination (checkmate|stalemate|draw|resign|abort), pgn
moves            id, game_id, ply, san, uci, fen_before, fen_after, is_player,
                 eval_before_cp, eval_after_cp, cp_loss, classification, best_move_uci,
                 best_move_san                    UNIQUE(game_id, ply)
                 (evaluation columns nullable; null means not evaluated, never 0)
srs_cards        id, source_kind (game_move|teaching), source_game_id, source_move_id,
                 prompt_fen, student_color, played_uci, expected_uci, cp_loss,
                 classification, explanation (nullable), created_at, next_review_at,
                 interval_hours, ease_factor, repetitions
                 UNIQUE(source_move_id); source_move_id ON DELETE SET NULL
srs_reviews      id, card_id, reviewed_at, quality (0..5), answered_uci
puzzles          id (text, "<file_stem>:<index>"), source, motif, difficulty, fen,
                 solution_uci (json), solution_san (json), explanation
puzzle_attempts  id, puzzle_id, attempted_at, solved, answered_uci (json), failed_ply
settings         key, value             (current_elo, player_color default)
```

Rules the schema carries:

- Ordered `moves` rows are the authoritative history. `pgn` and the current FEN are derived
  and rewritten in the same transaction as the move. Restoring a game replays `moves` from
  `initial_fen`, which keeps repetition and fifty-move state correct.
- At most one game is unfinished at a time. On boot, an unfinished game in phase
  `evaluating` or `engine_turn` has that step rerun; the step is idempotent because the
  evaluation, the reply and the coach notification row (`chat_messages`, kind
  `notification`) are written in one transaction keyed by ply, and the coach queue is fed
  from notification rows not yet marked delivered, so a restart never sends one twice.
- `undo` is allowed only in `player_turn`; it deletes the last engine ply and the last
  player ply in one transaction. A card created from the undone move keeps existing with
  `source_move_id` set to null.
- Card creation from a game inserts with `ON CONFLICT(source_move_id) DO NOTHING`, so the
  coach and the Review button cannot duplicate cards.
- `puzzles` is upserted at boot from `content/puzzles/*.json` in sorted filename order; the
  id is the file stem plus the index, so re-running the seed after editing a file keeps
  `puzzle_attempts` valid. The JSON `solution_moves` array (UCI) is stored as
  `solution_uci`; `solution_san` is copied. Every FEN and every solution line is validated
  with chess.js before the seed transaction commits; a bad entry fails the boot with its
  file and index named.
- Reads that list rows (`games`, cards, puzzles, due cards) take a limit with a small
  default and a hard maximum; coach tools return bounded summaries.

## 4. Server modules

`packages/server/src/`, one directory per responsibility. Owned interfaces exist only where
there is external I/O to fake: the engine process, the Agent SDK, the clock, and content
loading. Pure modules (SM-2, grading, state snapshots) are concrete and tested directly;
repositories are tested against a temporary SQLite file.

- `db/`: open the database, run migrations, typed query helpers per table.
- `engine/`: `UciEngine` wraps one Stockfish child process (spawned without a shell:
  `uci`, `isready`, `position`, `go`, parse `info`/`bestmove`). One search at a time per
  process, a FIFO of pending searches, timeouts on startup, readiness and each search; on
  process exit the pending search is rejected with a typed fault and the process is
  restarted once. Every result is tagged with the position it searched, and every
  `bestmove` is validated with chess.js against that position before use (`(none)` is
  accepted only on a terminal position). `EnginePool` holds two: one at full strength for
  evaluation and `analyze`, one for play. A live-turn evaluation has priority over a
  discretionary `analyze`; at most one `analyze` is queued, a newer one replaces it.
  - Play strength: at Elo >= 1320, `UCI_LimitStrength=true`, `UCI_Elo=<elo>`,
    `go movetime 1000`. Below 1320 (Stockfish's floor), `UCI_LimitStrength=false`,
    `depth = max(1, min(5, floor(elo / 250)))`, and with probability
    `max(0, 0.85 - (elo / 1320) * 0.85)` a random legal move is played instead. This is the
    chess_rocket formula (`scripts/engine.py:157-168`).
  - Evaluation of a player move: `go depth 16`, `MultiPV 1`, once on the position before
    the move and once after. Scores are normalized to the student's colour: UCI reports
    from the side to move, so the post-move score is negated; `score mate N` maps to
    `sign(N) * 10000`. `cp_loss = max(0, before - after)`. Classification: 0 best, 1-30
    great, 31-80 good, 81-150 inaccuracy, 151-300 mistake, above 300 blunder. The first PV
    move of the pre-move search is stored as the best move. `analyze` runs `go depth 18`,
    `MultiPV 3`.
- `game/`: `GameService` owns the live game: the chess.js instance, the turn loop above,
  persistence of each ply, `resign` and `abort`, and the `live_game` snapshot. Finished
  games are read through `GameRepository`; nothing writes to them.
- `activity/`: holds the current activity, the demo board, the review cursor and the
  training item, and produces the `ActivityState` snapshot the hub broadcasts.
- `srs/`: SM-2, pure functions over a card and a quality:
  - ladder in hours: 4, 24, 72, 168, 336, 720; ease starts at 2.5, floor 1.3;
  - `quality < 3`: repetitions reset to 0, next interval 4h;
  - `quality >= 3`: repetitions + 1; interval is the ladder entry for the new repetition
    count while one exists, otherwise `previous * ease`;
  - ease update is the SM-2 formula `ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)`;
  - a new card is due at creation time (interval 0), so it shows up in the next training
    session rather than four hours later;
  - a table of worked examples sits next to the function and is the unit test.
  `createCardsFromGame(gameId)` adds one card per player move with `cp_loss >= 81`,
  explanation null; the coach fills explanations through `explain_card` when it walks
  through the game.
- `puzzles/`: seed, list by motif, and the attempt state machine: the training item tracks
  the solution index; each student ply is compared in UCI against `solution_uci[i]`; on a
  match with plies remaining, the server plays `solution_uci[i + 1]` and advances; the
  first wrong ply ends the attempt as failed with `failed_ply`; matching the last ply ends
  it as solved. Promotion is part of the UCI string, never defaulted.
- `coach/`: `CoachSession` wraps the SDK `query()`: starts or resumes, exposes
  `send(text)`, streams events to a listener, stores the session id and persists the
  transcript. `tools.ts` defines the in-process MCP tools (section 5). `prompt.ts` loads
  `content/prompts/coach.md` and the per-level references into the system prompt append
  and records a `prompt_version` (the content hash) on the session; a session whose
  prompt version differs from the current bundle is not resumed, a new one is started.
- `ws/`: one WebSocket per browser tab at `/api/ws` (inside the Vite `/api` proxy). On
  connect the hub sends one bootstrap (`ActivityState` plus the transcript tail); the
  browser reconnects with bounded backoff and discards unsent local input after a resync.
  `Host` and `Origin` are checked on upgrade: the app's own origin in production, the
  configured Vite origin in development. One socket per tab; every tab may act (the owner
  is the only user).
- `http/`: Fastify routes under `/api/`: `GET /api/health` (kept as is, extended with a
  readiness flag), `GET /api/games`, `GET /api/games/:id` with its moves,
  `GET /api/cards`, `GET /api/puzzles`. Every payload crossing the boundary is validated
  with the zod schemas from `shared`.
- Startup order: database and migrations, content load, puzzle seed, engines, coach
  session, routes, listen. `SIGINT`/`SIGTERM` stop accepting commands, cancel searches,
  close the SDK session, engines and database, with a bounded timeout.

## 5. Coach tools

Defined with the SDK's `tool()` and `createSdkMcpServer()`, zod schemas, all in-process.
Every tool returns a compact JSON result; the full `ActivityState` goes to the browser, not
to the coach. Every input from the model (FEN, moves, ids, limits) is validated before it
touches state.

| tool | purpose |
|---|---|
| `get_game` | the live or reviewed game: fen, moves with evaluations, whose turn, result |
| `show_position(fen)` | start a `demo` activity with this position on the student's board |
| `make_move(san)` | play a move on the demo board; rejected outside a demo |
| `analyze(fen?)` | top 3 lines at depth 18 for the demo, live or given position |
| `new_game(color, elo)` | start a game; rejected while a game is unfinished |
| `resign_game` | resign the live game; triggers the post-game flow |
| `create_srs_cards(game_id)` | batch cards from a finished game's mistakes (idempotent) |
| `add_srs_card(fen, played_uci, best_uci, explanation)` | one card from a teaching moment; cp loss and classification are computed by the server |
| `explain_card(card_id, explanation)` | fill the explanation of a card the batch created |
| `get_due_cards(limit)` | due cards with their positions |
| `get_puzzles(motif?, limit)` | pick puzzles for a drill |
| `get_progress` | current elo setting and counts, enough for the session opener |
| `read_reference(name)` | one of the seven reference files, by a closed enum; no paths |

What is deliberately not a tool: moving in a live game, asking for an engine move, undoing,
grading a card, recording a puzzle outcome. The server owns those; the coach learns the
result from the notification the server sends after each one.

The built-in Claude Code tools are disabled (`tools: []`, or `disallowedTools` if the
installed SDK version lacks that option; M1 verifies which), so only the chess MCP server's
tools are advertised to the model, by their fully qualified names. `canUseTool` still
exists as a backstop: any request it sees is forwarded to the browser as a
`permission_request` and expires if unanswered. Bypass mode is not used. M1 proves both
halves: a chess tool runs, and a shell or file request never reaches the model's tool list.

## 6. Events (packages/shared)

`shared/src/events.ts`, re-exported from the package index, is the contract between server
and web. Every event has a zod schema beside its type; both sides validate.

Server to client:

- `bootstrap {activity, transcript}` once per connection.
- `activity {state: ActivityState}` after every change.
- `chat` events, each carrying `message_id` and `seq`: `text_delta`, `tool_use
  {tool_use_id, name, input}`, `tool_result {tool_use_id, output}`, `turn_end`,
  `turn_error`.
- `permission_request {request_id, tool_name, input}`.
- `training {item, status: "prompt" | "in_progress" | "solved" | "failed", ...}`.
- `cards_created {game_id, count}`.
- `error {code, message, command_id?}`.

Client to server (every command carries a `command_id` echoed in errors):

- `move {from, to, promotion?}` in a live game or training; `undo`.
- `say {text}` (bounded length).
- `new_game {color, elo}`, `resign`, `abort`.
- `open_game {game_id}` (enters `review`, or `live_game` for the unfinished one),
  `select_review_ply {game_id, ply}`, `ask_coach_about_ply {game_id, ply}`,
  `create_cards {game_id}`.
- `start_training {mode: "srs" | "puzzles", motif?}`, `rate_card {exposure_id, quality}`,
  `next_training_item`, `end_training`.
- `approve_tool {request_id, allow}`.

`ActivityState` is a discriminated union on `kind`. Every variant carries `activity_id`,
`orientation`, `fen`, `turn`, `last_move`, `legal_moves` as `{from, to, promotions?}`
entries (the web derives chessground destinations and shows a promotion chooser when
`promotions` is present), `input_enabled` and `pending` (what the server is doing: nothing,
evaluating, engine thinking). `live_game` adds the move list with evaluations, material,
result and phase; `review` adds the game and the selected ply; `training` adds the item
and the exposure id; `demo` adds the activity it will return to.

## 7. Content carried over from chess_rocket

Upstream is pinned: `suvojit-0x55aa/chess_rocket` at `09bd51d`, GPL v3, named in
`content/NOTICE` with the list of files copied and whether each is verbatim or adapted.
`bin/ci` runs `bin/slop-guard` over every tracked file, and four reference files, the
prompt and one Python script carry em-dashes, so "verbatim" is not available for prose:
each em-dash is replaced by a comma, colon or full stop by hand, and the adaptation is
noted in the NOTICE.

- `content/prompts/coach.md`: the chess_rocket `CLAUDE.md`, adapted. Every tool name and
  signature matches section 5; instructions for removed mechanics are deleted (reading
  files, the dashboard, `routine.md`, opening study, `evaluate_move` after each move, the
  ASCII board, `set_difficulty`, `save_session`, puzzle generation); the Play loop says the
  server evaluates every move and plays the reply and that the coach receives both in one
  message; `show_position` is the way to put a position in front of the student. The
  three-perspective tutor, the Play / Analyze / Teach / Replay / Plan loop, the thresholds,
  the language levels and the session opener stay. A test asserts that every tool name the
  prompt mentions exists in the milestone's tool set.
- `content/references/*.md`: the seven reference files. The prompt loader appends
  `curriculum.md`, `elo-milestones.md` and `chess-pedagogy.md` at session start; the other
  four are reachable through `read_reference`.
- `content/puzzles/*.json`: the nine puzzle files, verbatim (JSON carries no prose gate
  issue). They hold 238 puzzles today, 79 of them multi-move; `from-games.json` is empty and
  stays so until puzzle generation from games is built.
- `tools/`: `generate_puzzles.py`, `import_lichess_puzzles.py`, `motif_detector.py` and
  `validate_puzzles.py` as offline scripts with their own `pyproject.toml`, paths pointed at
  `content/puzzles/`, imports made relative, em-dashes removed. Excluded from Biome, still
  scanned by gitleaks and slop-guard. Not part of the runtime. Running them is documented
  in `tools/README.md`; they are not exercised by `bin/ci`.

## 8. Web

Three screens, one layout: board on the left in a square container, chat on the right, a
top bar switching Play / Review / Train. The chat is the same component on every screen.

- **Play**: board (chessground, click-to-move, destination dots from `legal_moves`,
  promotion chooser), move list with classification badges and the textual class, eval bar,
  controls (new game, resign, undo), a "back to game" control while a demo is shown.
- **Review**: list of finished games; opening one loads it from `GET /api/games/:id` and
  steps through it locally (arrow keys, clicks on the move list; shortcuts ignore focused
  inputs). Cp loss per move, "create cards", and "ask the coach about this move", which
  sends `ask_coach_about_ply`; the server builds the coach message from stored position and
  evaluation data, so navigation never appears as user chat.
- **Train**: `start_training` with a mode. SRS mode serves due cards in `next_review_at`
  order; puzzle mode serves a queue of puzzles for the chosen motif, materialized at start
  (ten by default, fewer if the inventory is short, with the count shown). The position
  appears on the board, the student answers by moving, the server grades and tells the
  coach, the coach comments; in SRS mode the student then rates 0..5 (one rating per
  exposure, later ones rejected), in puzzle mode "next" advances.

The board is a component that creates one chessground instance per mounted element,
updates it through its API on prop changes, and destroys it on cleanup; Strict Mode's
double mount is a test case. Drag and premove are disabled explicitly. Board CSS, piece
set and theme are named in the component's header with their source and licence.

State: a single `useServer()` hook holding the WebSocket, the latest `ActivityState`, the
transcript and the training item. No global state library until a second consumer of the
same state exists.

Visual direction: read the design note (`kernl note read "Design taste.md"`) before the
first screen; tokens as CSS custom properties in `packages/web/src/styles/tokens.css`,
created in M1 with the chat; chessground's base CSS plus one theme file.

## 9. Milestones

Each milestone ends usable end to end and ends with its own failure states handled.
Nothing in a milestone depends on a later one. The tool subset enabled per milestone is
listed; a tool whose backing service does not exist yet is not registered.

**M1. Chat with the coach.** SQLite, migrations, `coach_sessions`, `chat_messages`;
`CoachSession` with the owner's login, `cwd` in the data directory, setting sources off,
built-in tools off, transcript persisted; the chat screen with streaming text and tool
cards; tokens.css; `content/prompts` and `content/references` imported and sanitized.
Tools: `get_progress`, `read_reference`.
Failure states: not logged in, SDK process exit, API key present.
Acceptance: type a message, see the reply stream; refresh the tab, the transcript is there;
restart the server, continue the conversation; `pnpm test` covers migrations, the event
mapping with a fake SDK stream and the prompt-tool-name check. The SDK probe (opt-in) runs
with stdin closed and no TTY and verifies auth source, session id capture, resume, one
custom tool call and the absence of shell tools from the advertised set.
This milestone is the architecture gate described in section 2.

**M2a. Engine and game service.** `UciEngine`, `EnginePool`, normalized evaluation,
`GameService` with the turn loop, `games` and `moves`, restart recovery by replay.
Acceptance: tests with recorded UCI output for the parser, a fake engine for the loop,
restart during each phase, undo, Black-first games; the opt-in Stockfish test evaluates
a known position and asserts classification, not an exact centipawn.

**M2b. Board and coached play.** `ActivityState`, the WebSocket hub with bootstrap and
reconnect, the Play screen with chessground, move notifications and coalescing, Origin
check. Tools added: `get_game`, `show_position`, `make_move`, `analyze`, `new_game`,
`resign_game`.
Failure states: Stockfish missing or crashed, WebSocket dropped.
Acceptance: play a full game against the engine at 600 Elo; each student move gets a
classification in the move list and a coach comment; refresh the tab mid-game and the
board is still there; restart the server mid-game and the game continues.

**M3. Review and cards.** `srs_cards`, batch creation, the Review screen, the post-game
flow: the coach walks through up to three teaching positions, chosen as the player's
highest cp losses with ties broken by earlier ply, using `show_position`, and fills their
explanations. Tools added: `create_srs_cards`, `add_srs_card`, `explain_card`.
Acceptance: with a fixture game in the database, open it in Review, step through, create
cards, see them listed in Train with position, played and expected move; create them twice
and get the same count.

**M4. Train.** `content/puzzles` and `tools/` imported; `srs_reviews`, `puzzles`,
`puzzle_attempts`, seeding, the Train screen, grading, SM-2 scheduling. Tools added:
`get_due_cards`, `get_puzzles`.
Acceptance: with the clock injected and a card made due, answer it on the board, rate it,
its next review moves by the ladder; run a drill of ten fork puzzles, including a
multi-move one, with the coach commenting on misses.

**M5. Polish to daily use.** Consistency pass over the three screens against the design
note, interaction polish, README and `AGENTS.md` updated to what exists.
Acceptance, automated: every failure state and restart path above has a passing test.
Acceptance, field: five sessions across seven days with no workflow that needed a manual
database edit or a code change to get through.

## 10. Testing

- Unit, in `pnpm test`: `srs/` (the worked-example table), the UCI parser on recorded
  output, `game/` on a fake engine, grading, SM-2 persistence, event mapping on a fake SDK
  stream, zod schemas, restart recovery per phase, seed idempotency, card deduplication.
  All headless.
- Web, in `pnpm test`: a DOM environment is added with the first web test in M1; board
  adapter lifecycle under Strict Mode, promotion chooser, review navigation, reconnect.
  `--passWithNoTests` is removed then.
- Integration, opt-in and separate: `CHESS_COACH_STOCKFISH=1` for the real engine,
  `CHESS_COACH_SDK=1` for the SDK probe. Run by hand before a milestone closes, never in
  `bin/ci`.

## 11. Risks and open questions

1. SDK auth with the subscription login in a non-interactive process. Verified in M1; a
   failure stops the plan (section 2).
2. Streaming input shape of the SDK (`AsyncIterable<SDKUserMessage>`), the option that
   disables built-in tools, and the exact name of the permission callback: confirmed in the
   docs at planning time, exercised in M1 against the pinned version.
3. `better-sqlite3` needs a native build; it goes in `allowBuilds`. TypeScript 7 with
   vitest 5 and tsx works for the scaffold; any breakage surfaces in M1.
4. Engine latency: evaluation plus reply after each move. Measured in M2a on five
   representative positions; the budget is two seconds from move to coach notification on
   the development machine. If exceeded, `movetime` limits are tried before depth changes,
   and a depth change is checked against classification stability on the same positions.
5. chessground ships CSS that assumes a square container; the layout gives it one.
6. Context growth in a long coach session: move notifications, tool results and three
   appended references. The study session boundary is one coach session per day of use;
   a new day starts a new session. Measured, not guessed, once M2b runs.

## 12. Decisions and rejected alternatives

- **One process, in-process tools** over a separate MCP server: no second process to start,
  no file-based sync, state in one place. Rejected: keeping chess_rocket's stdio MCP server
  (two processes, state split, the file polling it forced).
- **The server owns every mutation; the coach observes and teaches.** Rejected: giving the
  coach `engine_move`, `grade_card` and `record_puzzle_attempt`. Two writers on one game
  is the race that cannot be tested away, and a coach that can grade its own student has
  the wrong authority.
- **SQLite** over JSON files: queries over moves and cards, atomic writes, one file.
  Rejected: Postgres (no second user to justify it).
- **Fastify + ws** over Next.js or tRPC: WebSocket is the main channel and a framework
  built around request/response adds nothing here.
- **chessground** over react-chessboard or a hand-rolled board: click-to-move with
  destination dots is native, it is the Lichess board, and it is TypeScript.
- **Biome** over ESLint + Prettier: one tool, one config.
- **Three screens** (Play, Review, Train) and four activity kinds: the demo is an activity
  because the coach needs the board without a screen of its own.
- **Not built, by decision:** a controller lease between tabs, protocol versioning and
  per-command revisions, durable queues for coach input beyond the notification rows,
  idempotency keys on coach tool calls, socket backpressure, accessibility work, cursor
  pagination, migration checksums, database file permissions, prompt-bundle hashing beyond
  a version string, a production asset pipeline. Each adds a user, a scale or a failure mode this MVP does not
  have. They are listed here so the next reviewer does not propose them again.
- **Plan length** well under the method's calibration on purpose: a single-user MVP with
  three screens does not need thousands of lines to be unambiguous; the beads carry the
  detail per task.
