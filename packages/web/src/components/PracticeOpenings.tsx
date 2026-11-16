import type { RepertoireLevel, RepertoireScope, RepertoiresResponse } from "@chess-coach/shared";
import { useEffect, useId, useRef, useState } from "react";
import { type LineRebuild, rebuildNamesLine, useLineRebuild } from "../state/line-rebuild.js";
import {
  type FetchOpeningPuzzles,
  fetchOpeningPuzzlesFromServer,
  openingPuzzleNamesOf,
} from "../state/opening-puzzles-api.js";
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
  fetchCoverageFromServer,
  fetchRepertoireListFromServer,
  type RebuildLine,
  rebuildLineOnServer,
  type StylePoints,
  stylePointsLeft,
} from "../state/repertoires-api.js";
import { OpeningCard, type VariationAdder } from "./OpeningCard.js";
import { PracticeAddOpening } from "./PracticeAddOpening.js";
import { PracticeLine } from "./PracticeLine.js";
import { PracticeOpeningPuzzles } from "./PracticeOpeningPuzzles.js";
import { AddStatus, type OpeningAdds, useOpeningAdds, withStylePoints } from "./RepertoireMenu.js";
import { TrainButton, type TrainControls } from "./TrainButton.js";

// The block of Lichess puzzles under each colour's openings. A page given none draws none.
export interface OpeningPuzzlesControls {
  // Where the puzzles of each opening are counted, once for each colour; the server's by default.
  fetchPuzzles?: FetchOpeningPuzzles | undefined;
  // Starts the puzzles of the Lichess opening tag a tile names.
  onStart(tag: string): void;
  // The tag of the puzzle start this page sent, whose tile says so.
  starting: string | null;
  engineMissing: boolean;
}

// The line's page: the variation open on it, or null for the list, and how a variation's name opens
// it and the breadcrumb closes it. A page given none draws the names as text.
export interface LinePageControls {
  open: number | null;
  onOpen(id: number): void;
  onClose(): void;
}

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
  // Where a variation's coverage comes from when its page opens; the server's by default.
  fetchCoverage?: FetchCoverage | undefined;
  lines?: LinePageControls | undefined;
  // What walks a variation again from its page; the server's by default.
  rebuildLine?: RebuildLine | undefined;
  openingPuzzles?: OpeningPuzzlesControls | undefined;
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
  // The variation a rebuild is walking, from the list or from the line's page; null when none is.
  rebuildingId: number | null;
  onOpenLine: ((id: number) => void) | undefined;
  puzzles: OpeningPuzzlesControls | null;
  // The openings opponents played in the student's games, which White's puzzle block draws from.
  met: RepertoiresResponse["met"];
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

// The Lichess puzzles of a colour's openings, under its cards. A colour with no stored opening has
// none, as it has no card, so the block never stands alone under an empty section.
function OpeningPuzzlesArea({
  section,
  ctx,
}: {
  section: OpeningsSectionModel;
  ctx: OpeningsContext;
}) {
  const { puzzles } = ctx;
  if (puzzles === null || section.openings.length === 0) return null;
  return (
    <PracticeOpeningPuzzles
      names={openingPuzzleNamesOf(section, ctx.met)}
      fetchPuzzles={puzzles.fetchPuzzles ?? fetchOpeningPuzzlesFromServer}
      busy={ctx.train.disabled}
      engineMissing={puzzles.engineMissing}
      startingTag={puzzles.starting}
      onStart={puzzles.onStart}
    />
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
          rebuildingId={ctx.rebuildingId}
          onOpenLine={ctx.onOpenLine}
        />
      ))}
      {side === "white" ? <AddOpeningArea ctx={ctx} /> : null}
      <OpeningPuzzlesArea section={section} ctx={ctx} />
    </section>
  );
}

