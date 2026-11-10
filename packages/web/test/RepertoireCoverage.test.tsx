import {
  type RepertoireCoverage as Coverage,
  type CoveragePosition,
  type CoverageReply,
  RepertoireCoverageSchema,
} from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepertoireCoverage } from "../src/components/RepertoireCoverage.js";
import { RepertoireMenu } from "../src/components/RepertoireMenu.js";
import {
  fetchCoverageFromServer,
  oneInText,
  percentText,
  replyChanceText,
  replyMoveText,
  soundnessText,
} from "../src/state/repertoires-api.js";
import { CLASSICAL_VARIATION, italianRepertoire, repertoireList } from "./practice-fixtures.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reply = (overrides: Partial<CoverageReply> & Pick<CoverageReply, "san">): CoverageReply => ({
  incidence: 0.3,
  status: "covered",
  source: "explorer",
  next: null,
  ...overrides,
});

const SETUP = ["e4", "e5", "Nf3", "Nc6", "Bc4"];

// 3.Bc4 is where Black starts to choose: 3...Bc5 is answered, 3...Nf6 and 3...d6 are not, and the
// last two replies are rarer than 1 in 50. 4.c3 is the position behind 3...Bc5.
const POSITIONS: CoveragePosition[] = [
  {
    line: ["e4"],
    incidence: 1,
    parent: null,
    replies: [reply({ san: "e5", incidence: 1, source: "setup", next: 1 })],
  },
  {
    line: ["e4", "e5", "Nf3"],
    incidence: 1,
    parent: 0,
    replies: [reply({ san: "Nc6", incidence: 1, source: "setup", next: 2 })],
  },
  {
    line: SETUP,
    incidence: 1,
    parent: 1,
    replies: [
      reply({ san: "Bc5", incidence: 0.4, next: 3 }),
      reply({ san: "Nf6", incidence: 0.25, status: "gap" }),
      reply({ san: "d6", incidence: 0.02, status: "gap" }),
      reply({ san: "h6", incidence: 0.0199, status: "not_required" }),
      reply({ san: "a6", incidence: 0, status: "covered", source: "engine", next: 3 }),
    ],
  },
  {
    line: [...SETUP, "Bc5", "c3"],
    incidence: 0.4,
    parent: 2,
    replies: [reply({ san: "Nf6", incidence: 0.2 })],
  },
];

const coverage = (overrides: Partial<Coverage> = {}): Coverage => ({
  repertoire_id: 3,
  goal_one_in: 50,
  rating_band: "0-1199",
  covered_percent: 66.7,
  gaps: [
    { line: [...SETUP, "Nf6"], incidence: 0.25, position: 2 },
    { line: [...SETUP, "d6"], incidence: 0.02, position: 2 },
  ],
  largest_gap: { line: [...SETUP, "Nf6"], incidence: 0.25, position: 2 },
  scores: { line_ends: 2, expected_score: 52, soundness: 84 },
  start: 2,
  positions: POSITIONS,
  ...overrides,
});

function renderCoverage(value: Coverage = coverage()) {
  const fetchCoverage = vi.fn(async () => value);
  render(<RepertoireCoverage repertoireId={3} name="Classical" fetchCoverage={fetchCoverage} />);
  return fetchCoverage;
}

const region = (): Promise<HTMLElement> =>
  screen.findByRole("region", { name: "Coverage of Classical" });

// The four figures at the top, by their term: "Covered" is also the word of a reply's status.
async function figures(): Promise<Record<string, string>> {
  const facts = (await region()).querySelectorAll(".repertoire-coverage__fact");
  return Object.fromEntries(
    [...facts].map((fact) => [
      fact.querySelector("dt")?.textContent ?? "",
      fact.querySelector("dd")?.textContent ?? "",
    ]),
  );
}

const repliesIn = async (): Promise<HTMLElement[]> =>
  within(await screen.findByRole("list", { name: "Black's replies" })).getAllByRole("listitem");

