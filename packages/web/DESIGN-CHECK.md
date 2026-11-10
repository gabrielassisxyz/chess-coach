# Design check

The rule-by-screen checklist for the web package, written against the identity the design
port settled on: cool grey surfaces, one blue accent, six coloured move grades that always
carry their word, IBM Plex, a three-column shell and a one-column phone. Change a screen,
re-check its column. `ok` means the rule holds in the markup and CSS as they stand,
`partial` means it holds in part (the reason is under the table), `n/a` means the screen has
no such element.

The values come from the design prototype and live in `src/styles/tokens.css`, the only file
in the web package that may hold a colour literal. Its header comment is the identity in
short. Re-run the two mechanical rows (M1 and M2) after any style change; both must print
nothing:

```sh
command grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' packages/web/src | command grep -v tokens.css
command grep -rnE 'box-shadow|text-shadow' packages/web/src
```

## The rules

Tokens and their origin

- Colours, type, space, radii and motion are tokens. Light is the base set under `:root`,
  dark overrides it under `:root[data-theme="dark"]`; `state/theme.ts` sets the attribute from
  the stored choice, else from the system preference.
- Surfaces are three cool greys (`--surface-0` app, `--surface-1` panel, `--surface-2` inset),
  one `--border`, three text levels. Never pure white or black.
- One accent blue. `--on-accent` flips per theme. The light accent is one step darker than the
  prototype's `#2f6fdc` because that value measured 4.46:1 on the panel and the text rule is
  4.5:1.
- Board squares are Lichess by default; `[data-board]` swaps the square set. Board and arrow
  overlay colours are tokens too.

Type

- IBM Plex Sans for UI and body, IBM Plex Mono for moves, evaluations, counts and the
  wordmark, both self-hosted.
- Scale: title 28/600 (`--text-title`, lh 1.2, tracking -0.02em), heading 18 (`--text-lg`),
  body and control 14 (`--text-base`, `--text-sm`), label 12 (`--text-xs`). Running text is
  capped at `--measure` (65ch). Tabular numerals wherever digits line up.

Quality colours

- Six grades (best, great, good, inaccuracy, mistake, blunder), each with a text colour and a
  badge background per theme. The colour never stands alone: the grade is also a word or a
  glyph (`!`, `?!`, `?`, `??`) or a screen-reader label beside it. Blunder red is also the
  only error tone.
- Status dots (ready, busy, error) and the error border are tokens; error styling is for
  something that failed.

Shell

- Top bar 48 px, active tab marked by a 2 px accent underline, "Routine" a disabled tab
  tagged "soon", a Light/Dark button.
- Three columns at 900 px and up inside a frame with 24 px padding and a 16 px gap: left
  column 220 px (328 px while a practice item is on the board), board column the rest, coach
  360 px as a panel; the coach collapses to a 32 px strip. Panels 8 px radius, controls 4 px,
  the composer 16 px, hairline borders, no shadows, no glow.
- Practice item: one column stacked by reading frequency (header with progress segments,
  ratings, engine strip, move list, state card), a 40 px bar under the board, popovers for the
  board and the engine settings anchored to their icons; coordinates inside the squares in
  10 px mono by default. A repertoire line drill swaps the ratings for the variation in play
  and three counts, names the opening and the variation of the move asked on a hairline row
  under them, and its open state hides the bar's Explore button.

Phone (under 900 px)

- One column that scrolls inside the shell; the board comes first whatever the source order;
  the coach is a bar and a sheet; every control is at least 44 px; no horizontal page scroll.

Motion and focus

- Under 300 ms (120 / 180 ms), `--ease-out`, transform and opacity only, no bounce, removed
  under `prefers-reduced-motion`. One focus ring (`src/styles/focus.css`, 2 px accent, 2 px
  offset); `test/focus.test.tsx` renders every screen and fails for an interactive element a
  rule leaves without it.

## The checklist

