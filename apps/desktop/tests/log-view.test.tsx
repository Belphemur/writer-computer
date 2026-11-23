// The core log view (ADR 2026-11-23): lines coloured by level, a filter to errors, pinned to the
// end unless the user scrolled up, Copy writes the visible lines, "reveal" scrolls to the latest
// error, and the feed is opened on mount and closed on unmount.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const logs = vi.hoisted(() => ({
  logTail: vi.fn(),
  watchLog: vi.fn(),
  stop: vi.fn(),
  push: null as null | ((line: unknown) => void),
}));
vi.mock("@/lib/logs", () => ({ logTail: logs.logTail, watchLog: logs.watchLog }));
vi.mock("@/lib/tauri", () => ({ openLogFolder: vi.fn(async () => {}) }));

import { formatLogLine, LogView } from "@/components/log-view";
import type { LogLine } from "@/lib/logs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const line = (
  level: LogLine["level"],
  message: string,
  ts = "2026-11-23T14:03:21.000Z",
): LogLine => ({
  ts,
  level,
  target: "git",
  message,
});

let container: HTMLDivElement;
let root: Root;
const flush = () => act(async () => {});
const render = (node: React.ReactNode) => act(() => root.render(node));
const box = () => container.querySelector("[data-log-lines]") as HTMLElement;
const rows = () => [...container.querySelectorAll("[data-level]")];
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;

/** A scroller with a layout jsdom does not compute. */
function layout(el: HTMLElement, v: { scrollHeight: number; clientHeight: number }) {
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { value: v.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: v.clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (n: number) => {
      top = n;
    },
    configurable: true,
  });
}

beforeEach(() => {
  logs.logTail.mockReset().mockResolvedValue([]);
  logs.stop.mockReset();
  logs.watchLog.mockReset().mockImplementation(async (_t: string, on: (l: unknown) => void) => {
    logs.push = on;
    return logs.stop;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("LogView", () => {
  it("colours errors with the danger token, warnings with the warning token, info plain", async () => {
    logs.logTail.mockResolvedValue([
      line("error", "Authentication failed"),
      line("warn", "slow"),
      line("info", "git fetch ok"),
    ]);
    render(<LogView target="git" />);
    await flush();
    const [error, warn, info] = rows();
    expect(error!.className).toContain("--danger");
    expect(warn!.className).toContain("--warning");
    expect(info!.className).not.toMatch(/--danger|--warning/);
    expect(error!.textContent).toContain("Authentication failed");
    expect(logs.logTail).toHaveBeenCalledWith("git", 200);
  });

  it("opens the feed first, merges lines that arrive while the backlog loads, then follows live", async () => {
    let finish!: (l: LogLine[]) => void;
    logs.logTail.mockReturnValue(new Promise((r) => (finish = r)));
    render(<LogView target="git" />);
    await flush();
    logs.push!(line("info", "same")); // also in the backlog
    logs.push!(line("warn", "new while loading", "2026-11-23T14:03:23.000Z"));
    await act(async () =>
      finish([line("info", "old", "2026-11-23T14:03:20.000Z"), line("info", "same")]),
    );
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining("old"),
      expect.stringContaining("same"),
      expect.stringContaining("new while loading"),
    ]);
    act(() => {
      logs.push!(line("error", "live", "2026-11-23T14:03:24.000Z"));
    });
    expect(rows()).toHaveLength(4);
  });

  it("filters to errors and copies the visible lines", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const all = [line("info", "ok"), line("error", "boom"), line("warn", "hm")];
    logs.logTail.mockResolvedValue(all);
    render(<LogView target="git" />);
    await flush();
    await act(async () => button("Errors").click());
    expect(rows()).toHaveLength(1);
    await act(async () => button("Copy").click());
    expect(writeText).toHaveBeenCalledWith(formatLogLine(all[1]!));
    await act(async () => button("All").click());
    await act(async () => button("Copied").click());
    expect(writeText).toHaveBeenLastCalledWith(all.map(formatLogLine).join("\n"));
  });

  it("stays pinned to the end until the user scrolls up", async () => {
    logs.logTail.mockResolvedValue([line("info", "a")]);
    render(<LogView target="git" />);
    await flush();
    layout(box(), { scrollHeight: 1000, clientHeight: 200 });
    act(() => {
      logs.push!(line("info", "b"));
    });
    expect(box().scrollTop).toBe(1000);
    // scrolled up: new lines do not drag the view
    box().scrollTop = 100;
    act(() => {
      box().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    act(() => {
      logs.push!(line("info", "c"));
    });
    expect(box().scrollTop).toBe(100);
    // back at the end: pinned again
    box().scrollTop = 800;
    act(() => {
      box().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    act(() => {
      logs.push!(line("info", "d"));
    });
    expect(box().scrollTop).toBe(1000);
  });

  it("a new reveal token scrolls the latest error into the middle of the view", async () => {
    logs.logTail.mockResolvedValue([
      line("error", "first"),
      line("error", "latest"),
      line("info", "after"),
    ]);
    render(<LogView target="git" revealToken={0} />);
    await flush();
    const rects = new Map<Element, number>();
    rows().forEach((r, i) => rects.set(r, i * 100));
    layout(box(), { scrollHeight: 300, clientHeight: 100 });
    box().getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 }) as DOMRect;
    rows().forEach((r) => {
      (r as HTMLElement).getBoundingClientRect = () =>
        ({ top: rects.get(r)!, bottom: rects.get(r)! + 20 }) as DOMRect;
    });
    render(<LogView target="git" revealToken={1} />);
    await flush();
    // the latest error sits at 100..120 in a box 0..100: moved by (110 - 50)
    expect(box().scrollTop).toBe(60);
    // the same token again does nothing
    box().scrollTop = 0;
    render(<LogView target="git" revealToken={1} />);
    await flush();
    expect(box().scrollTop).toBe(0);
  });

  it("closes the feed on unmount, also when it was still opening", async () => {
    render(<LogView target="git" />);
    await flush();
    act(() => root.render(null));
    expect(logs.stop).toHaveBeenCalledTimes(1);

    let open!: (stop: () => void) => void;
    logs.watchLog.mockReturnValueOnce(new Promise((r) => (open = r)));
    render(<LogView target="git" />);
    act(() => root.render(null));
    await act(async () => open(logs.stop));
    expect(logs.stop).toHaveBeenCalledTimes(2);
  });
});
