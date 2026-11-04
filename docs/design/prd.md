# chess-coach PRD for the design pass

As of 2026-11-04.

## Product vision

chess-coach is a personal chess tutor for one adult beginner (about 400 Elo on Chess.com)
who wants to reach 1000 through deliberate practice, not through more games. The product
is a web app on the owner's own machine: a chessboard, an engine (Stockfish) that grades
every move, and an AI coach (a Claude session) that watches, explains, and remembers.

The finished product closes one loop every day in 25 to 30 minutes:

1. Play a coached game, or import the games played on Chess.com against humans.
2. Review a game: step through it, see where material was lost, ask the coach about a move.
3. Train on what went wrong: spaced-repetition cards made from the student's own mistakes,
   tactical puzzles by motif, and opening drills built from the positions that actually
   occur in the student's games at this level.
4. Follow a weekly routine the coach writes from the data: one motif per week, one daily
   block, a pre-move checklist.

What makes it different from Chess.com or Lichess: the coach knows this student. It sees
every game, every mistake, every puzzle attempt, and it talks in the student's language
level. The student thinks out loud (typing today, voice later) while exploring a position on
the board, and the coach reviews the reasoning, not only the move.

The board is the product. The coach is a companion beside it, never the main stage.

## Screens and flows

One layout for every screen: a top bar with the screens, the board in the centre, the coach
chat as a collapsible panel on the right. The screens differ in what surrounds the board and
in what the board accepts.