| # | Rule | Shell | Play | Games | Practice | Coverage | Phone |
|---|------|-------|------|-------|----------|----------|-------|
| M1 | No colour literal outside `tokens.css`; every colour is a token | ok | ok | ok | ok | ok | ok |
| M2 | No shadows, no glow | ok | ok | ok | ok | ok | ok |
| 3 | One accent hue; the grades and the error tone are the only other chroma | ok | ok | ok | ok | ok | ok |
| 4 | Grade colour always paired with its word, glyph or label | n/a | partial | ok | ok | n/a | partial |
| 5 | The error tone only for something that failed (plus the blunder grade) | ok | ok | ok | ok | ok | ok |
| 6 | Plex Sans for titles and UI, Plex Mono only for data | ok | ok | ok | ok | ok | ok |
| 7 | One 28/600 title per screen where the screen has one, the same face and tracking | n/a | partial | ok | ok | n/a | ok |
| 8 | The same type scale: controls, notes and lists use the same steps on every screen | ok | ok | ok | ok | ok | ok |
| 9 | Radii 4 px controls, 8 px panels, hairline borders; no nested cards, no icon tile, eyebrow, hero or gradient text | ok | ok | ok | ok | ok | ok |
| 10 | Spacing from the 4-based scale; the same screen padding and block gap | ok | partial | ok | ok | ok | ok |
| 11 | Shell measurements: 48 px bar, 24 px frame padding, 16 px gap, 220 (328 on an item) / board / 360 columns, 32 px strip | ok | ok | ok | ok | n/a | n/a |
| 12 | Running text near 65ch | ok | ok | ok | ok | ok | ok |
| 13 | Motion under 300 ms, ease-out, transform and opacity only, reduced motion respected | ok | ok | ok | ok | ok | ok |
| 14 | Focus visible on every interactive element, one ring | ok | ok | ok | ok | ok | ok |
| 15 | Empty, loading and error states say what to do next, in calm plain words | ok | ok | ok | ok | ok | ok |
| 16 | Summary before detail; one focus per glance | ok | ok | ok | ok | ok | ok |
| 17 | What is interactive looks interactive | ok | ok | partial | ok | ok | ok |
| 18 | Both themes exist and follow `prefers-color-scheme` until the button overrides them | ok | ok | ok | ok | ok | ok |
| 19 | Phone: under 900 px, board first, 44 px targets | n/a | ok | ok | ok | ok | ok |

The cells were read off the stylesheets and the markup, and the Phone column off the 899 px
media blocks; they were not re-measured in a browser for this rewrite. The measurements the
screens were built to are in the design probe's spec (token layer and interaction inventory).

## Partial cells

- **4, Play and Phone.** The move list marks inaccuracy, mistake and blunder with a glyph
  (`?!`, `?`, `??`) plus a screen-reader label, but best, great and good show only a coloured
  dot to a sighted reader; the word reaches only a screen reader.
- **7, Play.** The left column no longer shows a "Play" title; the section is named by its
  `aria-label` only, so Play is the one screen without a visible title.
- **10, Play.** The move list and the table rows use `2px`, `6px`, `24px`, `28px` and
  `32px` values (row height, dot size, gaps) that are not on the 4-based space scale; they
  size a data cell, not layout spacing.
- **17, Games.** The game list rows are plain text buttons: pointer, hover and the focus ring
  mark them, but nothing says "button" before the pointer arrives.

## Documented exceptions

- The promotion glyph size is `clamp(1.5rem, 5vw, 2.75rem)`, and a few `ch`, `rem` and `px`
  widths (evaluation label, ply column, the table's column widths, the 8 and 9 px dots, the
  8 rem facts and move cells and the 6 rem status cell of the coverage view) size a chess
  glyph or align digits, not text on the scale.
- The king-in-check highlight on the board uses the error tone, because a check is the one
  board state that must be seen at a glance.
- The checkerboard is a `conic-gradient` of two token colours; it is a pattern, not a
  gradient treatment.
- Four selectors in `board.css` (`square.move-dest`, `square.oc`, `square.last-move`,
  `square.check`) target classes that chessground writes into the DOM, so no `.tsx` mentions
  them.

## Screens and states still carrying old structure

- **Two names for one list.** `MoveList` (Play) uses `movelist__*`; `GameMoves` (Games) still
  uses `moves__*`, `game-moves__ply` and `games__mark`. Their rules sit apart too: `.moves*`
  is in `layout.css` although only Games renders it, with a phone override in `games.css`.
  Merging the two lists into one component and one set of rules is not done.
- **Grade styling in two places.** `movelist__dot--` and `movelist__mark--` (`play.css`) and
  `games__mark--` (`games.css`) each restate the grade-to-token map; there is no shared
  `.grade--*` rule.
