import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { readTheme, THEME_STORAGE_KEY } from "../src/state/theme.js";
import { FakeSocket } from "./fake-socket.js";

const STYLES = join(import.meta.dirname, "../src/styles");
const tokensCss = readFileSync(join(STYLES, "tokens.css"), "utf8");

function prefersDark(dark: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: dark && query.includes("dark"), media: query })),
  );
}

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "ok", version: "0.0.0", ready: true })),
  );
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("theme", () => {
  it("starts from the system preference when nothing is stored", () => {
    prefersDark(true);
    expect(readTheme()).toBe("dark");
    prefersDark(false);
    expect(readTheme()).toBe("light");
  });

  it("starts from the stored choice, even against the system preference", () => {
    prefersDark(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(readTheme()).toBe("light");
  });

  it("ignores a stored value that is not a theme", () => {
    prefersDark(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readTheme()).toBe("light");
  });

  it("sets data-theme on the document at startup", () => {
    prefersDark(true);
    render(<App />);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("flips the attribute from the top bar button and stores the choice", () => {
    prefersDark(false);
    render(<App />);
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("keeps the choice across a reload", () => {
    prefersDark(false);
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    first.unmount();
    delete document.documentElement.dataset.theme;
    act(() => {
      render(<App />);
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("does not store anything until the button is used", () => {
    prefersDark(true);
    render(<App />);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});

describe("tokens.css", () => {
  const dark = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
  const light = /:root\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
  const QUALITIES = ["best", "great", "good", "inaccuracy", "mistake", "blunder"];

  it("defines a text colour and a badge background per quality in both themes", () => {
    for (const q of QUALITIES) {
      for (const name of [`--quality-${q}:`, `--quality-${q}-bg:`]) {
        expect(light).toContain(name);
        expect(dark).toContain(name);
      }
    }
  });

  it("gives every quality badge a rule in layout.css", () => {
    const layout = readFileSync(join(STYLES, "layout.css"), "utf8");
    for (const q of QUALITIES) expect(layout).toMatch(new RegExp(`\\.badge--${q}\\s*\\{`));
  });

  it("holds the four board themes as [data-board] variable sets", () => {
    for (const board of ["chesscom", "slate", "teal"]) {
      expect(tokensCss).toContain(`:root[data-board="${board}"]`);
    }
    expect(light).toContain("--board-light: #f0d9b5");
    expect(light).toContain("--board-dark: #b58863");
  });

  it("keeps colour literals out of every other stylesheet", () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
    const sources = ["board", "chat", "focus", "layout", "review", "train"];
    for (const name of sources) {
      const css = readFileSync(join(STYLES, `${name}.css`), "utf8").replace(
        /\/\*[\s\S]*?\*\//g,
        "",
      );
      expect(css, name).not.toMatch(literal);
    }
  });
});
