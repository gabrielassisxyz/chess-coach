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
  overlay colours are tokens too. Knight-move arrows render as an L through `customSvg`
  (two-square leg first, then one-square turn) in the same arrow tokens, opacity and stroke
  widths as straight arrows.

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

States

- Loading: a quiet plain sentence (`role="status"`), with no skeleton and no spinner.
- Error: one sentence in the error tone (`role="alert"`) paired with a Try again button in the same
  card, keeping any action the card can still run.
- Empty: the card stays with a quiet sentence, the student's number and an action when one exists;
  an empty row or segment is not drawn, and the enclosing section stays.

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
| 8 | The same type scale: controls, notes and lists use the same steps on every screen | ok | ok | ok | partial | ok | ok |
| 9 | Radii 4 px controls, 8 px panels, hairline borders; no nested cards, no icon tile, eyebrow, hero or gradient text | ok | ok | ok | ok | ok | ok |
| 10 | Spacing from the 4-based scale; the same screen padding and block gap | ok | partial | ok | partial | ok | ok |
| 11 | Shell measurements: 48 px bar, 24 px frame padding, 16 px gap, 220 (328 on an item) / board / 360 columns, 32 px strip | ok | ok | ok | ok | n/a | n/a |
| 12 | Running text near 65ch | ok | ok | ok | ok | ok | ok |
| 13 | Motion under 300 ms, ease-out, transform and opacity only, reduced motion respected | ok | ok | ok | ok | ok | ok |
| 14 | Focus visible on every interactive element, one ring | ok | ok | ok | ok | ok | ok |
| 15 | Loading quiet sentence; error one error-tone sentence + Try again in same card; empty card/section stays, empty row/segment hidden | ok | ok | ok | partial | ok | ok |
| 16 | Summary before detail; one focus per glance | ok | ok | ok | ok | ok | ok |
| 17 | What is interactive looks interactive | ok | ok | partial | ok | ok | ok |
| 18 | Both themes exist and follow `prefers-color-scheme` until the button overrides them | ok | ok | ok | ok | ok | ok |
| 19 | Phone: under 900 px, board first, 44 px targets | n/a | ok | ok | ok | ok | ok |

The cells were read off the stylesheets and the markup, and the Phone column off the 899 px
media blocks; they were not re-measured in a browser for this rewrite. The measurements the
screens were built to are in the design probe's spec (token layer and interaction inventory).

The Play, Games and Practice columns were re-checked for board drawing. All three render the
same `Board`, including the read-only review and demo boards. Right-click drawings use four
distinct arrow tokens and share the overlay with app arrows, with knight-move arrows drawn as
an L through `customSvg` in the same tokens, opacity and stroke widths; they add no control,
layout, motion or focus treatment. M1 and M2 still find no matches.

The Practice column was re-checked for the try mark. The check or cross on a destination
square is a 28 px disc centred on the square's top right corner as seen on screen, shifted
inward by half its size on the top row or the right column so it stays fully inside the
board. M1 and M2 still find no matches.

The Practice column was re-checked on rows 7, 9, 10, 11, 14, 15, 16 and 17, and the Phone
column on row 19, for the hub's frame, against the markup and `practice-hub.css`; the cells were
not measured in a browser. Each page has one 28/600 title (`.screen__title`) with a 14 px note
beside it. The entries are 4 px controls with no border, the tiles 8 px panels with a hairline
border, and the Puzzle themes section is a labelled region rather than a card, so the motif card
inside it is not nested. The navigation is 220 px with the shell's 16 px gap to the page, and the
page column stops at 1440 px. Its entries take the one focus ring, drawn 2 px inside the entry
because the navigation is a box that scrolls by itself and would clip a ring drawn outside. The
tiles are drawn only once the progress numbers are read, while the Due cards card says it is
loading or offers Try again, and a page with no content yet keeps its title and a sentence. The
Overview reads the tiles before the cards. An entry reads as navigation: a column of names beside
the page, the current one on the inset surface in the primary text, the others in the secondary
text until hovered. Under 900 px the entries are one wrapping row of 44 px targets above the page
and the cards stack in one column. M1 and M2 still find no matches.

The Play, Games and Practice columns were re-checked for icon controls in light and dark at
390 px. In Chromium, Play's empty state, Games' load failure state and Practice's open puzzle
had no horizontal overflow. Practice keeps the move controls together and wraps Explore,
Flip board and settings together onto a second row. The icon-only buttons have matching
visible and accessible names, and their icons render at 20 px. The base icon button remains
32 px square on desktop; the quiet and board-gear variants keep their smaller desktop sizes,
and phone icon controls are at least 44 px wide. M1 and M2 still find no matches.

