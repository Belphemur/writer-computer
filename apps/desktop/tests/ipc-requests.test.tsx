// The window's half of the CLI socket: the core handlers reuse the UI's own open, reveal and
// cursor paths, `active` returns only the path, kind and line, and the answer goes back to Rust.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return unlisten;
  }),
}));
vi.mock("../src/lib/tauri", () => ({ ipcReady: vi.fn(), ipcReply: vi.fn() }));
vi.mock("../src/lib/link-activation", () => ({ openPathAtAnchor: vi.fn() }));
vi.mock("../src/components/editor-area/reveal-line", () => ({ openFileAtLine: vi.fn() }));
vi.mock("../src/lib/reveal-in-sidebar", () => ({ revealPathInSidebar: vi.fn() }));
const findEditorView = vi.fn();
vi.mock("../src/lib/editor-views", () => ({ findEditorView: (p: string) => findEditorView(p) }));

import {
  answerIpcRequest,
  registerCoreIpcHandlers,
  useIpcRequests,
} from "../src/hooks/use-ipc-requests";
import { openFileAtLine } from "../src/components/editor-area/reveal-line";
import { handleIpcRequest } from "../src/lib/features/ipc-requests";
import { openPathAtAnchor } from "../src/lib/link-activation";
import { revealPathInSidebar } from "../src/lib/reveal-in-sidebar";
import { ipcReady, ipcReply } from "../src/lib/tauri";
import { useEditorStore } from "../src/stores/editor-store";
import { flushPromises } from "@tests/helpers/events";

let off = () => {};
beforeEach(() => {
  off = registerCoreIpcHandlers();
});
afterEach(() => {
  off();
  listeners.clear();
  vi.clearAllMocks();
  findEditorView.mockReset();
});

describe("open", () => {
  it("opens in the current tab by default and in an active new tab with newTab", async () => {
    await handleIpcRequest("open", { path: "/v/a.md", newTab: false, line: null, anchor: null });
    expect(openPathAtAnchor).toHaveBeenLastCalledWith("/v/a.md", null, "current");
    await handleIpcRequest("open", { path: "/v/a.md", newTab: true, line: null, anchor: "plan" });
    expect(openPathAtAnchor).toHaveBeenLastCalledWith("/v/a.md", "plan", "new-tab-active");
    expect(openFileAtLine).not.toHaveBeenCalled();
  });

  it("a line goes through the line-reveal path the content search uses", async () => {
    await handleIpcRequest("open", { path: "/v/a.md", newTab: false, line: 12, anchor: null });
    expect(openFileAtLine).toHaveBeenCalledWith("/v/a.md", 12, { intent: "current" });
    expect(openPathAtAnchor).not.toHaveBeenCalled();
  });
});

describe("reveal", () => {
  it("reveals in the sidebar and shows it when hidden", async () => {
    await handleIpcRequest("reveal", { path: "/v/Projects" });
    expect(revealPathInSidebar).toHaveBeenCalledWith("/v/Projects", { showSidebar: true });
  });
});

describe("active", () => {
  const tab = (location: object) => ({ id: "t1", location, back: [], forward: [] }) as never;

  it("returns the path, kind and cursor line and nothing else", async () => {
    useEditorStore.setState({
      tabs: [tab({ kind: "file", path: "/v/a.md" })],
      activeTabId: "t1",
      activeFilePath: "/v/a.md",
    });
    findEditorView.mockReturnValue({
      state: {
        doc: { lineAt: () => ({ number: 7, text: "private words" }), toString: () => "all text" },
        selection: { main: { head: 4 } },
      },
    });
    const result = await handleIpcRequest("active", {});
    expect(result).toEqual({ path: "/v/a.md", kind: "file", line: 7 });
    expect(Object.keys(result as object).sort()).toEqual(["kind", "line", "path"]);
  });

  it("has no line without a live editor and no path for a tab that is not a file", async () => {
    useEditorStore.setState({
      tabs: [tab({ kind: "file", path: "/v/a.md" })],
      activeTabId: "t1",
      activeFilePath: "/v/a.md",
    });
    findEditorView.mockReturnValue(null);
    expect(await handleIpcRequest("active", {})).toEqual({
      path: "/v/a.md",
      kind: "file",
      line: null,
    });
    useEditorStore.setState({ tabs: [], activeTabId: null, activeFilePath: null });
    expect(await handleIpcRequest("active", {})).toEqual({ path: null, kind: null, line: null });
  });
});

describe("answering", () => {
  it("sends the result, or the message of the error, back to Rust", async () => {
    await answerIpcRequest({ id: "r1", topic: "reveal", payload: { path: "/v/a.md" } });
    expect(ipcReply).toHaveBeenLastCalledWith("r1", { result: {} });
    vi.mocked(openPathAtAnchor).mockRejectedValueOnce(new Error("cannot open"));
    await answerIpcRequest({
      id: "r2",
      topic: "open",
      payload: { path: "/v/a.md", newTab: false, line: null, anchor: null },
    });
    expect(ipcReply).toHaveBeenLastCalledWith("r2", { error: "cannot open" });
    await answerIpcRequest({ id: "r3", topic: "no-such-topic", payload: {} });
    expect(ipcReply).toHaveBeenLastCalledWith("r3", { error: "no handler for no-such-topic" });
  });
});

function Probe({ resolved }: { resolved: boolean }) {
  useIpcRequests(resolved);
  return null;
}

describe("useIpcRequests", () => {
  it("listens and says it is ready only once startup has resolved", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Probe resolved={false} />));
    await flushPromises();
    expect(listeners.size).toBe(0);
    expect(ipcReady).not.toHaveBeenCalled();

    await act(async () => root.render(<Probe resolved />));
    await flushPromises();
    expect(ipcReady).toHaveBeenCalledTimes(1);
    await act(async () => {
      listeners.get("ipc:request")!({
        payload: { id: "q", topic: "reveal", payload: { path: "/p" } },
      });
      await flushPromises();
    });
    expect(ipcReply).toHaveBeenCalledWith("q", { result: {} });

    await act(async () => root.unmount());
    await flushPromises();
    expect(unlisten).toHaveBeenCalled();
  });
});
