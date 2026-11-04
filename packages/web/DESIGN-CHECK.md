# Design check

The three screens checked against the owner's design taste as a set, not one at a time.
Each row is one rule; each column is a screen. `ok` means the rule holds in the markup and
CSS as they stand. `fixed` means it diverged and was corrected in this pass. `partial` is a
rule met only in part, with the reason below the table. The top bar and the chat column are
shared by all three screens and are checked as part of every column.

Colour roles, the type scale, spacing, radii and motion all come from
`src/styles/tokens.css`, the only file in the web package that may hold a colour literal.
Re-run the two mechanical rows (1 and 9) after any style change:

```sh
command grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' packages/web/src | command grep -v tokens.css
command grep -rnE 'box-shadow|text-shadow' packages/web/src
```

Both must print nothing.

| # | Rule | Play | Review | Train |
|---|------|------|--------|-------|
| 1 | No colour literal outside `tokens.css`; every colour is a token | ok | ok | ok |
| 2 | Neutral grounds (charcoal and soft off-white), never pure white or black, never cream | ok | ok | ok |
| 3 | One accent hue, the only chromatic colour besides the error tone | ok | ok | ok |
| 4 | No severity ramp: colour names a thing, never a magnitude | fixed | fixed | ok |
| 5 | The error tone is used only for something that failed | fixed | fixed | ok |
| 6 | A grotesque sans for titles and UI, never serif | ok | ok | ok |
| 7 | One title per screen, the largest step, same face, weight and tracking | fixed | fixed | fixed |
| 8 | The same type scale: controls, notes and lists use the same steps on every screen | fixed | fixed | fixed |
| 9 | Small radii, hairline borders, no shadows, no glow | ok | ok | ok |
| 10 | No nested cards; no icon tile, eyebrow, hero or gradient text | ok | ok | ok |
| 11 | Spacing from the 4px scale; the same screen padding and block gap | ok | ok | ok |
| 12 | Mono only for data, tabular numerals where digits line up | ok | ok | ok |
| 13 | Running text near 65ch | ok | ok | ok |
| 14 | Motion under 300ms, ease-out, transform and opacity only, reduced motion respected | fixed | fixed | fixed |
| 15 | Focus visible on every interactive element, one ring | fixed | fixed | fixed |
| 16 | Empty, loading and error states say what to do next, in calm plain words | ok | fixed | fixed |
| 17 | Summary before detail; one focus per glance | ok | ok | ok |
| 18 | What is interactive looks interactive | ok | partial | ok |
| 19 | Both themes exist and follow `prefers-color-scheme` | ok | ok | ok |

## What was fixed

- **4 and 5.** The grade badges coloured `great` and `best` with the accent and `blunder`
  with the error tone, which is a ramp by magnitude. All grades are now neutral; `mistake`
  and `blunder` are told apart by weight, and every badge carries its grade as text.
- **7.** Only Train had a title. Play and Review now carry one, and all three, plus the
  chat title, share `.screen__title`.
- **8.** Play's buttons inherited the body face and size while Review's and Train's
  inherited the UI face, and each screen's buttons inherited whatever size its container
  set. `.button` now sets its own face and size, and `.input` is the one
  style for the Elo field, the motif select and the chat composer. The screens share one
  frame, `.screen`, instead of three copies of the same padding and gap.
- **14.** The evaluation bar animated `width` and two controls animated `background-color`.
  The bar now scales with `transform`; the colour transitions were removed. The board, and
  with it the promotion chooser, is on all three screens.
- **15.** Focus styling was scattered over four rules and the promotion chooser removed the
  outline. `src/styles/focus.css` is the single ring; `test/focus.test.tsx` renders every
  screen and fails for any interactive element a stylesheet rule leaves without one.
- **16.** Review and Train had no loading, empty or failure copy, or copy with no next step.

## Not fully satisfied

- **18, Review.** The game list and the move list are plain text buttons: they show a
  pointer, an accent hover and the focus ring, but nothing marks them as controls before the
  pointer arrives. A visible affordance (a chevron or a hairline box) would add a second
  visual device to a deliberately flat list, so it is left for the owner to decide.

## Documented exceptions

- The promotion glyph size is `clamp(1.5rem, 5vw, 2.75rem)` and the evaluation label, ply
  column and Elo field have `ch` widths. They size a chess glyph or align digits, not text
  on the scale.
- The king-in-check highlight on the board uses the error tone, because a check is the one
  board state that must be seen at a glance.
- The checkerboard is a `conic-gradient` of two token greys; it is a pattern, not a
  gradient treatment.
