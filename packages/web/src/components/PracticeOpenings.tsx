import type { RepertoireLevel, RepertoireScope, RepertoiresResponse } from "@chess-coach/shared";
import { useEffect, useId, useRef, useState } from "react";
import {
  OPENINGS_FILTERS,
  type OpeningsFilter,
  type OpeningsSectionModel,
  type RepertoireStarting,
  SIDE_HEADING,
  sectionAnchorOf,
  sectionSummaryText,
  sectionsOf,
} from "../state/openings-page.js";
import {
  type AddOpening,
  type AddVariation,
  addOpeningToServer,
  addVariationToServer,
  DEFAULT_STYLE_POINTS,
  type FetchAddableOpenings,
  type FetchCoverage,
  type FetchRepertoireList,
  fetchAddableOpeningsFromServer,
  fetchRepertoireListFromServer,
  type StylePoints,
  stylePointsLeft,
} from "../state/repertoires-api.js";
import { OpeningCard, type VariationAdder } from "./OpeningCard.js";
import { PracticeAddOpening } from "./PracticeAddOpening.js";
import { AddStatus, type OpeningAdds, useOpeningAdds, withStylePoints } from "./RepertoireMenu.js";
import { TrainButton, type TrainControls } from "./TrainButton.js";

export interface PracticeOpeningsProps {
  // Any start is in flight, from this page or another: every train button waits.
  busy: boolean;
  // The start this page sent, whose button says so.
  starting: RepertoireStarting | null;
  // A start of one variation names no level; an opening or a colour names its level.
  onStart(repertoireId: number, scope: RepertoireScope, level?: RepertoireLevel): void;
  // Where the answer comes from, and what builds an opening or a variation; the server's by default.
  fetchList?: FetchRepertoireList | undefined;
  addOpening?: AddOpening | undefined;
  addVariation?: AddVariation | undefined;
  // Where the list of every opening that can be added comes from, read when its panel opens; the
  // server's by default.
  fetchAddable?: FetchAddableOpenings | undefined;
  // Where a variation's coverage comes from when it is opened; the server's by default.
  fetchCoverage?: FetchCoverage | undefined;
}

// What every part of the page shares: what the train buttons wait for, the state of the adds, and
// the calls that build an opening or a variation, which carry the student's style points.
interface OpeningsContext {
  train: TrainControls;
  adds: OpeningAdds;
  // A start is in flight or the style points are not all placed yet, so no add can run.
  addsBusy: boolean;
  addOpening: AddOpening;
  fetchAddable: FetchAddableOpenings;
  adder: VariationAdder;
  fetchCoverage: FetchCoverage | undefined;
}