The Practice column was re-checked on rows 6, 7, 8, 9, 10, 14, 15, 16, 17 and 19, and the Phone
column on row 19, for the Openings page, against its markup and `practice-openings.css`, and in
Chromium at 1600 px and 800 px over a copy of the data. A card is an 8 px panel with a hairline
border and 16 px and 20 px of padding; its head is one button holding a 16 px chevron that turns a
quarter when the card opens (transform only, 180 ms, ease-out, dropped under reduced motion), the
name at 18 px and 600 and the opening's line in the mono face. The five cells are a 12 px label over
a 14 px mono value in equal columns 16 px apart; the count due is in the accent above 0, the
share of games stayed in is a bar 4 px high in `--status-ready` over `--surface-2`, and a cell
nothing was measured for holds the no-value dash and no bar. A variation's row sits behind a hairline
at the left, with its name at 15 px and 500 (underlined on hover, since it opens the coverage), its
line in mono and its button in the grid's sixth column, one gap after the coverage column. A train
button is two buttons in one shape, 32 px (30 px in a row), whose menu is a panel on `--surface-raised`
with `--border-strong` and no shadow; with nothing recommended it is one outlined button. The two
dashed shapes, the Add an opening button and a colour with no line, are 32 px and 8 px radius
boxes with a dashed hairline, never a card inside a card, and the panel that Add an opening
opens is a card of its own beside the others. Loading is one quiet sentence, a failed read one
sentence in the error tone with Try again, and an empty colour a sentence in its box. Under 900 px
the five cells wrap to two columns, the head's buttons go under the title, every control is 44 px
and nothing scrolls sideways. M1 and M2 still find no matches.

The Practice column was re-checked on rows 6, 8, 9, 10, 14, 15, 17 and 19, and the Phone column on
row 19, for the panel that Add an opening opens, against its markup, `practice-openings.css` and
`test/practice-add-opening.test.tsx`; the cells were not measured in a browser. The panel is the
8 px surface of the page's column with 16 px and 20 px of padding and its parts 10 px apart, and
nothing inside it is a card. Its title is 16 px and 500; its two tabs are one inset track 30 px high
with 13 px text, the chosen one raised on the border tone, a tablist that the arrow, Home and End
keys move through, and Close is an outlined 30 px button. Both lists stay mounted and the one not
chosen is hidden, so a change of tab loses neither the search nor the list read. The search field is
36 px high with a magnifier and takes the one focus ring. A row is a grid of the name, a column for
the pill or the count of games, and Add, 12 px apart, with 7 px of padding and a hairline under it;
the name is 14 px with its moves beside it in 12 px mono, the pill is 11 px in the secondary text on
`--surface-2` and takes the pill radius, and the heading over each path is 12 px in the secondary
text. Loading is one quiet sentence, a failed read one sentence in the error tone with Try again in
the first tab while the second still works, and an empty list a sentence in the place of its rows.
Under 900 px the tabs and Close go under the title, every control is 44 px, and a row keeps its
name, pill and Add on one line with the moves under the name. M1 and M2 still find no matches.

## Partial cells

- **4, Play and Phone.** The move list marks inaccuracy, mistake and blunder with a glyph
  (`?!`, `?`, `??`) plus a screen-reader label, but best, great and good show only a coloured
  dot to a sighted reader; the word reaches only a screen reader.
- **7, Play.** The left column no longer shows a "Play" title; the section is named by its
  `aria-label` only, so Play is the one screen without a visible title.
- **8, Practice.** The section title inside a hub page ("Puzzle themes" on the Overview, "White"
  and "Black" on Openings) is 20 px, the redesign's step between the 18 px heading and the 28 px
  title, which has no token yet; a variation's name on Openings is 15 px, between the 14 px body and
  the 18 px heading, and the tabs of the panel that adds an opening are 13 px and its pill 11 px,
  between the 12 px label and the 14 px body.
- **10, Play.** The move list and the table rows use `2px`, `6px`, `24px`, `28px` and
  `32px` values (row height, dot size, gaps) that are not on the 4-based space scale; they
  size a data cell, not layout spacing.
- **10, Practice.** The hub's navigation and tiles keep the redesign's `2px` between entries,
  `6px` under a group label, `10px` inside an entry and between a tile's lines, and `14px` above
  and below a tile's content, none of them on the 4-based scale; they size a row of the
  navigation or a tile, not the page's spacing, which stays on the scale. The Openings page keeps
  `20px` of padding at the sides of a card and of its panel, `28px` between its colours, `24px`
  between the rows of an open card and `10px` between the parts of its panel, whose rows keep `7px`
  of padding and `12px` between their columns and whose search field is `36px` high, the approved
  screens' values.
- **17, Games.** The game list rows are plain text buttons: pointer, hover and the focus ring
  mark them, but nothing says "button" before the pointer arrives.
