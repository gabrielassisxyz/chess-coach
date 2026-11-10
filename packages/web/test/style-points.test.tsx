import type { MetOpening, RepertoireBranch, RepertoiresResponse } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepertoireMenu } from "../src/components/RepertoireMenu.js";
import {
  type AddedOpening,
  addOpeningToServer,
  addVariationToServer,
  DEFAULT_STYLE_POINTS,
  isDefaultStylePoints,
  moveStylePoint,
  type StylePoints,
  stylePointsLeft,
} from "../src/state/repertoires-api.js";
import { repertoireList } from "./practice-fixtures.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const EVEN: StylePoints = { effectiveness: 2, soundness: 2, learnability: 2 };

const scandinavian: MetOpening = {
  root: ["e4", "d5"],
  opening_name: "Scandinavian Defense",
  games: 3,
  repertoire_id: null,
};

const ITALIAN_LINE = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const D3 = "Giuoco Pianissimo (4.d3)";
const branchAtBc5: RepertoireBranch = {
  group_name: "Italian Game",
  line: [...ITALIAN_LINE, "Bc5"],
  choices: [
    { san: "c3", variation_name: "Classical Variation (4.c3)", repertoire_id: 3 },
    { san: "d3", variation_name: D3, repertoire_id: null },
  ],
};

const listing = (overrides: Partial<RepertoiresResponse> = {}): RepertoiresResponse => ({
  repertoires: repertoireList,
  met: [],
  branches: [],
  ...overrides,
});

function renderMenu(
  answer: RepertoiresResponse,
  adds: {
    addOpening?: (root: readonly string[], points?: StylePoints) => Promise<AddedOpening>;
    addVariation?: (branch: readonly string[], points?: StylePoints) => Promise<AddedOpening>;
  } = {},
) {
  return render(
    <RepertoireMenu
      repertoires={{ status: "ready", value: repertoireList }}
      busy={false}
      starting={null}
      onStart={vi.fn()}
      fetchList={async () => answer}
      addOpening={adds.addOpening ?? (async () => ({ truncated: false }))}
      addVariation={adds.addVariation ?? (async () => ({ truncated: false }))}
    />,
  );
}

const whiteOpenings = (): Promise<HTMLElement> =>
  screen.findByRole("region", { name: "White openings" });

const press = (within_: HTMLElement, name: string) =>
  fireEvent.click(within(within_).getByRole("button", { name }));

const isDisabled = (element: HTMLElement): boolean => (element as HTMLButtonElement).disabled;

// The row of a measure, found by the name it shows.
const rowOf = (white: HTMLElement, label: string): HTMLElement =>
  within(white).getByText(label).closest(".repertoire-menu__points-row") as HTMLElement;

async function openPoints(white: HTMLElement): Promise<void> {
  fireEvent.click(await within(white).findByRole("button", { name: "Style points" }));
}