function OpeningsHead({
  filter,
  onFilter,
  hidden,
}: {
  filter: OpeningsFilter;
  onFilter(filter: OpeningsFilter): void;
  hidden: boolean;
}) {
  return (
    <div className="openings-head" hidden={hidden}>
      <div className="openings-head__titles">
        <h2 className="screen__title">Openings</h2>
        <p className="screen__note">Your lines from move 1, each move on its own schedule.</p>
      </div>
      <SideControl filter={filter} onFilter={onFilter} />
    </div>
  );
}

// The page of the variation the student opened, read off the list this page holds. A variation the
// list no longer holds is told so, with the way back.
function LineArea({
  listing,
  id,
  ctx,
  fetchCoverage,
  rebuild,
  onBack,
}: {
  listing: RepertoiresResponse;
  id: number;
  ctx: OpeningsContext;
  fetchCoverage: FetchCoverage;
  rebuild: LineRebuild;
  onBack(): void;
}) {
  const variation = listing.repertoires.find((entry) => entry.id === id);
  const group = variation
    ? listing.repertoires.filter(
        (entry) => entry.side === variation.side && entry.group_name === variation.group_name,
      )
    : [];
  return (
    <PracticeLine
      variation={variation}
      rebuildable={variation === undefined || rebuildNamesLine(variation, group)}
      rebuildingId={ctx.rebuildingId}
      train={ctx.train}
      fetchCoverage={fetchCoverage}
      rebuild={rebuild}
      onBack={onBack}
    />
  );
}

// The student's stored lines, a card for each opening under its colour. Every card trains what is
// recommended and offers the other scopes beside it; a card opens to its variations, each with the
// same figures and a button of its own, and a variation's name opens the page of that line in the
// list's place. Adding an opening or a variation, and rebuilding a line, are the page's too: the
// run takes minutes, so the page, which stays mounted under the hub, is what remembers it.
export function PracticeOpenings({
  busy,
  starting,
  onStart,
  fetchList = fetchRepertoireListFromServer,
  addOpening = addOpeningToServer,
  addVariation = addVariationToServer,
  fetchAddable = fetchAddableOpeningsFromServer,
  fetchCoverage = fetchCoverageFromServer,
  lines,
  rebuildLine = rebuildLineOnServer,
  openingPuzzles,
}: PracticeOpeningsProps) {
  const adds = useOpeningAdds(fetchList);
  const rebuild = useLineRebuild(rebuildLine, adds.refresh);
  const [filter, setFilter] = useState<OpeningsFilter>("all");
  const [points, setPoints] = useState<StylePoints>({ ...DEFAULT_STYLE_POINTS });
  const listing: RepertoiresResponse | null = adds.listing;
  const addsBusy = busy || stylePointsLeft(points) !== 0;
  const variationName = (id: number): string | null =>
    listing?.repertoires.find((variation) => variation.id === id)?.variation_name ?? null;
  // Reading the list as the page opens is what lets it find a rebuild another tab started, and an
  // ending from before it was left is not shown on it again.
  const openLine = (id: number): void => {
    rebuild.dismiss();
    void adds.refresh();
    lines?.onOpen(id);
  };
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
    rebuildingId: rebuild.running ?? listing?.rebuilding_id ?? null,
    onOpenLine: lines === undefined ? undefined : openLine,
    puzzles: openingPuzzles ?? null,
    met: listing?.met ?? [],
  };
  // The list stays mounted under the line's page, so what it holds survives going back to it.
  const openId = lines?.open ?? null;
  const line = openId !== null && listing !== null ? { id: openId, listing } : null;

  return (
    <>
      <OpeningsHead filter={filter} onFilter={setFilter} hidden={line !== null} />
      <div className="openings-body" hidden={line !== null}>
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
      {line === null || lines === undefined ? null : (
        <LineArea
          key={line.id}
          listing={line.listing}
          id={line.id}
          ctx={ctx}
          fetchCoverage={fetchCoverage}
          rebuild={rebuild}
          onBack={lines.onClose}
        />
      )}
    </>
  );
}