- **15, Practice.** Loading and error states match the rule (quiet sentence, or one sentence in
  the error tone with Try again in the same card), and Due cards keeps the card at 0 due while
  omitting empty breakdown rows; however, empty library motif rows still draw disabled with
  `none`. The Openings page keeps an empty colour with a sentence in a dashed box, as the rule asks.

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
  `square.check`) plus `.cg-wrap .cg-custom-svgs` and `.cg-wrap .cg-custom-svgs svg` target
  elements and classes that chessground writes into the DOM, so no `.tsx` mentions them.

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
- **Tokens nothing references from `src`.** `--overlay-premove` has no user in the stylesheets or
  code. It is the prototype's value, kept for a state that is not drawn yet (premove); delete it
  if that never lands. `--status-ready` and `--status-busy` are used beside `--status-error` for
  the solved-first-try bar on Improvement areas and Strengths, and `--status-ready` also fills the
  Openings page's in-line bar. The four `--overlay-arrow-*` tokens
  are read by `Board.tsx` through `getComputedStyle`, so they have no `var()` caller.
  `--space-12` is gone, and no `review__` or `train__` name survives.
- **Placeholder tab.** "Routine" is a disabled tab tagged "soon"; the screen behind it does
  not exist.
- **Play's board settings.** Play still opens the older settings card in its column with the
  theme radios alone; the popover with coordinates, animation and highlights exists on Practice
  only, though every board honours the stored preferences.
- **The Practice hub** is a frame: a navigation of eight entries in two groups, Train and
  Stats, sticky beside a page column of at most 1440 px that shows one page at a time, the page
  scrolling as a whole and only the navigation scrolling by itself when it is taller than the
  window. The Overview opens first, with four tiles (Day streak, Puzzle rating, Solved first try,
  Cards remembered) over the Due cards card (with its Coming up 7-day forecast) and a Puzzle
  themes section holding the older Puzzles by motif card; Puzzle themes in the navigation shows the
  Overview scrolled to that section. The Openings page is built as described in the check above,
  Improvement areas and Strengths show the ranked puzzle theme tables, and the three other pages
  are a title and a sentence saying the page is not built yet. The older cards are mounted on their
  pages unchanged.
- **The Openings page** keeps the machinery that adds an opening or a variation, and its cells hold
  as they did in the menu it replaced. The panel that Add an opening opens has two tabs: every
  opening Black can leave the path with, behind a search field and under a heading for each path,
  and the openings the student's games met; each row is a name, a mono line, a pill or a count and
  an Add button that is 44 px under 900 px, or the words In your openings in its place. The book's other White moves open from + Add a variation under
  a card's head, each position as a heading line with its mono line and then rows built like the met
  openings', a held move saying where it is in place of the button. The style points control sits in
  both panels, a quiet toggle with a summary and, opened, a row per measure with a stepper. The
  building, built, refused, stopped and list-unreadable states read as they always did: refusals and
  read failures in the error tone, a read failure paired with Try again in the same block. The row
  under a line drill's head names the opening beside the variation, each a label and a name in the
  two text tokens that wrap together as a pair.
- **The coverage view** opens under a variation's row on the Openings page when its name is
  pressed, and has a column of its own in the checklist. Its cells were read against the markup,
  `repertoire.css` and the 899 px block: a hairline above it, no card of its own; four facts in a
  grid that wraps, notes capped at the measure, rows that wrap with their lines breaking anywhere,
  buttons that are 44 px under 900 px, and the accent
  with the word "Gap" for a reply that has no answer yet, never the error tone. M1 and M2 print
  nothing for it. Its states (loading, not read, nothing stored, no gap) follow Rule 15: not read
  is one sentence in the error tone paired with a Try again button inside the panel, and only the
  reading failure uses the error tone.
- **Improvement areas and Strengths** sit inside the Stats group of the Practice hub. Each draws
  a `screen__title`, a `screen__note` subtitle and the four-window control (`7 days`, `30 days`,
  `90 days`, `All`), over a `surface-1` bordered panel whose grid (`minmax(0, 1fr) 56px 104px
  140px 104px`, `16px` gap, `56px` row min-height) holds ranked theme rows with mono figures,
  `--quality-best`/`--quality-blunder` rating deltas, the `4px` `--status-*` bar and a `Train`
  button. Loading (`role="status"`), error (`role="alert"` + `Try again`) and empty (`--measure`
  note + `Start a healthy mix`) follow Rule 15 inside the same panel. Under 900 px the
  description, bar and Played count hide, and buttons take `min-height: 44px`. `56px`, `104px`,
  `140px`, `36px`, `2px`, `10px`, `20px` and `80px` size data cells and panel states rather than
  layout spacing. M1 and M2 print nothing for them.
- **Practice Overview tiles and Due cards forecast** were re-checked for the Practice and Phone
  columns against the markup and `practice-hub.css`. All four tiles use `--surface-1`, `--border`,
  `--font-mono`, `--text-1`/`--text-2`, `--quality-best`/`--quality-blunder` deltas, `--status-ready`
  / `--status-error` / `--surface-2` / `--accent` indicators, wrap their value rows cleanly, and
  stack two by two (`repeat(2, minmax(0, 1fr))`) under 900 px; Due cards separates the 7-day
  forecast with a `1px solid var(--surface-2)` top border, uses `--accent` on today and
  `--surface-2` on upcoming days, and leaves partial data without alerts when rating history or
  theme stats fail. M1 and M2 still print nothing.
- **Dictate, voice and the model picker** in the composer are drawn inert until spoken input
  and a model setting exist.
