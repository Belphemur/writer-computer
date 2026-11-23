// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const handlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => {});
  }),
}));

import { useEditorNoticeStore } from "../src/components/editor-area/editor-notice-store";
import { useFileWatcher } from "../src/hooks/use-file-watcher";
import { useWorkspaceStore } from "../src/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useFileWatcher();
  return null;
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  handlers.clear();
  useWorkspaceStore.setState({ root: "/vault", workspaceEpoch: 3 });
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  useEditorNoticeStore.getState().dismissNotice();
});

describe("fs:watch-failed listener", () => {
  it("shows the message of the current workspace, and keeps it", () => {
    vi.useFakeTimers();
    handlers.get("fs:watch-failed")!({
      payload: { message: "raise the limit", workspace: { root: "/vault", epoch: 3 } },
    });
    expect(useEditorNoticeStore.getState().message).toBe("raise the limit");
    vi.advanceTimersByTime(60_000);
    expect(useEditorNoticeStore.getState().message).toBe("raise the limit");
    vi.useRealTimers();
  });

  it("ignores an event of another epoch or workspace", () => {
    const send = (workspace: { root: string; epoch: number }) =>
      handlers.get("fs:watch-failed")!({ payload: { message: "old", workspace } });
    send({ root: "/vault", epoch: 2 });
    send({ root: "/other", epoch: 3 });
    expect(useEditorNoticeStore.getState().message).toBeNull();
  });
});
