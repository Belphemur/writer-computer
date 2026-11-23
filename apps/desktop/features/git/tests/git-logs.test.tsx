// Settings > Git > Logs (ADR 2026-11-23): a collapsed section after Advanced that mounts the log
// view for target `git` only while open, and "Show logs" beside every error that opens it at the
// latest error.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

const logs = vi.hoisted(() => ({
  logTail: vi.fn(),
  watchLog: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@/lib/logs", () => ({ logTail: logs.logTail, watchLog: logs.watchLog }));
vi.mock("@/lib/log-actions", () => ({ openLogFolder: vi.fn(async () => {}) }));

const ipc = vi.hoisted(() => ({
  status: vi.fn(),
  setup: vi.fn(),
  commitNow: vi.fn(),
  setPaused: vi.fn(),
  stop: vi.fn(),
  syncNow: vi.fn(),
  setSyncPaused: vi.fn(),
  setRemote: vi.fn(),
  removeRemote: vi.fn(),
  tools: vi.fn(),
  installGit: vi.fn(),
  signIn: vi.fn(),
  setCredentials: vi.fn(),
}));
vi.mock("../web/ipc", () => ({ ...ipc, GIT_CHANGED: "changed", GIT_APPLYING: "applying" }));

import { useWorkspaceStore } from "@/stores/workspace-store";
import { GitSection } from "../web/components/git-section";
import { useLogsSection } from "../web/lib/logs-section";
import { useGitStatus } from "../web/lib/status-store";
import { baseStatus } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const flush = () => act(async () => {});
const render = () => act(() => root.render(<GitSection />));
const section = () => container.querySelector("[data-git-logs]") as HTMLDetailsElement;
const showLogs = () => [...container.querySelectorAll("[data-show-logs]")];
const linked = (patch = {}) => baseStatus({ remote: "github.com/me/v", branch: "main", ...patch });

beforeEach(() => {
  useGitStatus.getState().reset();
  useLogsSection.setState({ open: false, reveal: 0 });
  useWorkspaceStore.setState({ root: "/vault" } as never);
  Object.values(ipc).forEach((f) => f.mockReset());
  ipc.tools.mockResolvedValue({ git: true, forges: [], canInstallGit: false });
  ipc.status.mockImplementation(async () => useGitStatus.getState().status);
  logs.logTail.mockReset().mockResolvedValue([]);
  logs.stop.mockReset();
  logs.watchLog.mockReset().mockResolvedValue(logs.stop);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Settings > Git > Logs", () => {
  it("is a collapsed section after Advanced and opens no feed while collapsed", async () => {
    act(() => useGitStatus.getState().apply(baseStatus()));
    render();
    await flush();
    const details = [...container.querySelectorAll("details")];
    expect(details.map((d) => d.hasAttribute("data-git-logs"))).toEqual([false, true]);
    expect(section().open).toBe(false);
    expect(logs.watchLog).not.toHaveBeenCalled();
    expect(logs.logTail).not.toHaveBeenCalled();
  });

  it("opening it mounts the view for target git; closing it ends the feed", async () => {
    act(() => useGitStatus.getState().apply(baseStatus()));
    render();
    await flush();
    await act(async () => {
      section().querySelector("summary")!.click();
      section().open = true;
      section().dispatchEvent(new Event("toggle"));
    });
    await flush();
    expect(logs.watchLog).toHaveBeenCalledWith("git", expect.any(Function));
    expect(logs.logTail).toHaveBeenCalledWith("git", 200);
    await act(async () => {
      section().open = false;
      section().dispatchEvent(new Event("toggle"));
    });
    expect(logs.stop).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-log-view]")).toBeNull();
  });

  it("opening it by hand after a Show logs and a close does not scroll to the old error", async () => {
    act(() => useGitStatus.getState().apply(baseStatus()));
    render();
    act(() => useLogsSection.getState().show());
    await flush();
    expect(useLogsSection.getState().reveal).toBe(1);
    await act(async () => {
      section().open = false;
      section().dispatchEvent(new Event("toggle"));
    });
    expect(useLogsSection.getState().reveal).toBe(0);
    await act(async () => {
      section().open = true;
      section().dispatchEvent(new Event("toggle"));
    });
    await flush();
    const view = container.querySelector("[data-log-view]");
    expect(view).not.toBeNull();
    expect(useLogsSection.getState()).toMatchObject({ open: true, reveal: 0 });
  });

  it("leaving the page closes the section", async () => {
    act(() => useGitStatus.getState().apply(baseStatus()));
    render();
    act(() => useLogsSection.getState().show());
    await flush();
    expect(logs.watchLog).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    expect(logs.stop).toHaveBeenCalledTimes(1);
    expect(useLogsSection.getState().open).toBe(false);
  });
});

describe("Show logs", () => {
  it("is offered beside a status-line error, expands the section and reveals the latest error", async () => {
    logs.logTail.mockResolvedValue([
      {
        ts: "2026-11-23T14:03:21.000Z",
        level: "error",
        target: "git",
        message: "Authentication failed",
      },
    ]);
    act(() =>
      useGitStatus.getState().apply(
        linked({
          syncError: {
            line: "Authentication failed",
            details: "fatal: x",
            offline: false,
            kind: "auth",
          },
        }),
      ),
    );
    render();
    await flush();
    // the header's Error and the sync error line, no more
    expect(showLogs()).toHaveLength(2);
    expect(section().open).toBe(false);
    await act(async () => (showLogs()[1] as HTMLElement).click());
    await flush();
    expect(section().open).toBe(true);
    expect(
      container.querySelector("[data-log-view=git] [data-level=error]")?.textContent,
    ).toContain("Authentication failed");
    expect(useLogsSection.getState().reveal).toBe(1);
  });

  it("is on a failed sign-in step and an action's failure, not on a healthy page", async () => {
    ipc.tools.mockResolvedValue({
      git: true,
      canInstallGit: false,
      forges: [
        {
          id: "gh",
          label: "GitHub CLI",
          signIn: "Sign in with GitHub",
          install: "Install GitHub CLI",
          installUrl: "https://cli.github.com",
          login: "gh auth login",
          state: "signed-in",
          hosts: [],
        },
      ],
    });
    act(() => useGitStatus.getState().apply(baseStatus()));
    render();
    await flush();
    expect(showLogs()).toHaveLength(0);
    ipc.signIn.mockResolvedValue({
      steps: [
        { id: "remote", state: "done", line: "github.com/me/v", kind: "" },
        { id: "credential", state: "done", line: "GitHub CLI", kind: "" },
        { id: "push", state: "failed", line: "Authentication failed", kind: "auth" },
      ],
      taken: null,
      status: baseStatus({ remote: "github.com/me/v", branch: "main" }),
    });
    await act(async () => (container.querySelector("[data-forge] button") as HTMLElement).click());
    await flush();
    const failed = container.querySelector('[data-step="push"]')!;
    expect(failed.querySelector("[data-show-logs]")).not.toBeNull();
    expect(container.querySelector('[data-step="remote"] [data-show-logs]')).toBeNull();

    ipc.syncNow.mockRejectedValue("Git failed");
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Sync now")!.click(),
    );
    await flush();
    const alert = [...container.querySelectorAll('[role="alert"]')].find((a) =>
      a.textContent?.includes("Git failed"),
    )!;
    expect(alert.querySelector("[data-show-logs]")).not.toBeNull();
  });
});