function SideControl({
  filter,
  onFilter,
}: {
  filter: OpeningsFilter;
  onFilter(filter: OpeningsFilter): void;
}) {
  return (
    <div className="segmented openings-side" role="radiogroup" aria-label="Openings shown">
      {OPENINGS_FILTERS.map(({ value, label }) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control is a row of buttons; the radio semantics are what it means
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={value === filter}
          className="segmented__option"
          onClick={() => onFilter(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// The button that opens the panel of openings to add, which takes its place while it is open. The
// sentences of a run in flight stay under it, so closing the panel leaves them where the student
// looks for them.
function AddOpeningArea({ ctx }: { ctx: OpeningsContext }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);

  // Closing removes the button that held the focus, so the one that returns takes it.
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    opener.current?.focus();
  }, [open]);

  return (
    <div className="openings-add">
      {open ? (
        <PracticeAddOpening
          adds={ctx.adds}
          busy={ctx.addsBusy}
          addOpening={ctx.addOpening}
          fetchAddable={ctx.fetchAddable}
          points={ctx.adder.points}
          onPoints={ctx.adder.onPoints}
          onClose={() => {
            refocus.current = true;
            setOpen(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="button openings-add__open"
          ref={opener}
          onClick={() => setOpen(true)}
        >
          Add an opening…
        </button>
      )}
      <AddStatus adds={ctx.adds} origin="met" />
    </div>
  );
}

// A colour with no opening keeps its place on the page and says so, in a box that is not a card.
function EmptySection({ side }: { side: OpeningsSectionModel["side"] }) {
  return (
    <p className="openings-empty">
      {side === "white"
        ? "No opening is stored yet."
        : "No Black line yet. The app does not build Black lines yet."}
    </p>
  );
}

function OpeningsSection({
  section,
  hidden,
  ctx,
}: {
  section: OpeningsSectionModel;
  hidden: boolean;
  ctx: OpeningsContext;
}) {
  const headingId = useId();
  const { side, openings, moves } = section;
  const anchor = sectionAnchorOf(section);
  const name = `every ${SIDE_HEADING[side]} opening`;
  return (
    <section className="openings-section" aria-labelledby={headingId} hidden={hidden}>
      <div className="openings-section__head">
        <h3 className="openings-section__title" id={headingId}>
          {SIDE_HEADING[side]}
        </h3>
        <span className="openings-section__summary">{sectionSummaryText(section)}</span>
        {openings.length > 1 && moves !== null && anchor !== null ? (
          <TrainButton
            counts={moves}
            target={{ repertoireId: anchor, level: "side", name }}
            forSide
            {...ctx.train}
          />
        ) : null}
      </div>
      {openings.length === 0 ? <EmptySection side={side} /> : null}
      {openings.map((opening) => (
        <OpeningCard
          key={opening.group.group_name}
          opening={opening}
          train={ctx.train}
          adder={ctx.adder}
          fetchCoverage={ctx.fetchCoverage}
        />
      ))}
      {side === "white" ? <AddOpeningArea ctx={ctx} /> : null}
    </section>
  );
}

function OpeningsHead({
  filter,
  onFilter,
}: {
  filter: OpeningsFilter;
  onFilter(filter: OpeningsFilter): void;
}) {
  return (
    <div className="openings-head">
      <div className="openings-head__titles">
        <h2 className="screen__title">Openings</h2>
        <p className="screen__note">Your lines from move 1, each move on its own schedule.</p>
      </div>
      <SideControl filter={filter} onFilter={onFilter} />
    </div>
  );
}

// The student's stored lines, a card for each opening under its colour. Every card trains what is
// recommended and offers the other scopes beside it; a card opens to its variations, each with the
// same figures and a button of its own. Adding an opening or a variation is the page's too: the
// run takes minutes, so the page, which stays mounted under the hub, is what remembers it.
export function PracticeOpenings({
  busy,
  starting,
  onStart,
  fetchList = fetchRepertoireListFromServer,
  addOpening = addOpeningToServer,
  addVariation = addVariationToServer,
  fetchAddable = fetchAddableOpeningsFromServer,
  fetchCoverage,
}: PracticeOpeningsProps) {
  const adds = useOpeningAdds(fetchList);
  const [filter, setFilter] = useState<OpeningsFilter>("all");
  const [points, setPoints] = useState<StylePoints>({ ...DEFAULT_STYLE_POINTS });
  const listing: RepertoiresResponse | null = adds.listing;
  const addsBusy = busy || stylePointsLeft(points) !== 0;
  const variationName = (id: number): string | null =>
    listing?.repertoires.find((variation) => variation.id === id)?.variation_name ?? null;
  const ctx: OpeningsContext = {
    train: { disabled: busy || adds.adding !== null, starting, onStart },
    adds,
    addsBusy,
    addOpening: withStylePoints(addOpening, points),
    fetchAddable,
    adder: {
      choices: {
        adds,
        busy: addsBusy,
        addVariation: withStylePoints(addVariation, points),
        variationName,
      },
      points,
      onPoints: setPoints,
    },
    fetchCoverage,
  };

  return (
    <>
      <OpeningsHead filter={filter} onFilter={setFilter} />
      <div className="openings-body">
        {adds.loading ? (
          <p className="practice__card-note" role="status">
            Loading your openings.
          </p>
        ) : null}
        {adds.unreadable ? (
          <>
            <p className="practice__failure" role="alert">
              Your openings could not be loaded.
            </p>
            <div className="controls__row">
              <button type="button" className="button" onClick={adds.retry}>
                Try again
              </button>
            </div>
          </>
        ) : null}
        {listing === null
          ? null
          : sectionsOf(listing).map((section) => (
              <OpeningsSection
                key={section.side}
                section={section}
                hidden={filter !== "all" && filter !== section.side}
                ctx={ctx}
              />
            ))}
      </div>
    </>
  );
}