describe("the style points of the openings menu", () => {
  it("is offered where an opening or a variation can be added, and nowhere else", async () => {
    const { unmount } = renderMenu(listing());
    const white = await whiteOpenings();
    await act(async () => {});
    expect(within(white).queryByRole("button", { name: "Style points" })).toBeNull();
    unmount();

    renderMenu(listing({ met: [scandinavian] }));
    expect(
      await within(await whiteOpenings()).findByRole("button", { name: "Style points" }),
    ).toBeTruthy();
    cleanup();

    renderMenu(listing({ branches: [branchAtBc5] }));
    expect(
      await within(await whiteOpenings()).findByRole("button", { name: "Style points" }),
    ).toBeTruthy();
  });

  it("opens on 2 points for each measure, none left to place", async () => {
    renderMenu(listing({ met: [scandinavian] }));
    const white = await whiteOpenings();
    const toggle = await within(white).findByRole("button", { name: "Style points" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    for (const label of ["More wins", "Less risk", "More intuitive moves"]) {
      expect(rowOf(white, label).textContent).toContain("2");
    }
    expect(
      isDisabled(within(white).getByRole("button", { name: "More points for more wins" })),
    ).toBe(true);
    expect(white.textContent).not.toContain("left to place");
  });

  it("sends an add made with the untouched split exactly as it was sent before", async () => {
    const addOpening = vi.fn(async (_root: readonly string[]) => ({ truncated: false }));
    renderMenu(listing({ met: [scandinavian] }), { addOpening });
    const white = await whiteOpenings();
    fireEvent.click(
      await within(white).findByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    expect(addOpening).toHaveBeenCalledTimes(1);
    expect(addOpening).toHaveBeenCalledWith(["e4", "d5"]);
  });

  it("holds every add until all 6 points are placed, and says how many are left", async () => {
    renderMenu(listing({ met: [scandinavian], branches: [branchAtBc5] }));
    const white = await whiteOpenings();
    await openPoints(white);
    const addOpening = within(white).getByRole("button", {
      name: "Add Scandinavian Defense, 1.e4 d5",
    });
    fireEvent.click(within(white).getByRole("button", { name: "Add a variation" }));
    const addVariation = within(white).getByRole("button", { name: `Add ${D3}` });
    expect(isDisabled(addOpening)).toBe(false);
    expect(isDisabled(addVariation)).toBe(false);

    press(white, "Fewer points for more wins");
    expect(isDisabled(addOpening)).toBe(true);
    expect(isDisabled(addVariation)).toBe(true);
    expect(white.textContent).toContain("1 point left to place");
    press(white, "Fewer points for less risk");
    expect(white.textContent).toContain("2 points left to place");

    press(white, "More points for more intuitive moves");
    press(white, "More points for more intuitive moves");
    expect(isDisabled(addOpening)).toBe(false);
    expect(isDisabled(addVariation)).toBe(false);
    expect(white.textContent).not.toContain("left to place");
  });

  it("holds the points off the other drill starts while they are not all placed", async () => {
    renderMenu(listing({ met: [scandinavian] }));
    const white = await whiteOpenings();
    await openPoints(white);
    press(white, "Fewer points for more wins");
    expect(isDisabled(within(white).getByRole("button", { name: "Recommended 10" }))).toBe(false);
  });

  it("sends the split with an opening that is added, once it is not the default", async () => {
    const addOpening = vi.fn(async (_root: readonly string[], _points?: StylePoints) => ({
      truncated: false,
    }));
    renderMenu(listing({ met: [scandinavian] }), { addOpening });
    const white = await whiteOpenings();
    await openPoints(white);
    press(white, "Fewer points for more wins");
    press(white, "More points for less risk");
    fireEvent.click(
      within(white).getByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    expect(addOpening).toHaveBeenCalledWith(["e4", "d5"], {
      effectiveness: 1,
      soundness: 3,
      learnability: 2,
    });
  });

  it("sends the split with a variation that is added, and keeps it for the next add", async () => {
    const addVariation = vi.fn(async (_branch: readonly string[], _points?: StylePoints) => ({
      truncated: false,
    }));
    renderMenu(listing({ branches: [branchAtBc5] }), { addVariation });
    const white = await whiteOpenings();
    await openPoints(white);
    press(white, "Fewer points for less risk");
    press(white, "More points for more intuitive moves");
    fireEvent.click(within(white).getByRole("button", { name: "Add a variation" }));
    await act(async () => {
      fireEvent.click(within(white).getByRole("button", { name: `Add ${D3}` }));
    });
    expect(addVariation).toHaveBeenCalledWith([...ITALIAN_LINE, "Bc5", "d3"], {
      effectiveness: 2,
      soundness: 1,
      learnability: 3,
    });
  });

  it("says in the collapsed control that the split is not the default", async () => {
    renderMenu(listing({ met: [scandinavian] }));
    const white = await whiteOpenings();
    await openPoints(white);
    press(white, "Fewer points for more wins");
    press(white, "More points for less risk");
    fireEvent.click(within(white).getByRole("button", { name: "Style points" }));
    expect(within(white).queryByText("Moves that score best for White at your level")).toBeNull();
    expect(white.textContent).toContain("More wins 1, Less risk 3, More intuitive moves 2");
  });

  it("never takes a measure under 0 or the split over 6", async () => {
    renderMenu(listing({ met: [scandinavian] }));
    const white = await whiteOpenings();
    await openPoints(white);
    press(white, "Fewer points for more wins");
    press(white, "Fewer points for more wins");
    const fewer = within(white).getByRole("button", { name: "Fewer points for more wins" });
    expect(isDisabled(fewer)).toBe(true);
    const more = within(white).getByRole("button", { name: "More points for less risk" });
    expect(isDisabled(more)).toBe(false);
    press(white, "More points for less risk");
    press(white, "More points for less risk");
    expect(isDisabled(more)).toBe(true);
    expect(rowOf(white, "Less risk").textContent).toContain("4");
  });
});

describe("the split of style points", () => {
  it("starts at 2 each, with 6 points in all", () => {
    expect(DEFAULT_STYLE_POINTS).toEqual(EVEN);
    expect(stylePointsLeft(EVEN)).toBe(0);
    expect(isDefaultStylePoints(EVEN)).toBe(true);
    expect(isDefaultStylePoints({ effectiveness: 1, soundness: 3, learnability: 2 })).toBe(false);
  });

  it("moves a point only off a measure that has one and onto the split only where one is left", () => {
    const taken = moveStylePoint(EVEN, "soundness", -1);
    expect(taken).toEqual({ effectiveness: 2, soundness: 1, learnability: 2 });
    expect(stylePointsLeft(taken)).toBe(1);
    expect(moveStylePoint(taken, "effectiveness", 1)).toEqual({
      effectiveness: 3,
      soundness: 1,
      learnability: 2,
    });
    expect(moveStylePoint(EVEN, "effectiveness", 1)).toBe(EVEN);
    const empty = { effectiveness: 0, soundness: 6, learnability: 0 };
    expect(moveStylePoint(empty, "effectiveness", -1)).toBe(empty);
  });
});

describe("the call behind the style points", () => {
  const answering = () => {
    const fetched = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ repertoire: { truncated: false } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetched);
    return fetched;
  };
  const bodyOf = (fetched: ReturnType<typeof answering>): unknown =>
    JSON.parse(String(fetched.mock.calls[0]?.[1]?.body));

  it("posts the points with a root and with a branch when they are given", async () => {
    const fetched = answering();
    const points = { effectiveness: 0, soundness: 6, learnability: 0 };
    await addOpeningToServer(["e4", "d5"], points);
    expect(bodyOf(fetched)).toEqual({ sources: ["repertoire"], root: ["e4", "d5"], points });
    fetched.mockClear();
    await addVariationToServer([...ITALIAN_LINE, "Bc5", "d3"], points);
    expect(bodyOf(fetched)).toEqual({
      sources: ["repertoire"],
      branch: [...ITALIAN_LINE, "Bc5", "d3"],
      points,
    });
  });

  it("posts no points when none are given, and the server applies its default", async () => {
    const fetched = answering();
    await addOpeningToServer(["e4", "d5"]);
    expect(bodyOf(fetched)).toEqual({ sources: ["repertoire"], root: ["e4", "d5"] });
  });
});
