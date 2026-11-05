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
- Three columns at 900 px and up: left column 220 px, board column the rest, coach 360 px;
  the coach collapses to a 32 px strip. Panels 8 px radius, controls 4 px, hairline borders,
  no shadows, no glow.

Phone (under 900 px)

- One column that scrolls inside the shell; the board comes first whatever the source order;
  the coach is a bar and a sheet; every control is at least 44 px; no horizontal page scroll.

Motion and focus

- Under 300 ms (120 / 180 ms), `--ease-out`, transform and opacity only, no bounce, removed
  under `prefers-reduced-motion`. One focus ring (`src/styles/focus.css`, 2 px accent, 2 px
  offset); `test/focus.test.tsx` renders every screen and fails for an interactive element a
  rule leaves without it.

## The checklist

| # | Rule | Shell | Play | Games | Practice | Phone |
|---|------|-------|------|-------|----------|-------|
| M1 | No colour literal outside `tokens.css`; every colour is a token | ok | ok | ok | ok | ok |
| M2 | No shadows, no glow | ok | ok | ok | ok | ok |
| 3 | One accent hue; the grades and the error tone are the only other chroma | ok | ok | ok | ok | ok |
| 4 | Grade colour always paired with its word, glyph or label | n/a | partial | ok | ok | partial |
| 5 | The error tone only for something that failed (plus the blunder grade) | ok | ok | ok | ok | ok |
| 6 | Plex Sans for titles and UI, Plex Mono only for data | ok | ok | ok | ok | ok |
| 7 | One 28/600 title per screen where the screen has one, the same face and tracking | n/a | partial | ok | ok | ok |
| 8 | The same type scale: controls, notes and lists use the same steps on every screen | ok | ok | ok | ok | ok |
| 9 | Radii 4 px controls, 8 px panels, hairline borders; no nested cards, no icon tile, eyebrow, hero or gradient text | ok | ok | ok | ok | ok |
| 10 | Spacing from the 4-based scale; the same screen padding and block gap | ok | partial | ok | ok | ok |
| 11 | Shell measurements: 48 px bar, 220 / board / 360 columns, 32 px strip | ok | ok | ok | n/a | n/a |
| 12 | Running text near 65ch | ok | ok | ok | ok | ok |
| 13 | Motion under 300 ms, ease-out, transform and opacity only, reduced motion respected | ok | ok | ok | ok | ok |
| 14 | Focus visible on every interactive element, one ring | ok | ok | ok | ok | ok |
| 15 | Empty, loading and error states say what to do next, in calm plain words | ok | ok | ok | ok | ok |
| 16 | Summary before detail; one focus per glance | ok | ok | ok | ok | ok |
| 17 | What is interactive looks interactive | ok | ok | partial | ok | ok |
| 18 | Both themes exist and follow `prefers-color-scheme` until the button overrides them | ok | ok | ok | ok | ok |
| 19 | Phone: under 900 px, board first, 44 px targets | n/a | ok | ok | ok | ok |

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
  widths (evaluation label, ply column, the table's column widths, the 8 and 9 px dots) size
  a chess glyph or align digits, not text on the scale.
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
- **Tokens nothing references from `src`.** `--duration-fast`, `--leading-heading`,
  `--status-ready`, `--status-busy` and the four `--overlay-*` tokens have no `var()` user in
  the stylesheets or the code. They are the prototype's values, kept for the states and
  overlays that are not drawn yet (busy and ready dots, arrows, premove); delete them if
  those never land. `--space-12` is gone, and no `review__` or `train__` name survives.
- **Placeholder tab.** "Routine" is a disabled tab tagged "soon"; the screen behind it does
  not exist.