describe("the coverage of a variation", () => {
  it("shows the covered share, the expected score, the soundness and the largest gap", async () => {
    renderCoverage();
    expect(await figures()).toEqual({
      Covered: "66.7%",
      "Expected score": "52.0%",
      Soundness: "84",
      "Largest gap": "1 in 4",
    });
  });

  it("opens on Black's replies where the variation starts to choose, with a chance, covered or not", async () => {
    renderCoverage();
    const rows = await repliesIn();
    expect(rows.map((row) => row.textContent)).toEqual([
      "3...Bc51 in 3CoveredOpen",
      "3...Nf61 in 4Gap",
      "3...d61 in 50Gap",
      "3...h61 in 51Not required",
      "3...a6Too few gamesCoveredOpen",
    ]);
    expect(screen.getByText("1.e4 e5 2.Nf3 Nc6 3.Bc4")).toBeTruthy();
  });

  it("writes Not required for a reply under 1 in 50 with no answer, and a gap at exactly 1 in 50", async () => {
    renderCoverage();
    const rows = await repliesIn();
    const statusOf = (index: number): string | null =>
      (rows[index] as HTMLElement).querySelector("[data-status]")?.getAttribute("data-status") ??
      null;
    expect(statusOf(2)).toBe("gap");
    expect(statusOf(3)).toBe("not_required");
    expect(within(rows[3] as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("reads a reply the opening fixes as an opening move, not as a chance", async () => {
    renderCoverage(coverage({ start: 0 }));
    const rows = await repliesIn();
    expect(rows.map((row) => row.textContent)).toEqual(["1...e5Opening moveCoveredOpen"]);
  });

  it("lists the gaps with the line to each and a chance, likeliest first", async () => {
    renderCoverage();
    const gaps = within(await screen.findByRole("list", { name: "Gaps" })).getAllByRole("listitem");
    expect(gaps.map((row) => row.textContent)).toEqual([
      "1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf61 in 4Show",
      "1.e4 e5 2.Nf3 Nc6 3.Bc4 d61 in 50Show",
    ]);
  });

  it("shows the position of a gap when its Show is pressed", async () => {
    renderCoverage(coverage({ start: 3 }));
    expect((await repliesIn()).map((row) => row.textContent)).toEqual(["4...Nf61 in 5Covered"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Show the position of 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6" }),
    );
    expect(await screen.findByText("1.e4 e5 2.Nf3 Nc6 3.Bc4")).toBeTruthy();
    expect((await repliesIn())[0]?.textContent).toBe("3...Bc51 in 3CoveredOpen");
  });

  it("follows a covered reply to the position after White's answer and back up one move", async () => {
    renderCoverage();
    await repliesIn();
    fireEvent.click(screen.getByRole("button", { name: "Open the position after 3...Bc5" }));
    expect(await screen.findByText("1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3")).toBeTruthy();
    expect((await repliesIn()).map((row) => row.textContent)).toEqual(["4...Nf61 in 5Covered"]);
    fireEvent.click(screen.getByRole("button", { name: "Up one move" }));
    expect(await screen.findByText("1.e4 e5 2.Nf3 Nc6 3.Bc4")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Up one move" })).not.toBeNull();
  });

  it("offers no way up from the first position", async () => {
    renderCoverage(coverage({ start: 0 }));
    await repliesIn();
    expect(screen.queryByRole("button", { name: "Up one move" })).toBeNull();
  });

  it("lists ten gaps at most and counts the rest", async () => {
    const gaps = Array.from({ length: 12 }, (_, index) => ({
      line: [...SETUP, `g${index}`],
      incidence: 0.2 - index * 0.01,
      position: 2,
    }));
    renderCoverage(coverage({ gaps, largest_gap: gaps[0] ?? null }));
    const listed = within(await screen.findByRole("list", { name: "Gaps" })).getAllByRole(
      "listitem",
    );
    expect(listed).toHaveLength(10);
    expect(screen.getByText("And 2 more, each less likely.")).toBeTruthy();
  });

  it("says nothing is missing when no reply lacks an answer, and names no largest gap", async () => {
    renderCoverage(coverage({ gaps: [], largest_gap: null, covered_percent: 100 }));
    expect(await screen.findByText(/is missing an answer/)).toBeTruthy();
    expect(await figures()).toMatchObject({ Covered: "100.0%", "Largest gap": "None" });
    expect(screen.queryByRole("list", { name: "Gaps" })).toBeNull();
  });

  it("says Not enough games where a score has no line end to rest on", async () => {
    renderCoverage(coverage({ scores: { line_ends: 0, expected_score: null, soundness: null } }));
    expect(await figures()).toMatchObject({
      "Expected score": "Not enough games",
      Soundness: "Not enough games",
    });
  });

  it("says so while loading, and when the variation has nothing stored", async () => {
    const fetchCoverage = vi.fn(() => new Promise<Coverage>(() => undefined));
    render(<RepertoireCoverage repertoireId={3} name="Classical" fetchCoverage={fetchCoverage} />);
    expect(screen.getByText("Loading the coverage.")).toBeTruthy();
    cleanup();
    renderCoverage(coverage({ positions: [], gaps: [], largest_gap: null }));
    expect(await screen.findByText(/Nothing is stored for this variation yet/)).toBeTruthy();
  });

  it("says what to do when the coverage cannot be read", async () => {
    const fetchCoverage = vi.fn(async (): Promise<Coverage> => {
      throw new Error("down");
    });
    render(<RepertoireCoverage repertoireId={3} name="Classical" fetchCoverage={fetchCoverage} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "The coverage could not be loaded. Close it and open it again to try again.",
    );
  });
});

describe("the coverage in the openings menu", () => {
  function renderMenu(fetchCoverage = vi.fn(async () => coverage())) {
    render(
      <RepertoireMenu
        repertoires={{ status: "ready", value: repertoireList }}
        busy={false}
        starting={null}
        onStart={() => undefined}
        fetchList={async () => ({ repertoires: repertoireList, met: [] })}
        fetchCoverage={fetchCoverage}
      />,
    );
    return fetchCoverage;
  }

  const toggle = () => screen.getByRole("button", { name: `Coverage of ${CLASSICAL_VARIATION}` });

  it("reads nothing until the student opens a variation's coverage", async () => {
    const fetchCoverage = renderMenu();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(fetchCoverage).not.toHaveBeenCalled();
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await screen.findByRole("region", { name: `Coverage of ${CLASSICAL_VARIATION}` });
    expect(fetchCoverage).toHaveBeenCalledTimes(1);
    expect(fetchCoverage).toHaveBeenCalledWith(italianRepertoire.id);
  });

  it("closes it again, and asks once more when it is reopened", async () => {
    const fetchCoverage = renderMenu();
    fireEvent.click(toggle());
    await screen.findByRole("region", { name: `Coverage of ${CLASSICAL_VARIATION}` });
    fireEvent.click(toggle());
    expect(screen.queryByRole("region", { name: `Coverage of ${CLASSICAL_VARIATION}` })).toBeNull();
    fireEvent.click(toggle());
    await waitFor(() => expect(fetchCoverage).toHaveBeenCalledTimes(2));
  });
});

describe("the figures on the coverage screen", () => {
  it("writes a chance as 1 in N on its own side of the goal", () => {
    expect(oneInText(0.5, 50)).toBe("1 in 2");
    expect(oneInText(0.02, 50)).toBe("1 in 50");
    expect(oneInText(0.0199, 50)).toBe("1 in 51");
    expect(oneInText(0.0001, 50)).toBe("1 in 10000");
    // Whole numbers round to the nearest, but never across the goal that tells the two apart.
    expect(oneInText(0.01999, 50)).toBe("1 in 51");
    expect(oneInText(0.0201, 50)).toBe("1 in 50");
    expect(oneInText(0, 50)).toBe("Too few games");
  });

  it("writes an opening move as one, whatever its chance", () => {
    const fixed = reply({ san: "e5", incidence: 1, source: "setup" });
    expect(replyChanceText(fixed, 50)).toBe("Opening move");
    expect(replyChanceText({ ...fixed, source: "explorer" }, 50)).toBe("1 in 1");
  });

  it("writes Black's move after a line that ends on White's the way the book does", () => {
    expect(replyMoveText(["e4"], "e5")).toBe("1...e5");
    expect(replyMoveText(SETUP, "Bc5")).toBe("3...Bc5");
  });

  it("writes one decimal for a percentage and a whole number for soundness", () => {
    expect(percentText(52)).toBe("52.0%");
    expect(percentText(66.7)).toBe("66.7%");
    expect(percentText(null)).toBe("Not enough games");
    expect(soundnessText(84)).toBe("84");
    expect(soundnessText(null)).toBe("Not enough games");
  });
});

describe("the call behind the coverage screen", () => {
  it("reads the route of the variation and checks the answer against the shared schema", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(coverage())));
    vi.stubGlobal("fetch", fetchSpy);
    const read = await fetchCoverageFromServer(3);
    expect(fetchSpy).toHaveBeenCalledWith("/api/repertoires/3/coverage");
    expect(RepertoireCoverageSchema.parse(read)).toEqual(coverage());
  });

  it("fails with the status when the server refuses, and when the answer has the wrong shape", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    await expect(fetchCoverageFromServer(9)).rejects.toThrow("coverage: 404");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ gaps: "none" })));
    await expect(fetchCoverageFromServer(9)).rejects.toThrow();
  });
});
