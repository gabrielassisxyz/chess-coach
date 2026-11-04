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
  (comma-separated) replaces them.
- **Data:** one SQLite file, `data/chess-coach.db`, under the repository root and git-ignored.
  `CHESS_COACH_DATA_DIR` moves it, `CHESS_COACH_CONTENT_DIR` moves the teaching content
  (`content/`). Puzzles are seeded from `content/puzzles` at every server start.
- **Test:** `pnpm test` (vitest, per package). Opt-in flags, off by default and never in
  `bin/ci`: `CHESS_COACH_STOCKFISH=1` runs the real-engine grading suite
  (`pnpm --filter @chess-coach/server test:stockfish`); `CHESS_COACH_SDK=1` runs the live
  Claude session probe (`test:sdk`, stdin closed); `CHESS_COACH_RECORD=<file>` records the SDK
  stream to that file. `CHESS_COACH_CHESSCOM=1` makes one real call to the public Chess.com API
  (`chesscom.real.test.ts`, shape only).
- **Failure inventory:** `packages/server/test/failure-inventory.test.ts` names the test that
  proves each failure and restart path (not logged in, API key present, SDK exit mid-turn,
  Stockfish missing, engine fault, dropped socket, restart per game phase, undelivered
  notifications, refresh per activity kind) and reads the files from disk. Renaming or
  deleting one of those tests means updating the inventory in the same change.
- **Design:** `packages/web/src/styles/tokens.css` is the only file allowed a colour literal;
  `packages/web/DESIGN-CHECK.md` is the rule-by-screen checklist. Change a screen, re-check
  its column.
- **Typecheck / lint:** `pnpm typecheck`, `pnpm lint` (Biome, lint and format in one)
- **Gate:** `bin/ci`, the exact thing GitHub Actions runs. Green locally means green in CI.
- **After clone:** `bin/install-hooks` once (gitleaks pre-commit, attribution commit-msg).
- **Import:** the Review screen imports Chess.com games by username and month range, or a pasted
  PGN, and grades them in the background. `CHESS_COACH_USERNAMES` (comma-separated) names the
  student's accounts so a pasted PGN finds its side; without it the form asks for the colour.
- **Stockfish:** the server expects a `stockfish` binary on `PATH` (`STOCKFISH_PATH`
  overrides). The engine is a runtime dependency, never vendored.

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

## Common hurdles

| hurdle | class | gate |
|---|---|---|
| `pnpm` is a mise shim with no global version; run from the repo so `mise.toml` resolves it | tripwire | none yet |
| Port 3000 is taken on the owner's machine, so the server defaults to 3210; a new listener must not assume 3000 | tripwire | none yet |
| The Agent SDK needs `strictMcpConfig: true`, or the owner's claude.ai connector tools leak into the coach's tool list | tripwire | `session.test.ts` asserts the option; only the opt-in SDK probe proves the tool list |
| A merge that keeps both sides of "append at end of file" can join two functions across the conflict seam, and the result compiles or fails far from the conflict: read the merged hunk, not just the markers | tripwire | none yet |
| `grep` (and `find`) are shell functions in an agent session and silently skip git-ignored trees; use `command grep` | tripwire | none yet |

**A hurdle promoted to a gate is deleted from this table, not duplicated.** The gate is the
instruction; a line here restating it only dilutes the ones still unguarded.