| Screen | What it shows | What the student does there |
| --- | --- | --- |
| Play | The live game against the engine: board, move list with a quality badge per move (best, great, good, inaccuracy, mistake, blunder), an evaluation bar, controls (new game with colour and engine strength, undo, resign). | Clicks a piece, sees its legal squares as dots, clicks one. The engine replies in under a second; the coach comments in the panel a few seconds later. |
| Games | Every finished game in one list, tagged by source (played here with the coach, or imported from Chess.com by username and date range), with result, length and accuracy. Opening one puts it on the board for stepping (arrow keys, clicking the move list). | Steps through, reads the loss per move, presses "Create cards" to turn mistakes into training material, presses "Ask the coach" on a move to get it explained. |
| Train | A session of one kind at a time: due cards (positions from the student's own games), a puzzle drill of one motif (forks, pins, back-rank, endgames...), or an opening drill (best move in the positions that occur at this level). The board shows the position; the panel shows the coach. | Explores freely on the board while thinking out loud in the chat (later: by voice). Presses "Answer" when ready; the server grades, the coach reviews the reasoning against what happened. For cards, rates how well the position was known (0 to 5). |
| Routine (future) | The week's plan as a checklist: motif of the week, today's block in order (review cards, ten puzzles, one game, review), the pre-move checklist. | Ticks the steps; each step opens the right screen already set up. |

Three flows carry the product; everything else is support.

1. **Coached game.** Start a game. Move. The engine replies and the coach says one line on
   a good move and a short lesson on a bad one; after a blunder it offers Undo. When the
   game ends, the coach walks through the three costliest moments on the board and the
   mistakes become cards.
2. **Review of an imported game.** Enter a Chess.com username and a date range, pick the
   games, wait for the engine to grade them in the background. Open one in Games, step
   through, ask the coach, create cards.
3. **Training item with exploration.** The coach (or the student) starts an item. The
   student moves pieces around to test ideas and types the reasoning; the server records
   every exploration step with a timestamp. "Answer" submits the chosen move. Right or
   wrong, the coach sees the reasoning, the explored lines and the answer together, and
   points at what the student did not look at.

States every screen needs designed: empty (no games yet, nothing due, no puzzles for a
motif), loading, error with the fix (engine missing, coach not logged in, connection lost
and reconnecting), coach thinking versus coach streaming, and an unanswered permission
request from the coach.

## Design principles

1. **The board is the centre.** It takes the height of the viewport on desktop and the full
   width on a phone. Everything else is secondary and sized accordingly.
2. **The coach is a side panel, not a split screen.** About a third of the width at most,
   collapsible to a thin strip with an unread marker when the coach has spoken. The student
   should be able to play a whole game with the panel closed and open it when they want the
   commentary.
3. **Quiet by default, loud only where it carries information.** Move quality is
   information: best, good, inaccuracy, mistake and blunder must be told apart at a glance,
   with colour and with text. Everything that is not information (chrome, borders, panels)
   stays neutral.
4. **One screen, one job.** Play shows the live game; Train shows the training item or the
   way to start one; Games shows the list or the game being stepped. A screen never shows
   another screen's board.
5. **The chat reads like a conversation with a person who is also looking at the board.**
   Tool calls the coach makes (analyse, show a position) appear as small, foldable cards,
   not as raw JSON.
6. **Desktop first, phone second.** The owner plays on a desktop at home and on a phone
   over the tailnet away from home. On a phone the board comes first and the chat stacks
   below or slides in.
7. **No marketing surface.** There is no landing page, no hero, no sign-up. The app opens
   on the board.
8. **Light and dark both, from one set of tokens.**

## Technical constraints

- The app is React with plain CSS. Colours, type scale, spacing and radii are CSS custom
  properties in one tokens file; components use only tokens. Deliver the design as tokens
  plus component layouts, not as a framework.
- The board is chessground (the Lichess board). Its square colours, highlight colours and
  piece set can be themed; its geometry, animation and piece rendering cannot. Design
  around the board, not the board itself.
- The chat streams: text arrives in fragments, tool calls appear while the coach works.
  Design for a message that is still being written.
- No images or illustrations are needed; icons only where a word would not fit.
- No web fonts are bundled today; a font can be proposed, self-hosted.
- Target widths: 1280 to 1920 on desktop, 390 to 430 on a phone.
- Accessibility baseline: visible focus on every control, text labels beside every colour
  that carries meaning, keyboard stepping in Games.

## Anti-patterns

Explore freely within the principles above; avoid these.

**Type**

- No serif display faces for titles or UI.
- No Space Grotesk, and no "AI product" look built on a geometric grotesque with wide
  tracking.
- No type scale with more than four or five sizes.

**Colour**

- No terracotta, cream, beige or sand palettes; no warm-brown "paper" backgrounds.
- No purple-to-blue gradients, no glow, no neon on dark.
- No pure white (#fff) or pure black (#000) as a surface.
- No rainbow of status colours; a few meaningful tones, text beside each.

**Layout**

- No hero section, no landing-page structure, no marketing copy.
- No card-on-card-on-card stacks with shadows; no floating panels over the board.
- No decorative blobs, gradients, or background shapes.
- No chat taking half the screen or more.
- No icon-only navigation; no emoji as icons.
- No animated decoration; motion only to show a state change, short, and never bouncy.

## Deliverables

Every screen, in this order, one step approved before the next:

1. **Shell and visual identity first.** The token set (light and dark surfaces, text, one
   accent, the move-quality tones, board squares and highlights, type scale, spacing,
   radii) and the app shell: top bar, board area, collapsible coach panel, at desktop and
   phone widths, panel open and collapsed. Stop here for approval.
2. **One screen to judge the identity on.** Play, at desktop width, in its main state during
   a game, with the chat panel showing a coach message. Iterate on this one until it is
   right.
3. **The remaining screens**, each in its main state plus one empty and one error state:
   Games (list and stepping a game), Train (choosing a session, the item in exploration
   with reasoning being typed, after "Answer" with a wrong move and the expected move
   shown, the card rating step), and the chat panel in three moments (coach thinking,
   streaming with a folded tool card, an unanswered permission request).
4. **Phone width** for Play and Train.

How it will be used: the tokens go into the tokens file as they are; the layouts are
rebuilt as React components by an engineer with the screens as the reference. Screenshots
of the current app, where provided, show what exists and what each screen must contain;
they are not a reference for the look.