- **A phone rule that counts columns.** Under 900 px the games table hides its secondary columns
  by position (`nth-child` in `games.css`) and sizes the ones it keeps the same way, so adding,
  removing or moving a column means renumbering those selectors, or the wrong columns show on a
  phone.
- **Tokens nothing references from `src`.** `--duration-fast`, `--leading-heading`,
  `--status-ready`, `--status-busy` and the four `--overlay-*` tokens have no `var()` user in
  the stylesheets or the code. They are the prototype's values, kept for the states and
  overlays that are not drawn yet (busy and ready dots, arrows, premove); delete them if
  those never land. `--space-12` is gone, and no `review__` or `train__` name survives.
- **Placeholder tab.** "Routine" is a disabled tab tagged "soon"; the screen behind it does
  not exist.
- **Play's board settings.** Play still opens the older settings card in its column with the
  theme radios alone; the popover with coordinates, animation and highlights exists on Practice
  only, though every board honours the stored preferences.
- **The Practice hub** was not part of the puzzle redesign and keeps its three older cards.
  The openings menu for the repertoire line drill is a fourth, built on the same card rules;
  its Practice cells were re-read against the markup and `repertoire.css` and hold. So were the
  cells for the list of openings met in the student's games, under White openings: a block with a
  hairline top border like each opening above it, rows of a name, a mono line and a count, and an
  Add button that is 44 px under 900 px. M1 and M2 print nothing for it, its states (reading
  failed, building, built, refused) are each a sentence that says what to do next, and a refusal
  is the only one in the error tone. The cells were read again for the levels and the branch
  points: a side with more than one opening and an opening with more than one variation carry a
  row of starts under a plain label, above what they cover, with the same buttons as a
  variation's; the book's other White moves open from an Add a variation button under the
  opening, each position as a heading line with its mono line, then rows built like the met
  openings, a held move saying where it is in place of the button. Every button is 44 px under
  900 px, M1 and M2 print nothing, and the building, built and refused states read as the met
  openings' do. The variation row under the drill's head is text on the type scale in the two
  text tokens, with a hairline below it like the head's. The Practice cells were read once more
  for the drills from the student's games, grouped by opening family: a line inside an opening's
  menu, a line under an opening met in games, and for the families with neither a block of rows
  with a hairline above it like each opening has, inside the White openings card or, for Black, a
  Black openings card of such rows alone. Each is a name, a count and a first-try rate in the
  secondary text token (the cell stays empty for a family with no attempt in 30 days) and a Drill
  button that is 44 px under 900 px. M1 and M2 print nothing for it, the rows wait for the openings
  met in games so none moves onto a met row after it has shown, a start refused because the
  family is gone says to reload, in the error tone like every refusal, and a list that could not
  be read is one plain sentence in the Openings card that says to reload. The Practice cells were
  read a last time for the Found in your games section, which holds the openings met in games
  that the openings menu used to list apart from the chosen ones: a block under the chosen
  openings with a hairline above it like each opening has, a heading in the type of an opening's
  name, the menu of each added opening as any opening has it, the rows still to add built like
  the met openings' with the same 44 px Add button, and last one row of starts under a plain
  label with a hairline above it, the same buttons as a variation's. With no added opening it
  holds the rows to add and no starts, and with nothing met and nothing built it is not drawn.
  The section is a labelled region, not a card, so no card sits inside another. M1 and M2 print
  nothing for it, and its states (building, built, refused, list unreadable) read as the met
  openings' do. The row under the drill's head now names the opening beside the variation, each
  a label and a name in the two text tokens that wrap together as a pair, so a long name never
  pushes the row past the column on a phone.
- **The coverage view** opens under a variation of the openings menu, from its Coverage button,
  and has a column of its own in the checklist. Its cells were read against the markup,
  `repertoire.css` and the 899 px block: a hairline above it as each opening in the menu has,
  no card of its own; four facts in a grid that wraps, notes capped at the measure, rows that
  wrap with their lines breaking anywhere, buttons that are 44 px under 900 px, and the accent
  with the word "Gap" for a reply that has no answer yet, never the error tone. M1 and M2 print
  nothing for it. Its states (loading, not read, nothing stored, no gap) each say what to do
  next, and only the reading failure is in the error tone.
- **Dictate, voice and the model picker** in the composer are drawn inert until spoken input
  and a model setting exist.
