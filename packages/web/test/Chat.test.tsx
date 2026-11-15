import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../src/components/Chat.js";
import { type ServerApi, useServer } from "../src/hooks/useServer.js";
import { initialChatState } from "../src/state/transcript.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";

afterEach(cleanup);

function LivePracticeChat() {
  const server = useServer({
    url: "ws://test/api/ws",
    createSocket: createFakeSocket,
    tab: "practice",
  });
  return <Chat server={server} open />;
}

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
    analysis: null,
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
  it("names every icon button in the composer and header", () => {
    const { container } = render(<Chat server={api()} />);
    const expectTitles = (labels: string[]): void => {
      const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.icon-button")];
      expect(buttons.map((button) => button.getAttribute("aria-label")).sort()).toEqual(
        [...labels].sort(),
      );
      for (const button of buttons) {
        expect(button.textContent?.trim()).toBe("");
        expect(button.getAttribute("title"), button.getAttribute("aria-label") ?? "unnamed").toBe(
          button.getAttribute("aria-label"),
        );
        expect(button.querySelector("svg")?.getAttribute("width")).toBe("20");
        expect(button.querySelector("svg")?.getAttribute("height")).toBe("20");
      }
    };

    expectTitles(["Collapse coach panel", "Dictate", "Voice conversation"]);
    fireEvent.change(screen.getByLabelText("Message to the coach"), { target: { value: "e4" } });
    expectTitles(["Collapse coach panel", "Dictate", "Send"]);
  });

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

  describe("turn_start boundaries and line card placement", () => {
    const FEN_1 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const FEN_2 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

    beforeEach(() => {
      FakeSocket.reset();
    });

    const mountPractice = () => {
      const rendered = render(<LivePracticeChat />);
      act(() => FakeSocket.latest.open());
      return rendered;
    };

    const receiveBootstrap = (practice: Record<string, unknown>[]) => {
      act(() =>
        FakeSocket.latest.receive({
          type: "bootstrap",
          conversations: { play: [], games: [], practice },
          activity: null,
        }),
      );
    };

    const row = (
      seq: number,
      role: "user" | "assistant" | "system",
      kind: "text" | "tool_use" | "tool_result" | "notification",
      content: unknown,
    ) => ({
      id: seq,
      seq,
      role,
      kind,
      content,
      created_at: new Date(Date.now() - (30 - seq) * 1000).toISOString(),
    });

    const offerEntries = (startSeq: number, toolUseId: string, fen: string, moves: string[]) => {
      const rows = [
        row(startSeq, "assistant", "tool_use", {
          toolUseId,
          name: "mcp__chess__show_position",
          input: { fen },
        }),
        row(startSeq + 1, "user", "tool_result", {
          toolUseId,
          output: JSON.stringify({ offered: true, start_fen: fen, moves: [] }),
        }),
      ];
      if (moves.length > 0) {
        const moveId = `${toolUseId}-m`;
        rows.push(
          row(startSeq + 2, "assistant", "tool_use", {
            toolUseId: moveId,
            name: "mcp__chess__make_move",
            input: { san: moves.join(" ") },
          }),
          row(startSeq + 3, "user", "tool_result", {
            toolUseId: moveId,
            output: JSON.stringify({ offered: true, start_fen: fen, moves }),
          }),
        );
      }
      return rows;
    };

    const orderedBlocks = (container: HTMLElement) =>
      [
        ...container.querySelectorAll(
          ".message--user, .message--assistant, [data-testid='line-card']",
        ),
      ].map((el) => ({
        kind: el.getAttribute("data-testid") === "line-card" ? "line-card" : "message",
        text: el.textContent ?? "",
      }));

    it("keeps a notification turn's line card under its own message after bootstrap refresh", () => {
      const { container } = mountPractice();
      receiveBootstrap([
        row(1, "user", "notification", { type: "puzzle_result", puzzle_id: "p1" }),
        row(2, "system", "text", { turn_start: "2026-01-01T00:00:02.000Z" }),
        ...offerEntries(3, "u1", FEN_1, ["e5"]),
        row(7, "assistant", "text", { text: "Puzzle 1 explanation" }),
        row(8, "user", "notification", { type: "puzzle_result", puzzle_id: "p2" }),
        row(9, "system", "text", { turn_start: "2026-01-01T00:00:09.000Z" }),
        row(10, "assistant", "text", { text: "Puzzle 2 explanation" }),
      ]);

      expect(screen.queryByRole("separator")).toBeNull();
      expect(orderedBlocks(container)).toEqual([
        { kind: "message", text: "Puzzle 1 explanation" },
        { kind: "line-card", text: "Show line on boarde5" },
        { kind: "message", text: "Puzzle 2 explanation" },
      ]);
    });

    it("keeps a live notification turn's line card under its own message when turn_start arrives live", () => {
      const { container } = mountPractice();

      const sendEvent = (seq: number, messageId: number, event: Record<string, unknown>) =>
        FakeSocket.latest.receive({
          type: "chat",
          tab: "practice",
          message_id: messageId,
          seq,
          event,
        });

      act(() => {
        FakeSocket.latest.receive({
          type: "chat_row",
          tab: "practice",
          entry: row(1, "system", "text", { turn_start: "2026-01-01T00:00:01.000Z" }),
        });
        sendEvent(1, 10, {
          kind: "tool_use",
          tool_use_id: "u1",
          name: "mcp__chess__show_position",
          input: { fen: FEN_1 },
        });
        sendEvent(2, 10, {
          kind: "tool_result",
          tool_use_id: "u1",
          output: JSON.stringify({ offered: true, start_fen: FEN_1, moves: [] }),
        });
        sendEvent(3, 10, {
          kind: "tool_use",
          tool_use_id: "u1-m",
          name: "mcp__chess__make_move",
          input: { san: "Nc6" },
        });
        sendEvent(4, 10, {
          kind: "tool_result",
          tool_use_id: "u1-m",
          output: JSON.stringify({ offered: true, start_fen: FEN_1, moves: ["Nc6"] }),
        });
        sendEvent(5, 10, { kind: "text_delta", text: "Puzzle 1 live" });
        sendEvent(6, 10, { kind: "turn_end", usage: { input_tokens: 1, output_tokens: 1 } });

        FakeSocket.latest.receive({
          type: "chat_row",
          tab: "practice",
          entry: row(2, "system", "text", { turn_start: "2026-01-01T00:00:02.000Z" }),
        });
        sendEvent(7, 11, { kind: "text_delta", text: "Puzzle 2 live" });
        sendEvent(8, 11, { kind: "turn_end", usage: { input_tokens: 1, output_tokens: 1 } });
      });

      expect(screen.queryByRole("separator")).toBeNull();
      expect(orderedBlocks(container)).toEqual([
        { kind: "message", text: "Puzzle 1 live" },
        { kind: "line-card", text: "Show line on boardNc6" },
        { kind: "message", text: "Puzzle 2 live" },
      ]);
    });

    it("does not displace a turn's line card when a notification row is stored mid-turn", () => {
      const { container } = mountPractice();
      receiveBootstrap([
        row(1, "user", "notification", { type: "puzzle_result", puzzle_id: "p1" }),
        row(2, "system", "text", { turn_start: "2026-01-01T00:00:02.000Z" }),
        ...offerEntries(3, "u1", FEN_1, ["e5"]),
        row(7, "user", "notification", { type: "puzzle_result", puzzle_id: "p2-mid" }),
        row(8, "assistant", "text", { text: "Puzzle 1 still owns this card" }),
        row(9, "system", "text", { turn_start: "2026-01-01T00:00:09.000Z" }),
        row(10, "assistant", "text", { text: "Puzzle 2 later" }),
      ]);

      expect(screen.queryByRole("separator")).toBeNull();
      expect(orderedBlocks(container)).toEqual([
        { kind: "message", text: "Puzzle 1 still owns this card" },
        { kind: "line-card", text: "Show line on boarde5" },
        { kind: "message", text: "Puzzle 2 later" },
      ]);
    });

    it("renders nothing for turn_start rows while keeping visible dividers", () => {
      const { container } = mountPractice();
      receiveBootstrap([
        row(1, "system", "text", { turn_start: "2026-01-01T00:00:01.000Z" }),
        row(2, "system", "text", { label: "Practice queue", at: "2026-01-01T10:15:00.000Z" }),
        row(3, "system", "text", { turn_start: "2026-01-01T00:00:03.000Z" }),
        row(4, "assistant", "text", { text: "Ready" }),
      ]);

      const separators = screen.getAllByRole("separator");
      expect(separators).toHaveLength(1);
      expect(separators[0]?.textContent).toContain("Practice queue");
      const columnChildren = [...(container.querySelector(".chat__column")?.children ?? [])];
      expect(columnChildren.map((el) => el.className)).toEqual([
        "chat__divider",
        "message message--assistant message--markdown",
        "",
      ]);
    });

    it("keeps each turn's card under its own message when two consecutive turns offer lines", () => {
      const { container } = mountPractice();
      receiveBootstrap([
        row(1, "system", "text", { turn_start: "2026-01-01T00:00:01.000Z" }),
        ...offerEntries(2, "u1", FEN_1, ["Nf3"]),
        row(6, "assistant", "text", { text: "Turn 1 message" }),
        row(7, "system", "text", { turn_start: "2026-01-01T00:00:07.000Z" }),
        ...offerEntries(8, "u2", FEN_2, ["d4"]),
        row(12, "assistant", "text", { text: "Turn 2 message" }),
      ]);

      expect(orderedBlocks(container)).toEqual([
        { kind: "message", text: "Turn 1 message" },
        { kind: "line-card", text: "Show line on boardNf3" },
        { kind: "message", text: "Turn 2 message" },
        { kind: "line-card", text: "Show line on boardd4" },
      ]);
      const buttons = screen.getAllByRole("button", { name: "Show line on board" });
      fireEvent.click(buttons[0] as HTMLElement);
      fireEvent.click(buttons[1] as HTMLElement);
      expect(FakeSocket.latest.sent).toEqual([
        expect.objectContaining({ type: "show_line", fen: FEN_1, moves: ["Nf3"] }),
        expect.objectContaining({ type: "show_line", fen: FEN_2, moves: ["d4"] }),
      ]);
    });

    it("renders legacy transcripts without turn_start markers unchanged", () => {
      const { container } = mountPractice();
      receiveBootstrap([
        row(1, "user", "text", { text: "First question" }),
        ...offerEntries(2, "u1", FEN_1, ["e5"]),
        row(6, "assistant", "text", { text: "First answer" }),
        row(7, "user", "text", { text: "Second question" }),
        row(8, "assistant", "text", { text: "Second answer" }),
      ]);

      expect(screen.queryByRole("separator")).toBeNull();
      expect(orderedBlocks(container)).toEqual([
        { kind: "message", text: "First question" },
        { kind: "message", text: "First answer" },
        { kind: "line-card", text: "Show line on boarde5" },
        { kind: "message", text: "Second question" },
        { kind: "message", text: "Second answer" },
      ]);
    });

    it("renders two line cards in order when one coach turn offers two lines", () => {
      const { container } = mountPractice();
      receiveBootstrap([
        row(1, "system", "text", { turn_start: "2026-01-01T00:00:01.000Z" }),
        ...offerEntries(2, "u1", FEN_1, ["Nf3", "Nc6"]),
        ...offerEntries(6, "u2", FEN_2, ["d4", "d5"]),
        row(10, "assistant", "text", { text: "Compare these two lines" }),
      ]);

      expect(screen.getAllByTestId("line-card")).toHaveLength(2);
      expect(orderedBlocks(container)).toEqual([
        { kind: "message", text: "Compare these two lines" },
        { kind: "line-card", text: "Show line on boardNf3 Nc6" },
        { kind: "line-card", text: "Show line on boardd4 d5" },
      ]);
      const buttons = screen.getAllByRole("button", { name: "Show line on board" });
      fireEvent.click(buttons[0] as HTMLElement);
      fireEvent.click(buttons[1] as HTMLElement);
      expect(FakeSocket.latest.sent).toEqual([
        expect.objectContaining({ type: "show_line", fen: FEN_1, moves: ["Nf3", "Nc6"] }),
        expect.objectContaining({ type: "show_line", fen: FEN_2, moves: ["d4", "d5"] }),
      ]);
    });

    it("renders the SAN of each move of its line inside the card", () => {
      mountPractice();
      receiveBootstrap([
        row(1, "system", "text", { turn_start: "2026-01-01T00:00:01.000Z" }),
        ...offerEntries(2, "u1", FEN_1, ["e5", "Nf3", "Nc6"]),
        row(6, "assistant", "text", { text: "Main line" }),
      ]);

      const card = screen.getByTestId("line-card");
      expect(card.textContent).toContain("e5 Nf3 Nc6");
      expect(card.querySelector(".line-card__moves")?.textContent).toBe("e5 Nf3 Nc6");
    });
  });
});
