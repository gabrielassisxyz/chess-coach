import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../src/components/Chat.js";
import type { ServerApi } from "../src/hooks/useServer.js";
import { initialChatState } from "../src/state/transcript.js";

afterEach(cleanup);

function api(overrides: Partial<ServerApi> = {}): ServerApi {
  return {
    items: [],
    permissions: [],
    lastError: null,
    errorCount: 0,
    lastErrorCode: null,
    turn: "idle",
    localCount: 0,
    activity: null,
    cardsCreated: {},
    coachMessages: 0,
    lastMessageAt: null,
    tab: "play",
    conversations: initialChatState.conversations,
    newConversation: vi.fn(() => true),
    practiceReplyPending: false,
    practiceEndedItem: null,
    reconnectAttempt: 0,
    connection: "connected",
    say: vi.fn(() => true),
    approve: vi.fn(),
    dismissError: vi.fn(),
    send: vi.fn(() => true),
    ...overrides,
  };
}

describe("Chat", () => {
  it("renders a tool use as one folded line that unfolds to its raw result", () => {
    const result = [{ type: "text", text: '{"kind":"demo","fen":"x","turn":"black"}' }];
    render(
      <Chat
        server={api({
          items: [
            { type: "text", key: "a", role: "user", text: "look at e4" },
            {
              type: "tool",
              key: "b",
              toolUseId: "t1",
              name: "mcp__chess__make_move",
              input: { san: "Qxd5" },
              result: { output: result },
            },
          ],
        })}
      />,
    );
    const card = screen.getByTestId("tool-card");
    const line = screen.getByRole("button", { name: "Played Qxd5 on the demo board" });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("tool-result")).toBeNull();

    fireEvent.click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("tool-result").textContent).toContain('"kind": "demo"');
    expect(card.contains(screen.getByTestId("tool-result"))).toBe(true);
    expect(document.body.textContent).not.toContain("mcp__chess__");

    fireEvent.click(line);
    expect(screen.queryByTestId("tool-result")).toBeNull();
  });

  it("says a tool call failed when its result is marked as an error", () => {
    render(
      <Chat
        server={api({
          items: [
            {
              type: "tool",
              key: "f",
              toolUseId: "t9",
              name: "mcp__chess__show_position",
              input: { fen: "x" },
              result: { output: "MCP error -32602: Invalid arguments", isError: true },
            },
          ],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "show_position failed" })).toBeTruthy();
  });

  it("shows a turn_error notice and the reconnecting state", () => {
    render(
      <Chat
        server={api({
          connection: "reconnecting",
          items: [{ type: "turn_error", key: "e", message: "quota hit" }],
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("quota hit");
    expect(screen.getByRole("status").textContent).toBe("offline · reconnecting");
  });

  it("sends approve_tool with the request_id of the card that was clicked", () => {
    const approve = vi.fn();
    render(
      <Chat
        server={api({
          approve,
          permissions: [
            { requestId: "r1", toolName: "Bash", input: { cmd: "ls" } },
            { requestId: "r2", toolName: "Write", input: {} },
          ],
        })}
      />,
    );
    const cards = screen.getAllByTestId("approval-card");
    const second = cards[1] as HTMLElement;
    fireEvent.click(second.querySelector("button.button--primary") as HTMLElement);
    expect(approve).toHaveBeenLastCalledWith("r2", true);
    fireEvent.click(screen.getAllByText("Deny")[0] as HTMLElement);
    expect(approve).toHaveBeenLastCalledWith("r1", false);
  });

  it("sends on Enter, keeps a newline on Shift+Enter, and clears the draft once sent", () => {
    const say = vi.fn(() => true);
    render(<Chat server={api({ say })} />);
    const box = screen.getByLabelText("Message to the coach") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(say).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(say).toHaveBeenCalledWith("hello");
    expect(box.value).toBe("");
  });

  it("keeps the draft when the socket refused the message", () => {
    const say = vi.fn(() => false);
    render(<Chat server={api({ say })} />);
    const box = screen.getByLabelText("Message to the coach") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("hello");
  });
});

describe("coach Markdown", () => {
  it("renders bold and italics as their elements", () => {
    const { container } = render(
      <Chat
        server={api({
          items: [{ type: "text", key: "m", role: "assistant", text: "**bold** and *italic*" }],
        })}
      />,
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    expect(container.querySelector(".message--assistant")).not.toBeNull();
  });

  it("renders unordered and ordered lists as their elements", () => {
    const { container } = render(
      <Chat
        server={api({
          items: [
            { type: "text", key: "u", role: "assistant", text: "- apple\n- pear" },
            { type: "text", key: "o", role: "assistant", text: "1. first\n2. second" },
          ],
        })}
      />,
    );
    const list = container.querySelector("ul");
    expect(list).not.toBeNull();
    expect([...(list as HTMLElement).querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "apple",
      "pear",
    ]);
    const ordered = container.querySelector("ol");
    expect(ordered).not.toBeNull();
    expect(
      [...(ordered as HTMLElement).querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["first", "second"]);
  });

  it("renders inline code and fenced code blocks as their elements", () => {
    const { container } = render(
      <Chat
        server={api({
          items: [
            { type: "text", key: "i", role: "assistant", text: "Play `Nf3` here" },
            { type: "text", key: "f", role: "assistant", text: "```\ne4 e5\n```" },
          ],
        })}
      />,
    );
    expect(screen.getByText("Nf3").tagName).toBe("CODE");
    expect(screen.getByText("Nf3").closest("pre")).toBeNull();
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect((pre as HTMLElement).querySelector("code")?.textContent).toContain("e4 e5");
  });

  it("escapes raw HTML as text and never renders markup", () => {
    const { container } = render(
      <Chat
        server={api({
          items: [
            { type: "text", key: "x", role: "assistant", text: "<img src=x onerror=alert(1)>" },
          ],
        })}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders links as plain text with no anchor", () => {
    const { container } = render(
      <Chat
        server={api({
          items: [
            {
              type: "text",
              key: "l",
              role: "assistant",
              text: "[text](https://example.com)",
            },
          ],
        })}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("text")).toBeTruthy();
    expect(screen.getByText("text").tagName).not.toBe("A");
  });

  it("keeps student text plain and unformatted", () => {
    const { container } = render(
      <Chat
        server={api({
          items: [{ type: "text", key: "s", role: "user", text: "**not bold**" }],
        })}
      />,
    );
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector(".message--user")?.textContent).toBe("**not bold**");
  });

  it("renders a divider as a rule labelled with its name and local time", () => {
    const at = new Date(2026, 10, 6, 16, 30).toISOString();
    render(
      <Chat
        server={api({
          items: [
            { type: "text", key: "a", role: "assistant", text: "earlier" },
            { type: "divider", key: "d", label: "Puzzles", at },
          ],
        })}
      />,
    );
    const rule = screen.getByRole("separator", { name: "Puzzles · 16:30" });
    expect(rule.className).toBe("chat__divider");
    expect(rule.textContent).toBe("Puzzles · 16:30");
  });

  it("asks for a fresh conversation from the header", () => {
    const server = api();
    render(<Chat server={server} />);
    fireEvent.click(screen.getByRole("button", { name: "Nova conversa" }));
    expect(server.newConversation).toHaveBeenCalledTimes(1);
  });

  describe("the fresh-start card", () => {
    const NOW = new Date("2026-11-06T18:00:00Z").getTime();
    const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

    function withClock(run: () => void): void {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      try {
        run();
      } finally {
        vi.useRealTimers();
      }
    }

    it("is offered when the panel opens on a tab whose last message is over an hour old", () => {
      withClock(() => {
        const server = api({ lastMessageAt: minutesAgo(61) });
        const { rerender } = render(<Chat server={server} open={false} />);
        expect(screen.queryByTestId("fresh-start-card")).toBeNull();
        rerender(<Chat server={server} open />);
        expect(screen.getByTestId("fresh-start-card").textContent).toContain(
          "Começar uma nova conversa?",
        );
      });
    });

    it("is not offered within the hour, nor for an empty conversation", () => {
      withClock(() => {
        const { rerender } = render(<Chat server={api({ lastMessageAt: minutesAgo(59) })} />);
        expect(screen.queryByTestId("fresh-start-card")).toBeNull();
        rerender(<Chat server={api({ lastMessageAt: null })} />);
        expect(screen.queryByTestId("fresh-start-card")).toBeNull();
      });
    });

    it("is offered when the student types after the hour passed with the panel open", () => {
      withClock(() => {
        const server = api({ lastMessageAt: minutesAgo(30) });
        render(<Chat server={server} />);
        expect(screen.queryByTestId("fresh-start-card")).toBeNull();
        vi.setSystemTime(NOW + 31 * 60_000);
        fireEvent.change(screen.getByLabelText("Message to the coach"), {
          target: { value: "o" },
        });
        expect(screen.getByTestId("fresh-start-card")).toBeTruthy();
      });
    });

    it("stays hidden once dismissed until the next message, and clears nothing by itself", () => {
      withClock(() => {
        const server = api({ lastMessageAt: minutesAgo(90) });
        const { rerender } = render(<Chat server={server} />);
        fireEvent.click(screen.getByRole("button", { name: "Agora não" }));
        expect(screen.queryByTestId("fresh-start-card")).toBeNull();
        fireEvent.change(screen.getByLabelText("Message to the coach"), {
          target: { value: "again" },
        });
        expect(screen.queryByTestId("fresh-start-card")).toBeNull();
        expect(server.newConversation).not.toHaveBeenCalled();
        // A new message, itself over an hour old by now, is a new chance to offer it.
        const later = api({ lastMessageAt: minutesAgo(70) });
        rerender(<Chat server={later} open={false} />);
        rerender(<Chat server={later} open />);
        expect(screen.getByTestId("fresh-start-card")).toBeTruthy();
      });
    });

    it("starts a fresh conversation when accepted", () => {
      withClock(() => {
        const server = api({ lastMessageAt: minutesAgo(61) });
        render(<Chat server={server} />);
        fireEvent.click(screen.getByRole("button", { name: "Começar" }));
        expect(server.newConversation).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId("fresh-start-card")).toBeNull();
      });
    });
  });
});
