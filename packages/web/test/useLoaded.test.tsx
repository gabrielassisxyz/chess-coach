import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Loaded, useLoaded } from "../src/hooks/useLoaded.js";

afterEach(cleanup);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Probe({
  fetcher,
  onState,
}: {
  fetcher: () => Promise<string>;
  onState?: (state: Loaded<string>) => void;
}) {
  const loaded = useLoaded(fetcher);
  onState?.(loaded);
  if (loaded.status === "loading") return <p role="status">loading</p>;
  if (loaded.status === "failed") {
    return (
      <>
        <p role="alert">failed</p>
        <button type="button" onClick={loaded.retry}>
          Try again
        </button>
      </>
    );
  }
  return <p>{loaded.value}</p>;
}

describe("useLoaded", () => {
  it("loads once and resolves to ready", async () => {
    const first = deferred<string>();
    const fetcher = vi.fn(() => first.promise);
    render(<Probe fetcher={fetcher} />);
    expect(screen.getByRole("status").textContent).toBe("loading");
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve("done");
      await first.promise;
    });
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("offers retry on failure, returns to loading, and recovers on the next call", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Probe fetcher={fetcher} />);

    await act(async () => {
      first.reject(new Error("down"));
    });
    expect(screen.getByRole("alert").textContent).toBe("failed");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("status").textContent).toBe("loading");
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve("recovered");
      await second.promise;
    });
    expect(screen.getByText("recovered")).toBeTruthy();
  });

  it("ignores an earlier call arriving after retry starts a newer one", async () => {
    const first = deferred<string>();
    const stale = deferred<string>();
    const latest = deferred<string>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);

    let savedRetry: (() => void) | null = null;
    render(
      <Probe
        fetcher={fetcher}
        onState={(state) => {
          if (state.status === "failed") savedRetry = state.retry;
        }}
      />,
    );

    await act(async () => {
      first.reject(new Error("first failed"));
    });
    expect(savedRetry).not.toBeNull();

    // Start attempt 2, then trigger the saved retry again so attempt 3 supersedes attempt 2.
    act(() => {
      savedRetry?.();
    });
    act(() => {
      savedRetry?.();
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("status").textContent).toBe("loading");

    // Attempt 2 settling late must not overwrite loading or attempt 3.
    await act(async () => {
      stale.resolve("stale-value");
      await stale.promise;
    });
    expect(screen.getByRole("status").textContent).toBe("loading");
    expect(screen.queryByText("stale-value")).toBeNull();

    await act(async () => {
      latest.resolve("fresh-value");
      await latest.promise;
    });
    expect(screen.getByText("fresh-value")).toBeTruthy();
  });

  it("ignores an earlier fetcher resolving after the fetcher changes", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const f1 = vi.fn(() => first.promise);
    const f2 = vi.fn(() => second.promise);

    const { rerender } = render(<Probe fetcher={f1} />);
    rerender(<Probe fetcher={f2} />);

    await act(async () => {
      first.resolve("old");
      await first.promise;
    });
    expect(screen.getByRole("status").textContent).toBe("loading");

    await act(async () => {
      second.resolve("new");
      await second.promise;
    });
    expect(screen.getByText("new")).toBeTruthy();
  });
});
