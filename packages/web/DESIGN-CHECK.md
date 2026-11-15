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

## Partial cells

- **4, Play and Phone.** The move list marks inaccuracy, mistake and blunder with a glyph
  (`?!`, `?`, `??`) plus a screen-reader label, but best, great and good show only a coloured
  dot to a sighted reader; the word reaches only a screen reader.
- **7, Play.** The left column no longer shows a "Play" title; the section is named by its
  `aria-label` only, so Play is the one screen without a visible title.
- **8, Practice.** The section title inside a hub page ("Puzzle themes" on the Overview) is
  20 px, the redesign's step between the 18 px heading and the 28 px title, which has no token
  yet.
- **10, Play.** The move list and the table rows use `2px`, `6px`, `24px`, `28px` and
  `32px` values (row height, dot size, gaps) that are not on the 4-based space scale; they
  size a data cell, not layout spacing.
- **10, Practice.** The hub's navigation and tiles keep the redesign's `2px` between entries,
  `6px` under a group label, `10px` inside an entry and between a tile's lines, and `14px` above
  and below a tile's content, none of them on the 4-based scale; they size a row of the
  navigation or a tile, not the page's spacing, which stays on the scale.
- **17, Games.** The game list rows are plain text buttons: pointer, hover and the focus ring
  mark them, but nothing says "button" before the pointer arrives.
- **15, Practice.** Loading and error states match the rule (quiet sentence, or one sentence in
  the error tone with Try again in the same card), and Due cards keeps the card at 0 due while
  omitting empty breakdown rows; however, empty library motif rows still draw disabled with
  `none`, and empty Found in your games and Black openings sections are omitted rather than
  keeping an empty section with a sentence and count.

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
- **Tokens nothing references from `src`.** `--duration-fast`, `--leading-heading` and
  `--overlay-premove` have no user in the stylesheets or code. `--status-ready` and
  `--status-busy` are now used beside `--status-error` for the solved-first-try bar on
  Improvement areas and Strengths. The four `--overlay-arrow-*` tokens
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
  window. The Overview opens first, with three tiles over the older Due cards card and a Puzzle
  themes section holding the older Puzzles by motif card; Puzzle themes in the navigation shows the
  Overview scrolled to that section. The Openings page holds the openings menu and the older
  Italian drill row, Improvement areas and Strengths show the ranked puzzle theme tables, and the
  three other pages are a title and a sentence saying the page is not built yet. The older cards are mounted on their pages unchanged. The openings menu for the
  repertoire line drill is built on the same card rules as before;
  its Practice cells were re-read against the markup and `repertoire.css` and hold. So were the
  cells for the list of openings met in the student's games, under White openings: a block with a
  hairline top border like each opening above it, rows of a name, a mono line and a count, and an
  Add button that is 44 px under 900 px. M1 and M2 print nothing for it, and its states
  (loading, reading failed, building, built, refused) follow Rule 15: refusals and read failures
  use the error tone, and read failures pair one sentence with a Try again button in the same card.
  The cells were read again for the levels and the branch
  points: a side with more than one opening and an opening with more than one variation carry a
  row of starts under a plain label, above what they cover, with the same buttons as a
  variation's; the book's other White moves open from an Add a variation button under the
  opening, each position as a heading line with its mono line, then rows built like the met
  openings, a held move saying where it is in place of the button. Every button is 44 px under
  900 px, M1 and M2 print nothing, and the building, built, refused and list-unreadable states
  read as the met openings' do. The variation row under the drill's head is text on the type scale
  in the two text tokens, with a hairline below it like the head's. The Practice cells were read
  once more for the drills from the student's games, grouped by opening family: a line inside an
  opening's menu, a line under an opening met in games, and for the families with neither a block
  of rows with a hairline above it like each opening has, inside the White openings card or, for
  Black, a Black openings card of such rows alone. Each is a name, a count and a first-try rate
  in the secondary text token (the cell stays empty for a family with no attempt in 30 days) and a
  Drill button that is 44 px under 900 px. M1 and M2 print nothing for it, the rows wait for the
  openings met in games so none moves onto a met row after it has shown, a start refused because
  the family is gone says to reload, in the error tone like every refusal, and a list that could
  not be read is one sentence in the error tone paired with a Try again button in the Openings
  card. The Practice cells were read a last time for the Found in your games section, which holds
  the openings met in games that the openings menu used to list apart from the chosen ones: a
  block under the chosen openings with a hairline above it like each opening has, a heading in the
  type of an opening's name, the menu of each added opening as any opening has it, the rows still
  to add built like the met openings' with the same 44 px Add button, and last one row of starts
  under a plain label with a hairline above it, the same buttons as a variation's. With no added
  opening it holds the rows to add and no starts, and with nothing met and nothing built it is not
  drawn. The section is a labelled region, not a card, so no card sits inside another. M1 and M2
  print nothing for it, and its states (loading, building, built, refused, list unreadable) read as
  the met openings' do. The row under the drill's head now names the opening beside the variation,
  each a label and a name in the two text tokens that wrap together as a pair, so a long name never
  pushes the row past the column on a phone.
- **The coverage view** opens under a variation of the openings menu, from its Coverage button,
  and has a column of its own in the checklist. Its cells were read against the markup,
  `repertoire.css` and the 899 px block: a hairline above it as each opening in the menu has,
  no card of its own; four facts in a grid that wraps, notes capped at the measure, rows that
  wrap with their lines breaking anywhere, buttons that are 44 px under 900 px, and the accent
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
- **Dictate, voice and the model picker** in the composer are drawn inert until spoken input
  and a model setting exist.
