import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  RepertoireGroupSummary,
  RepertoireSummary,
  RepertoiresResponse,
} from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PracticeOpenings,
  type PracticeOpeningsProps,
} from "../src/components/PracticeOpenings.js";
import {
  figureValuesOf,
  openingMetaText,
  sectionSummaryText,
  sectionsOf,
  trainButtonOf,
} from "../src/state/openings-page.js";
import { NONE } from "../src/state/practice.js";

afterEach(cleanup);

const ITALIAN_LINE = "1.e4 e5 2.Nf3 Nc6 3.Bc4";

const pianissimo: RepertoireSummary = {
  id: 4,
  side: "white",
  group_name: "Italian Game",
  variation_name: "Giuoco Pianissimo (4.d3)",
  moves: { recommended: 2, due: 3, all: 24 },
  moves_total: 24,
  remembered_30d: { right: 5, of: 7 },
  in_line: { stayed: 16, of: 20 },
  covered_percent: 100,
  line: "3...Bc5 4.d3",
};
const twoKnights: RepertoireSummary = {
  id: 5,
  side: "white",
  group_name: "Italian Game",
  variation_name: "Two Knights Defense (4.Ng5)",
  moves: { recommended: 3, due: 5, all: 15 },
  moves_total: 15,
  remembered_30d: { right: 11, of: 21 },
  in_line: { stayed: 6, of: 10 },
  covered_percent: 87,
  line: null,
};
const kingsPawn: RepertoireSummary = {
  id: 6,
  side: "white",
  group_name: "King's Pawn Game",
  variation_name: "Ponziani Opening (3.c3)",
  moves: { recommended: 0, due: 0, all: 3 },
  moves_total: 3,
  remembered_30d: { right: 2, of: 2 },
  in_line: { stayed: 2, of: 2 },
  covered_percent: 63.6,
  line: "2...Nc6 3.c3",
};
const sicilian: RepertoireSummary = {
  id: 7,
  side: "black",
  group_name: "Sicilian Defense",
  variation_name: "Open Sicilian (3.d4)",
  moves: { recommended: 4, due: 6, all: 12 },
  moves_total: 12,
  remembered_30d: { right: 0, of: 0 },
  in_line: { stayed: 0, of: 0 },
  covered_percent: null,
  line: null,
};

const italianGroup: RepertoireGroupSummary = {
  side: "white",
  group_name: "Italian Game",
  moves: { recommended: 5, due: 8, all: 39 },
  moves_total: 39,
  remembered_30d: { right: 7, of: 11 },
  in_line: { stayed: 22, of: 30 },
  covered_percent: 100,
  line: ITALIAN_LINE,
};
const kingsPawnGroup: RepertoireGroupSummary = {
  side: "white",
  group_name: "King's Pawn Game",
  moves: { recommended: 0, due: 0, all: 3 },
  moves_total: 3,
  remembered_30d: { right: 2, of: 2 },
  in_line: { stayed: 2, of: 2 },
  covered_percent: 63.6,
  line: "1.e4 e5 2.Nf3 Nc6",
};

// The two White openings of the approved screen: an Italian Game with two variations and a King's
// Pawn Game with one and nothing recommended.
const answer = (overrides: Partial<RepertoiresResponse> = {}): RepertoiresResponse => ({
  repertoires: [pianissimo, twoKnights, kingsPawn],
  groups: [italianGroup, kingsPawnGroup],
  sides: [{ side: "white", moves: { recommended: 7, due: 9, all: 42 } }],
  met: [],
  branches: [],
  ...overrides,
});

function renderPage(
  listed: RepertoiresResponse | (() => Promise<RepertoiresResponse>) = answer(),
  props: Partial<PracticeOpeningsProps> = {},
) {
  const onStart = vi.fn();
  const fetchList = typeof listed === "function" ? listed : async () => listed;
  render(
    <PracticeOpenings
      busy={false}
      starting={null}
      onStart={onStart}
      fetchList={fetchList}
      {...props}
    />,
  );
  return { onStart };
}

const section = (name: string): Promise<HTMLElement> => screen.findByRole("region", { name });
const card = (name: string): Promise<HTMLElement> => screen.findByRole("article", { name });
const pickSide = (name: string): void => {
  fireEvent.click(screen.getByRole("radio", { name }));
};
const isDisabled = (element: HTMLElement): boolean => (element as HTMLButtonElement).disabled;

