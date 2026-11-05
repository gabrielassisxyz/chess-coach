import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../src/components/Chat.js";
import type { ServerApi } from "../src/hooks/useServer.js";

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
