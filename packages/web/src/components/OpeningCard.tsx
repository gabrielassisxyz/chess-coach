import type { RepertoireBranch, RepertoireSummary } from "@chess-coach/shared";
import { type ReactNode, useId, useState } from "react";
import {
  type FigureValues,
  figureValuesOf,
  type OpeningCardModel,
  openingMetaText,
} from "../state/openings-page.js";
import { NONE } from "../state/practice.js";
import {
  branchesOf,
  branchKey,
  levelAnchorOf,
  type StylePoints,
} from "../state/repertoires-api.js";
import {
  AddStatus,
  BranchChoices,
  type ChoiceContext,
  StylePointsControl,
} from "./RepertoireMenu.js";
import { ChevronIcon, TrainButton, type TrainControls } from "./TrainButton.js";

// What the card needs to offer another variation of its opening: the state of the adds, the call
// that builds one, and the split of style points it is built by.
export interface VariationAdder {
  choices: ChoiceContext;
  points: StylePoints;
  onPoints(points: StylePoints): void;
}

function Figure({
  label,
  detail,
  accent = false,
  children,
}: {
  label: string;
  detail?: string | undefined;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="opening-figure">
      <span className="opening-figure__label">
        {label}
        {detail === undefined ? null : ` · ${detail}`}
      </span>
      <span
        className={
          accent ? "opening-figure__value opening-figure__accent" : "opening-figure__value"
        }
      >
        {children}
      </span>
    </div>
  );
}

// The share of the games that reached the line in which the student stayed in it, as a bar under the
// count. A line no game reached has no share to draw, so its cell holds the no-value dash and no bar.
function InLineFigure({ values }: { values: FigureValues }) {
  const share = values.inLineShare;
  return (
    <Figure label="In line" detail={share === null ? undefined : values.inLineText}>
      {share === null ? (
        NONE
      ) : (
        <span className="opening-figure__bar" aria-hidden="true">
          <span className="opening-figure__fill" style={{ width: `${share * 100}%` }} />
        </span>
      )}
    </Figure>
  );
}

// The five cells of a card or a row, laid out by the grid that holds them.
function OpeningFigures({ values }: { values: FigureValues }) {
  return (
    <>
      <Figure label="Moves">{values.moves}</Figure>
      <Figure label="Due now" accent={values.due > 0}>
        {values.due}
      </Figure>
      <Figure label="Remembered, 30 days">{values.remembered}</Figure>
      <InLineFigure values={values} />
      <Figure label="Coverage">{values.coverage}</Figure>
    </>
  );
}

// The name opens the variation's own page, where its coverage is read. A page given no way to open
// one draws the name as text. A variation being rebuilt says so and trains as before, since its old
// moves serve until the rebuild ends.
function VariationRow({
  variation,
  rebuilding,
  train,
  onOpenLine,
}: {
  variation: RepertoireSummary;
  rebuilding: boolean;
  train: TrainControls;
  onOpenLine: ((id: number) => void) | undefined;
}) {
  const name = variation.variation_name;
  return (
    <div className="opening-row">
      <div className="opening-row__title">
        <div className="opening-row__heading">
          {onOpenLine === undefined ? (
            <span className="opening-row__name">{name}</span>
          ) : (
            <button
              type="button"
              className="opening-row__name"
              onClick={() => onOpenLine(variation.id)}
            >
              {name}
            </button>
          )}
          {rebuilding ? <span className="opening-row__rebuilding">Being rebuilt</span> : null}
        </div>
        {variation.line ? <span className="opening-row__line">{variation.line}</span> : null}
      </div>
      <div className="opening-row__cells">
        <OpeningFigures values={figureValuesOf(variation)} />
        <TrainButton
          counts={variation.moves}
          target={{ repertoireId: variation.id, level: "variation", name }}
          compact
          {...train}
        />
      </div>
    </div>
  );
}

// A choice can be added when no variation plays it yet, or when the run that built it stopped short.
function offersVariation(
  branches: readonly RepertoireBranch[],
  unfinished: ReadonlySet<string>,
): boolean {
  return branches.some((branch) =>
    branch.choices.some(
      (choice) =>
        choice.repertoire_id === null || unfinished.has(branchKey(branch.line, choice.san)),
    ),
  );
}

export interface OpeningCardProps {
  opening: OpeningCardModel;
  train: TrainControls;
  adder: VariationAdder;
  // The variation a rebuild is walking, from the list or from the line's page; null when none is.
  rebuildingId: number | null;
  // Opens a variation's own page; a card given none draws the names as text.
  onOpenLine: ((id: number) => void) | undefined;
}

// One opening: its name and moves, what it would train, five figures, and under its head, once
// opened, a row for each variation. Adding a variation opens the book's positions under the head.
export function OpeningCard({ opening, train, adder, rebuildingId, onOpenLine }: OpeningCardProps) {
  const { group, variations } = opening;
  const name = group.group_name;
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const rowsId = useId();
  const metaId = useId();
  const { adds } = adder.choices;
  const anchor = levelAnchorOf(variations);
  const branches = branchesOf(adds.listing?.branches, name);
  const addable = offersVariation(branches, adds.unfinished);

  return (
    <article className="opening-card" aria-label={name}>
      <div className="opening-card__head">
        <button
          type="button"
          className="opening-card__toggle"
          aria-expanded={open}
          aria-controls={open ? rowsId : undefined}
          aria-label={name}
          aria-describedby={metaId}
          onClick={() => setOpen(!open)}
        >
          <ChevronIcon className="opening-card__chevron" />
          <span className="opening-card__name">{name}</span>
          <span className="opening-card__meta" id={metaId}>
            {openingMetaText(variations.length, group.line)}
          </span>
        </button>
        <div className="opening-card__actions">
          {addable ? (
            <button
              type="button"
              className="button opening-card__add"
              aria-expanded={choosing}
              onClick={() => setChoosing(!choosing)}
            >
              + Add a variation
            </button>
          ) : null}
          {anchor === null ? null : (
            <TrainButton
              counts={group.moves}
              target={{ repertoireId: anchor, level: "group", name }}
              {...train}
            />
          )}
        </div>
      </div>
      {branches.length === 0 ? null : (
        <div className="opening-card__adder">
          {addable && choosing ? (
            <>
              <BranchChoices branches={branches} {...adder.choices} />
              <StylePointsControl points={adder.points} onChange={adder.onPoints} />
            </>
          ) : null}
          <AddStatus adds={adds} origin="branch" />
        </div>
      )}
      <div className="opening-card__figures">
        <OpeningFigures values={figureValuesOf(group)} />
      </div>
      {open ? (
        <div className="opening-card__rows" id={rowsId}>
          {variations.map((variation) => (
            <VariationRow
              key={variation.id}
              variation={variation}
              rebuilding={variation.id === rebuildingId}
              train={train}
              onOpenLine={onOpenLine}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}