// The label and the value of each cell of a grid of figures.
const cellsOf = (grid: Element | null): string[][] =>
  [...(grid?.querySelectorAll(".opening-figure") ?? [])].map((cell) => [
    cell.querySelector(".opening-figure__label")?.textContent ?? "",
    cell.querySelector(".opening-figure__value")?.textContent ?? "",
  ]);
const cardCells = (opening: HTMLElement): string[][] =>
  cellsOf(opening.querySelector(".opening-card__figures"));

describe("the header and the side control", () => {
  it("shows the title, the subtitle and a control of All, As White and As Black with All chosen", async () => {
    renderPage();
    await section("White");
    expect(screen.getByRole("heading", { level: 2, name: "Openings" })).toBeTruthy();
    expect(screen.getByText("Your lines from move 1, each move on its own schedule.")).toBeTruthy();
    const control = screen.getByRole("radiogroup", { name: "Openings shown" });
    expect(
      within(control)
        .getAllByRole("radio")
        .map((option) => [option.textContent, option.getAttribute("aria-checked")]),
    ).toEqual([
      ["All", "true"],
      ["As White", "false"],
      ["As Black", "false"],
    ]);
  });

  it("shows both sections, the White one alone or the Black one alone as the control is set", async () => {
    renderPage(
      answer({
        repertoires: [pianissimo, sicilian],
        groups: [italianGroup, { ...italianGroup, side: "black", group_name: "Sicilian Defense" }],
      }),
    );
    await section("White");
    expect(screen.getByRole("region", { name: "Black" })).toBeTruthy();

    pickSide("As White");
    expect(screen.getByRole("radio", { name: "As White" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("region", { name: "White" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Black" })).toBeNull();

    pickSide("As Black");
    expect(screen.queryByRole("region", { name: "White" })).toBeNull();
    expect(screen.getByRole("region", { name: "Black" })).toBeTruthy();

    pickSide("All");
    expect(screen.getByRole("region", { name: "White" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Black" })).toBeTruthy();
  });

  it("keeps a card open through a change of the side shown, since the other section stays mounted", async () => {
    renderPage();
    const italian = await card("Italian Game");
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    pickSide("As Black");
    pickSide("All");
    expect(
      within(screen.getByRole("article", { name: "Italian Game" }))
        .getByRole("button", { name: "Italian Game" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("the sections", () => {
  it("writes the number of openings and the moves due beside White, in the singular for one", async () => {
    renderPage();
    const white = await section("White");
    expect(within(white).getByText("2 openings · 9 due")).toBeTruthy();
    cleanup();

    renderPage(
      answer({
        repertoires: [pianissimo, twoKnights],
        groups: [italianGroup],
        sides: [{ side: "white", moves: { recommended: 5, due: 8, all: 39 } }],
      }),
    );
    expect(within(await section("White")).getByText("1 opening · 8 due")).toBeTruthy();
  });

  it("draws the train button of a colour only with more than one opening, as Train all with the recommended moves", async () => {
    const { onStart } = renderPage();
    const white = await section("White");
    const train = within(white).getByRole("button", { name: "Train all · 7, every White opening" });
    expect(train.textContent).toBe("Train all · 7");
    fireEvent.click(train);
    expect(onStart).toHaveBeenCalledWith(4, "recommended", "side");
    cleanup();

    renderPage(answer({ repertoires: [pianissimo, twoKnights], groups: [italianGroup] }));
    expect(within(await section("White")).queryByRole("button", { name: /^Train all/ })).toBeNull();
  });

  it("keeps the Black section with no line yet, with one sentence in a box", async () => {
    renderPage();
    const black = await section("Black");
    expect(within(black).getByText("no line yet")).toBeTruthy();
    const sentence = within(black).getByText(
      "No Black line yet. The app does not build Black lines yet.",
    );
    expect(sentence.className).toBe("openings-empty");
    expect(within(black).queryByRole("button")).toBeNull();
    expect(within(black).queryByRole("article")).toBeNull();
  });

  it("keeps the White section with no opening stored, with its sentence and no button", async () => {
    renderPage(answer({ repertoires: [], groups: [], sides: [] }));
    const white = await section("White");
    expect(within(white).getByText("No opening is stored yet.")).toBeTruthy();
    expect(within(white).getByText("no line yet")).toBeTruthy();
    expect(within(white).queryByRole("button")).toBeNull();
  });

  it("draws a Black opening as a card in the Black section", async () => {
    renderPage(
      answer({
        repertoires: [sicilian],
        groups: [{ ...italianGroup, side: "black", group_name: "Sicilian Defense" }],
        sides: [{ side: "black", moves: { recommended: 4, due: 6, all: 12 } }],
      }),
    );
    const black = await section("Black");
    expect(within(black).getByRole("article", { name: "Sicilian Defense" })).toBeTruthy();
    expect(within(black).getByText("1 opening · 6 due")).toBeTruthy();
    expect(within(black).queryByText(/No Black line yet/)).toBeNull();
    expect(within(await section("White")).queryByRole("article")).toBeNull();
  });
});

describe("an opening's card", () => {
  it("shows its name, its variations and its line, and a card of one variation in the singular", async () => {
    renderPage();
    const italian = await card("Italian Game");
    expect(within(italian).getByText(`2 variations · ${ITALIAN_LINE}`)).toBeTruthy();
    const kings = screen.getByRole("article", { name: "King's Pawn Game" });
    expect(within(kings).getByText("1 variation · 1.e4 e5 2.Nf3 Nc6")).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("shows the five cells from the opening's own figures", async () => {
    renderPage();
    const italian = await card("Italian Game");
    expect(cardCells(italian)).toEqual([
      ["Moves", "39"],
      ["Due now", "8"],
      ["Remembered, 30 days", "64%"],
      ["In line · 22 of 30 games", ""],
      ["Coverage", "100%"],
    ]);
    const kings = screen.getByRole("article", { name: "King's Pawn Game" });
    expect(cardCells(kings)).toEqual([
      ["Moves", "3"],
      ["Due now", "0"],
      ["Remembered, 30 days", "100%"],
      ["In line · 2 of 2 games", ""],
      ["Coverage", "64%"],
    ]);
  });

  it("draws the games stayed in as a bar of that share, and a game of one in the singular", async () => {
    renderPage(
      answer({
        repertoires: [pianissimo],
        groups: [{ ...italianGroup, in_line: { stayed: 1, of: 1 } }],
      }),
    );
    const italian = await card("Italian Game");
    const fill = italian.querySelector(".opening-card__figures .opening-figure__fill");
    expect((fill as HTMLElement).style.width).toBe("100%");
    expect(within(italian).getByText("In line · 1 of 1 game")).toBeTruthy();
    cleanup();

    renderPage();
    const bar = (await card("Italian Game")).querySelector(
      ".opening-card__figures .opening-figure__fill",
    );
    expect(Number.parseFloat((bar as HTMLElement).style.width)).toBeCloseTo(73.33, 1);
  });

  it("shows the no-value dash and no bar for the cells nothing was measured for", async () => {
    renderPage(
      answer({
        repertoires: [pianissimo],
        groups: [
          {
            ...italianGroup,
            remembered_30d: { right: 0, of: 0 },
            in_line: { stayed: 0, of: 0 },
            covered_percent: null,
          },
        ],
      }),
    );
    const italian = await card("Italian Game");
    expect(cardCells(italian)).toEqual([
      ["Moves", "39"],
      ["Due now", "8"],
      ["Remembered, 30 days", NONE],
      ["In line", NONE],
      ["Coverage", NONE],
    ]);
    expect(italian.querySelector(".opening-card__figures .opening-figure__bar")).toBeNull();
  });

  it("marks the due count in the accent colour above 0 and in no colour at 0", async () => {
    renderPage();
    const accented = (opening: HTMLElement): boolean =>
      opening
        .querySelector(".opening-card__figures .opening-figure:nth-child(2) .opening-figure__value")
        ?.classList.contains("opening-figure__accent") ?? false;
    expect(accented(await card("Italian Game"))).toBe(true);
    expect(accented(screen.getByRole("article", { name: "King's Pawn Game" }))).toBe(false);
  });

  it("starts closed, shows a row for each variation once opened and hides them again", async () => {
    renderPage();
    const italian = await card("Italian Game");
    const head = within(italian).getByRole("button", { name: "Italian Game" });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(within(italian).queryByText("Giuoco Pianissimo (4.d3)")).toBeNull();

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(italian)
        .getAllByRole("button", { name: /^Coverage of / })
        .map((name) => name.textContent),
    ).toEqual(["Giuoco Pianissimo (4.d3)", "Two Knights Defense (4.Ng5)"]);

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(within(italian).queryByText("Giuoco Pianissimo (4.d3)")).toBeNull();
  });

  it("describes the head by its variations and its line, for a screen reader", async () => {
    renderPage();
    const head = within(await card("Italian Game")).getByRole("button", { name: "Italian Game" });
    expect(head.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(head.getAttribute("aria-describedby") as string)?.textContent,
    ).toBe(`2 variations · ${ITALIAN_LINE}`);
  });
});

describe("a variation's row", () => {
  it("shows the name, the line and the five cells from the variation's own figures", async () => {
    renderPage();
    const italian = await card("Italian Game");
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    const rows = [...italian.querySelectorAll(".opening-row")] as HTMLElement[];
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(first.querySelector(".opening-row__line")?.textContent).toBe("3...Bc5 4.d3");
    expect(cellsOf(first.querySelector(".opening-row__cells"))).toEqual([
      ["Moves", "24"],
      ["Due now", "3"],
      ["Remembered, 30 days", "71%"],
      ["In line · 16 of 20 games", ""],
      ["Coverage", "100%"],
    ]);
    // A variation with no line of its own draws none.
    expect(second.querySelector(".opening-row__line")).toBeNull();
    expect(cellsOf(second.querySelector(".opening-row__cells"))[4]).toEqual(["Coverage", "87%"]);
  });

  it("puts the train button of the row after its five cells", async () => {
    renderPage();
    const italian = await card("Italian Game");
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    const cells = italian.querySelector(".opening-row__cells") as HTMLElement;
    expect(cells.lastElementChild?.className).toContain("train");
    expect(cells.children).toHaveLength(6);
  });
});

describe("the train buttons", () => {
  it("reads Train N with the recommended count of its level and sends it with the level of its place", async () => {
    const { onStart } = renderPage();
    const italian = await card("Italian Game");
    const cardButton = within(italian).getByRole("button", { name: "Train 5, Italian Game" });
    expect(cardButton.textContent).toBe("Train 5");
    fireEvent.click(cardButton);
    expect(onStart).toHaveBeenLastCalledWith(4, "recommended", "group");

    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    const row = within(italian).getByRole("button", {
      name: "Train 2, Giuoco Pianissimo (4.d3)",
    });
    expect(row.textContent).toBe("Train 2");
    fireEvent.click(row);
    // A variation names no level, so the call carries two arguments.
    expect(onStart).toHaveBeenLastCalledWith(4, "recommended");
    expect(onStart.mock.lastCall).toHaveLength(2);
    fireEvent.click(
      within(italian).getByRole("button", { name: "Train 3, Two Knights Defense (4.Ng5)" }),
    );
    expect(onStart).toHaveBeenLastCalledWith(5, "recommended");
  });

  it("opens a menu of Everything due and All moves with their counts, and sends each", async () => {
    const { onStart } = renderPage();
    const italian = await card("Italian Game");
    const more = within(italian).getByRole("button", { name: "More ways to train, Italian Game" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(within(italian).queryByRole("button", { name: /^Everything due/ })).toBeNull();

    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const menu = within(italian).getByRole("group", { name: "Train Italian Game" });
    expect(
      within(menu)
        .getAllByRole("button")
        .map((entry) => entry.textContent),
    ).toEqual(["Everything due 8", "All moves 39"]);

    fireEvent.click(within(menu).getByRole("button", { name: "Everything due 8" }));
    expect(onStart).toHaveBeenLastCalledWith(4, "due", "group");
    expect(within(italian).queryByRole("group", { name: "Train Italian Game" })).toBeNull();

    fireEvent.click(more);
    fireEvent.click(screen.getByRole("button", { name: "All moves 39" }));
    expect(onStart).toHaveBeenLastCalledWith(4, "all", "group");
  });

  it("sends the menu's scopes from a colour with level side and from a variation with no level", async () => {
    const { onStart } = renderPage();
    const white = await section("White");
    fireEvent.click(
      within(white).getByRole("button", { name: "More ways to train, every White opening" }),
    );
    fireEvent.click(within(white).getByRole("button", { name: "All moves 42" }));
    expect(onStart).toHaveBeenLastCalledWith(4, "all", "side");

    const italian = screen.getByRole("article", { name: "Italian Game" });
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    fireEvent.click(
      within(italian).getByRole("button", {
        name: "More ways to train, Two Knights Defense (4.Ng5)",
      }),
    );
    fireEvent.click(within(italian).getByRole("button", { name: "Everything due 5" }));
    expect(onStart).toHaveBeenLastCalledWith(5, "due");
    expect(onStart.mock.lastCall).toHaveLength(2);
  });

  it("is an outlined button that trains all moves, with no menu, when nothing is recommended", async () => {
    const { onStart } = renderPage();
    const kings = await card("King's Pawn Game");
    const button = within(kings).getByRole("button", { name: "Train all moves, King's Pawn Game" });
    expect(button.textContent).toBe("Train all moves");
    expect(button.className).toContain("train--outlined");
    expect(button.className).not.toContain("button--primary");
    expect(
      within(kings).queryByRole("button", { name: "More ways to train, King's Pawn Game" }),
    ).toBeNull();
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledWith(6, "all", "group");
  });

  it("disables the outlined button when the opening has no move at all, and leaves it enabled with moves", async () => {
    renderPage(
      answer({
        groups: [italianGroup, { ...kingsPawnGroup, moves: { recommended: 0, due: 0, all: 0 } }],
      }),
    );
    const kings = await card("King's Pawn Game");
    expect(
      isDisabled(within(kings).getByRole("button", { name: "Train all moves, King's Pawn Game" })),
    ).toBe(true);
    cleanup();
    renderPage();
    const withMoves = await card("King's Pawn Game");
    expect(
      isDisabled(
        within(withMoves).getByRole("button", { name: "Train all moves, King's Pawn Game" }),
      ),
    ).toBe(false);
  });

  it("disables a menu entry whose count is 0 and leaves the others enabled", async () => {
    renderPage(
      answer({
        groups: [{ ...italianGroup, moves: { recommended: 5, due: 0, all: 39 } }, kingsPawnGroup],
      }),
    );
    const italian = await card("Italian Game");
    fireEvent.click(
      within(italian).getByRole("button", { name: "More ways to train, Italian Game" }),
    );
    const menu = within(italian).getByRole("group", { name: "Train Italian Game" });
    expect(isDisabled(within(menu).getByRole("button", { name: "Everything due 0" }))).toBe(true);
    expect(isDisabled(within(menu).getByRole("button", { name: "All moves 39" }))).toBe(false);
  });

  it("holds the split button as one shape, a primary label and a chevron", async () => {
    renderPage();
    const italian = await card("Italian Game");
    const main = within(italian).getByRole("button", { name: "Train 5, Italian Game" });
    const more = within(italian).getByRole("button", { name: "More ways to train, Italian Game" });
    expect(main.parentElement).toBe(more.parentElement);
    expect(main.className).toContain("button--primary");
    expect(more.className).toContain("button--primary");
  });

  it("waits while a start is in flight or an opening is being added, and says Starting on its own", async () => {
    renderPage(answer(), {
      busy: true,
      starting: { repertoireId: 4, scope: "due", level: "group" },
    });
    const italian = await card("Italian Game");
    expect(
      isDisabled(within(italian).getByRole("button", { name: "Starting, Italian Game" })),
    ).toBe(true);
    const others = screen
      .getAllByRole("button")
      .filter((button) => /^(Train|More ways)/.test(button.getAttribute("aria-label") ?? ""));
    expect(others.length).toBeGreaterThan(3);
    for (const button of others) expect(isDisabled(button)).toBe(true);
    expect(screen.getAllByRole("button", { name: /^Starting/ })).toHaveLength(1);
  });

  it("closes its menu on a press outside it and on Escape, which hands the focus back to the chevron", async () => {
    renderPage();
    const italian = await card("Italian Game");
    const more = within(italian).getByRole("button", { name: "More ways to train, Italian Game" });
    fireEvent.click(more);
    fireEvent.pointerDown(document.body);
    expect(within(italian).queryByRole("group", { name: "Train Italian Game" })).toBeNull();

    fireEvent.click(more);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(within(italian).queryByRole("group", { name: "Train Italian Game" })).toBeNull();
    expect(document.activeElement).toBe(more);

    // A press inside the menu is not outside it.
    fireEvent.click(more);
    fireEvent.pointerDown(within(italian).getByRole("button", { name: "All moves 39" }));
    expect(within(italian).getByRole("group", { name: "Train Italian Game" })).toBeTruthy();
  });
});

describe("the page while it reads", () => {
  it("says it is loading, in a quiet sentence, while the list is read", async () => {
    renderPage(() => new Promise<RepertoiresResponse>(() => {}));
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading your openings.");
    expect(screen.queryByRole("region", { name: "White" })).toBeNull();
  });

  it("says it could not load, with Try again, and reads the list once more when it is pressed", async () => {
    const read = vi
      .fn<() => Promise<RepertoiresResponse>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(answer());
    renderPage(read);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Your openings could not be loaded.");
    expect(alert.className).toContain("practice__failure");
    expect(screen.queryByRole("region", { name: "White" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("status").textContent).toBe("Loading your openings.");
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    expect(await card("Italian Game")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the page's view of the answer", () => {
  it("lists the openings of a colour in the order of groups, each with the variations that share its name", () => {
    const [white, black] = sectionsOf(answer());
    expect(white?.openings.map((opening) => opening.group.group_name)).toEqual([
      "Italian Game",
      "King's Pawn Game",
    ]);
    expect(white?.openings[0]?.variations.map((variation) => variation.id)).toEqual([4, 5]);
    expect(white?.moves).toEqual({ recommended: 7, due: 9, all: 42 });
    expect(black).toEqual({ side: "black", openings: [], moves: null });
  });

  it("draws no opening for a group with no variation, nor any before the groups are counted", () => {
    expect(sectionsOf(answer({ groups: undefined }))[0]?.openings).toEqual([]);
    expect(
      sectionsOf(answer({ repertoires: [pianissimo] }))[0]?.openings.map(
        (opening) => opening.group.group_name,
      ),
    ).toEqual(["Italian Game"]);
  });

  it("writes the counts beside a colour and under an opening in the singular for one", () => {
    const [white, black] = sectionsOf(answer());
    expect(sectionSummaryText(white as never)).toBe("2 openings · 9 due");
    expect(sectionSummaryText(black as never)).toBe("no line yet");
    expect(openingMetaText(1, "1.e4 d5")).toBe("1 variation · 1.e4 d5");
    expect(openingMetaText(3, null)).toBe("3 variations");
  });

  it("rounds a share to a whole percentage and gives the no-value dash where nothing was asked", () => {
    const counts = { recommended: 1, due: 0, all: 2 };
    expect(
      figureValuesOf({
        moves: counts,
        moves_total: 7,
        remembered_30d: { right: 1, of: 8 },
        in_line: { stayed: 0, of: 3 },
        covered_percent: 66.5,
      }),
    ).toEqual({
      moves: "7",
      due: 0,
      remembered: "13%",
      inLineShare: 0,
      inLineText: "0 of 3 games",
      coverage: "67%",
    });
    expect(figureValuesOf({ moves: counts })).toEqual({
      moves: NONE,
      due: 0,
      remembered: NONE,
      inLineShare: null,
      inLineText: NONE,
      coverage: NONE,
    });
  });

  it("offers Train N from the recommended count, Train all moves with none, and the menu's two scopes", () => {
    expect(trainButtonOf({ recommended: 5, due: 9, all: 39 }, false)).toEqual({
      label: "Train 5",
      scope: "recommended",
      menu: [
        { scope: "due", text: "Everything due", count: 9 },
        { scope: "all", text: "All moves", count: 39 },
      ],
      outlined: false,
    });
    expect(trainButtonOf({ recommended: 5, due: 9, all: 39 }, true).label).toBe("Train all · 5");
    expect(trainButtonOf({ recommended: 0, due: 0, all: 3 }, true)).toEqual({
      label: "Train all moves",
      scope: "all",
      menu: [],
      outlined: true,
    });
  });
});

describe("its stylesheet", () => {
  const read = (path: string): string => readFileSync(join(import.meta.dirname, path), "utf8");
  const css = read("../src/styles/practice-openings.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const phoneAt = css.indexOf("@media (max-width: 899px)");
  const desktop = css.slice(0, phoneAt);
  const phone = css.slice(phoneAt);

  // Every declaration the rules naming the selector give it, the later one winning.
  function declared(sheet: string, selector: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const [, selectors = "", body = ""] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selectors.split(",").some((part) => part.trim() === selector)) continue;
      for (const declaration of body.split(";")) {
        const [property = "", ...value] = declaration.split(":");
        if (property.trim() !== "" && value.length > 0) {
          found[property.trim()] = value.join(":").trim();
        }
      }
    }
    return found;
  }

  it("holds no colour literal, only tokens", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it("is imported by the entry point, or the page would have no styling", () => {
    expect(read("../src/main.tsx")).toContain('import "./styles/practice-openings.css";');
  });

  it("draws a card as a surface with a hairline, an 8 px radius and 16 px and 20 px of padding", () => {
    expect(declared(desktop, ".opening-card")).toMatchObject({
      border: "1px solid var(--border)",
      "border-radius": "var(--radius-md)",
      padding: "var(--space-4) 20px",
    });
    expect(declared(desktop, ".opening-card__name")).toMatchObject({
      "font-size": "var(--text-lg)",
      "font-weight": "600",
    });
    expect(declared(desktop, ".opening-card__meta")).toMatchObject({
      "font-family": "var(--font-mono)",
      "font-size": "var(--text-xs)",
    });
  });

  it("lays the five cells of a card in equal columns 16 px apart, and a row's behind a button", () => {
    expect(declared(desktop, ".opening-card__figures")).toMatchObject({
      "grid-template-columns": "repeat(5, minmax(0, 1fr))",
      "border-top": "1px solid var(--border)",
    });
    expect(declared(desktop, ".opening-row__cells")).toMatchObject({
      "grid-template-columns": "repeat(5, minmax(0, 1fr)) auto",
      display: "grid",
      gap: "var(--space-4)",
    });
  });

  it("sizes the train buttons at 32 px and a row's at 30 px, and the add button at 32 px", () => {
    expect(declared(desktop, ".train")).toMatchObject({ height: "32px" });
    expect(declared(desktop, ".train--compact")).toMatchObject({ height: "30px" });
    expect(declared(desktop, ".opening-card__add")).toMatchObject({ height: "32px" });
    expect(declared(desktop, ".openings-add__open")).toMatchObject({
      height: "32px",
      "border-style": "dashed",
    });
  });

  it("draws the in-line bar 4 px high, in the green token over the neutral surface", () => {
    expect(declared(desktop, ".opening-figure__bar")).toMatchObject({
      height: "4px",
      background: "var(--surface-2)",
    });
    expect(declared(desktop, ".opening-figure__fill")).toMatchObject({
      background: "var(--status-ready)",
    });
  });

  it("turns the chevron a quarter when the card is open and sets the sections 28 px apart", () => {
    expect(
      declared(desktop, '.opening-card__toggle[aria-expanded="true"] .opening-card__chevron'),
    ).toMatchObject({ transform: "rotate(90deg)" });
    expect(declared(desktop, ".openings-body")).toMatchObject({ gap: "28px" });
    expect(declared(desktop, ".openings-section__title")).toMatchObject({
      "font-size": "1.25rem",
      "font-weight": "600",
    });
  });

  it("wraps the five cells to two columns under 900 px, puts the head's buttons under the title and keeps 44 px targets", () => {
    expect(phoneAt).toBeGreaterThan(0);
    for (const grid of [".opening-card__figures", ".opening-row__cells"]) {
      expect(declared(phone, grid)).toMatchObject({
        "grid-template-columns": "repeat(2, minmax(0, 1fr))",
      });
    }
    expect(declared(phone, ".opening-card__head")).toMatchObject({ "flex-wrap": "wrap" });
    expect(declared(phone, ".opening-card__toggle")).toMatchObject({ flex: "1 1 100%" });
    expect(declared(phone, ".train")).toMatchObject({ "min-height": "44px" });
    expect(declared(phone, ".opening-card__add")).toMatchObject({ "min-height": "44px" });
  });
});
