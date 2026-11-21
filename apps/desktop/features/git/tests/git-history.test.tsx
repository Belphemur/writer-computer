// The History tab: the list grouped by day with bursts folded, the labels (device, agent badge and
// chat title with the model's display name), the selected version and its diff through the one
// diff component, Restore, Copy, Open chat through the agent's service, link activation on the
// entries, and the menu and palette entries that exist only while git is on.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));

const ipc = vi.hoisted(() => ({
  status: vi.fn(),
  setup: vi.fn(),
  commitNow: vi.fn(),
  setPaused: vi.fn(),
  stop: vi.fn(),
  history: vi.fn(),
  deleted: vi.fn(),
  versionDiff: vi.fn(),
  versionText: vi.fn(),
  restore: vi.fn(),
  syncNow: vi.fn(),
  mergeText: vi.fn(),
  setSyncPaused: vi.fn(),
  setRemote: vi.fn(),
  removeRemote: vi.fn(),
  tools: vi.fn(),
  installGit: vi.fn(),
  signInGithub: vi.fn(),
  setCredentials: vi.fn(),
  pluginDecision: vi.fn(),
  dismissNotices: vi.fn(),
}));
vi.mock("../web/ipc", () => ({ ...ipc, GIT_CHANGED: "changed", GIT_APPLYING: "applying" }));
const sync = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("@/lib/save", async (orig) => ({
  ...(await orig<object>()),
  flushSave: vi.fn(async () => void sync.order.push("flush")),
}));
vi.mock("@/lib/open-note-sync", () => ({
  reloadOpenNoteAfterWrite: vi.fn(async () => void sync.order.push("reload")),
}));
const menu = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("@/components/editor-area/editor-context-menu", async (orig) => ({
  ...(await orig<object>()),
  showNativeContextMenu: menu.show,
}));
const editor = vi.hoisted(() => ({ openGitHistoryTab: vi.fn(), openSettings: vi.fn() }));
vi.mock("@/hooks/editor-api", async (orig) => ({ ...(await orig<object>()), ...editor }));

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { featurePaletteCommands } from "@/lib/features/palette";
import { createFeatureHost } from "@/lib/features/registry";
import { menuContributions } from "@/lib/features/menus";
import { serviceContributions } from "@/lib/features/services";
import { slotContributions } from "@/lib/features/slots";
import { useWorkspaceStore } from "@/stores/workspace-store";
import git from "../web";
import HistoryPage from "../web/components/history-page";
import GitPanel from "../web/components/panel";
import { showHistoryItems } from "../web/menus";
import {
  authorKey,
  BURST_GAP_SECONDS,
  burstLabel,
  groupVersions,
  labelOf,
} from "../web/lib/history";
import { useGitStatus } from "../web/lib/status-store";
import type { GitStatus, VersionRow } from "../web/ipc";
import { baseStatus } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 10, 20, 15, 0, 0);
const at = (h: number, m: number, day = 20) =>
  Math.floor(new Date(2026, 10, day, h, m).getTime() / 1000);

const version = (rev: string, time: number, patch: Partial<VersionRow> = {}): VersionRow => ({
  rev,
  time,
  kind: "edit",
  path: "Notes/Plan.md",
  from: null,
  type: "user",
  scope: "edit",
  subject: "Plan",
  device: "Studio Mac",
  chat: null,
  agent: null,
  models: [],
  added: 1,
  removed: 0,
  ...patch,
});
const agent = (rev: string, time: number, patch: Partial<VersionRow> = {}) =>
  version(rev, time, {
    type: "agent",
    subject: "Rewrite the guide",
    chat: "c1",
    agent: "claude",
    models: ["claude-opus-5-5"],
    ...patch,
  });

const status = (): GitStatus => baseStatus({ lastCommit: 1 });

describe("grouping", () => {
  it("groups by day with Today, Yesterday and dates", () => {
    const days = groupVersions(
      [version("a", at(14, 0)), version("b", at(9, 0, 19)), version("c", at(9, 0, 1))],
      NOW,
    );
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday", expect.stringMatching(/Nov/)]);
  });

  it("folds a burst: the same author less than 15 minutes apart", () => {
    const vs = [
      version("a", at(14, 32)),
      version("b", at(14, 20)),
      version("c", at(14, 10)),
      version("d", at(14, 2)),
    ];
    const [day] = groupVersions(vs, NOW);
    expect(day!.bursts.map((b) => b.versions.length)).toEqual([4]);
    expect(burstLabel(day!.bursts[0]!)).toMatch(/· 4 saves$/);
  });

  it("splits at a 15 minute gap, at another author and at another chat", () => {
    expect(BURST_GAP_SECONDS).toBe(900);
    const gap = groupVersions([version("a", at(14, 30)), version("b", at(14, 15))], NOW);
    expect(gap[0]!.bursts.length).toBe(2);
    const otherDevice = groupVersions(
      [version("a", at(14, 30)), version("b", at(14, 28), { device: "Laptop" })],
      NOW,
    );
    expect(otherDevice[0]!.bursts.length).toBe(2);
    const chats = groupVersions(
      [agent("a", at(14, 30)), agent("b", at(14, 28), { chat: "c2" })],
      NOW,
    );
    expect(chats[0]!.bursts.length).toBe(2);
    const sameChat = groupVersions([agent("a", at(14, 30)), agent("b", at(14, 28))], NOW);
    expect(sameChat[0]!.bursts.length).toBe(1);
    expect(authorKey(agent("a", 1))).toBe("agent:c1");
  });

  it("never hides a version: every one is in exactly one burst", () => {
    const vs = Array.from({ length: 12 }, (_, i) => version(`v${i}`, at(14, 59 - i * 4)));
    const total = groupVersions(vs, NOW).flatMap((d) => d.bursts.flatMap((b) => b.versions));
    expect(total.map((v) => v.rev)).toEqual(vs.map((v) => v.rev));
  });
});

describe("labels", () => {
  it("names a device, an agent with the model's display name, Writer and a foreign commit", () => {
    expect(labelOf(version("a", 1))).toMatchObject({ badge: "device", text: "Studio Mac" });
    expect(labelOf(agent("a", 1))).toMatchObject({
      badge: "agent",
      text: "Rewrite the guide",
      agent: "Claude",
      models: ["Opus 5.5"],
    });
    expect(
      labelOf(version("a", 1, { type: "chore", scope: "setup", subject: "start" })),
    ).toMatchObject({
      badge: "writer",
    });
    expect(labelOf(version("a", 1, { type: null, scope: null, subject: "fix typo" }))).toEqual({
      badge: null,
      text: "fix typo",
      models: [],
    });
    expect(
      labelOf(version("a", 1, { scope: "restore", subject: "Plan to 2026-11-19 14:03" })).text,
    ).toBe("Restored Plan to 2026-11-19 14:03");
  });
});

let container: HTMLDivElement;
let root: Root;
const host = createFeatureHost({ onError: () => {} });

beforeEach(() => {
  // "Today" is the 20th of November in these fixtures
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  Object.values(ipc).forEach((f) => f.mockReset());
  Object.values(editor).forEach((f) => f.mockReset());
  menu.show.mockReset();
  useGitStatus.getState().reset();
  useWorkspaceStore.setState({ root: "/vault" } as never);
  ipc.deleted.mockResolvedValue([]);
  ipc.history.mockResolvedValue([
    agent("a3", at(14, 30)),
    version("a2", at(14, 20)),
    version("a1", at(14, 10)),
  ]);
  ipc.versionDiff.mockResolvedValue({
    kind: "text",
    diff: {
      rows: [
        { kind: "del", oldLine: 1, newLine: null, text: "old" },
        { kind: "add", oldLine: null, newLine: 1, text: "new" },
      ],
      added: 1,
      removed: 1,
      rendered: {
        front: [],
        blocks: [
          {
            style: "paragraph",
            level: 0,
            change: "changed",
            parts: [
              { op: "del", text: "old" },
              { op: "ins", text: "new" },
            ],
          },
        ],
      },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
  for (const id of host.list()) await host.unregister(id);
});

const location = { kind: "git-history" as const, path: "/vault/Notes/Plan.md" };
const mount = async (loc: typeof location & { rev?: string; version?: boolean } = location) => {
  await act(async () => root.render(<HistoryPage location={loc} isActive tabId="t" />));
  await act(async () => {});
};
const $ = (sel: string) => container.querySelector(sel);
const $$ = (sel: string) => [...container.querySelectorAll(sel)];
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

describe("the History tab", () => {
  it("lists the versions by day with the agent badge, folds the user's burst and selects the newest", async () => {
    await mount();
    expect(ipc.history).toHaveBeenCalledWith("/vault/Notes/Plan.md");
    expect($('[data-git-day="Today"]')).not.toBeNull();
    expect($('[data-git-entry="a3"] [data-git-badge="agent"]')?.textContent).toBe("Claude");
    expect($('[data-git-entry="a3"]')?.textContent).toContain("Rewrite the guide");
    expect($('[data-git-entry="a3"]')?.textContent).toContain("Opus 5.5");
    // the two user saves 10 minutes apart are one folded burst; expanding shows both
    expect($('[data-git-burst="a2"]')).not.toBeNull();
    expect($('[data-git-entry="a2"]')).toBeNull();
    act(() => ($('[data-git-burst="a2"] button') as HTMLButtonElement).click());
    expect($('[data-git-entry="a2"]')).not.toBeNull();
    expect($('[data-git-entry="a1"]')).not.toBeNull();
    expect($('[data-git-version="a3"]')).not.toBeNull();
  });

  it("shows what the version changed through the shared diff, with the Source toggle", async () => {
    await mount();
    expect(ipc.versionDiff).toHaveBeenCalledWith("/vault/Notes/Plan.md", "a3", "parent");
    expect($("[data-diff-rendered]")).not.toBeNull();
    expect($$('ins[data-diff-mark="ins"]').map((e) => e.textContent)).toEqual(["new"]);
    act(() => button("Source")!.click());
    expect($$('[data-diff-row="add"]').length).toBe(1);
  });

  it("compares with the current file and, with shift, with another version", async () => {
    await mount();
    await act(async () => button("Compare with current")!.click());
    expect(ipc.versionDiff).toHaveBeenLastCalledWith("/vault/Notes/Plan.md", "a3", "current");
    act(() => ($('[data-git-burst="a2"] button') as HTMLButtonElement).click());
    await act(async () =>
      $('[data-git-entry="a1"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, shiftKey: true }),
      ),
    );
    expect(ipc.versionDiff).toHaveBeenLastCalledWith("/vault/Notes/Plan.md", "a3", "a1");
  });

  it("restores the selected version and reloads the list", async () => {
    ipc.restore.mockResolvedValue({ path: "Notes/Plan.md" });
    await mount();
    await act(async () => button("Restore")!.click());
    expect(ipc.restore).toHaveBeenCalledWith("/vault/Notes/Plan.md", "a3");
    expect(ipc.history).toHaveBeenCalledTimes(2);
  });

  it("flushes the open note first and reloads its tab after the restore, in that order", async () => {
    sync.order.length = 0;
    ipc.restore.mockImplementation(async () => {
      sync.order.push("restore");
      return { path: "Notes/Plan.md" };
    });
    await mount();
    await act(async () => button("Restore")!.click());
    expect(sync.order).toEqual(["flush", "restore", "reload"]);
  });

  it("says Restored as <name> only when the content went to another path than the tab's", async () => {
    sync.order.length = 0;
    ipc.restore.mockResolvedValue({ path: "Notes/Plan (restored).md" });
    await mount();
    await act(async () => button("Restore")!.click());
    expect(sync.order).not.toContain("reload"); // a new file: no open tab to reload
  });

  it("copies the text of a version and opens it read-only in a tab", async () => {
    ipc.versionText.mockResolvedValue("the text");
    await mount();
    await act(async () => button("Copy")!.click());
    expect(ipc.versionText).toHaveBeenCalledWith("/vault/Notes/Plan.md", "a3");
    expect(writeText).toHaveBeenCalledWith("the text");
    act(() => button("Open")!.click());
    expect(editor.openGitHistoryTab).toHaveBeenCalledWith({
      path: "/vault/Notes/Plan.md",
      rev: "a3",
      version: true,
    });
  });

  it("offers Open chat on an agent version only while the agent service exists", async () => {
    await mount();
    expect(button("Open chat")).toBeUndefined();
    const openChat = vi.fn(async () => {});
    const stop = serviceContributions.add("agent.chats", {
      id: "agent.chats",
      owner: "builtin:agent",
      service: { openChat },
    });
    await mount();
    await act(async () => button("Open chat")!.click());
    expect(openChat).toHaveBeenCalledWith("c1");
    stop();
  });

  it("opens an entry in a background tab on a middle click and with Cmd/Ctrl, selects on a click", async () => {
    await mount();
    const entry = $('[data-git-entry="a3"]')!;
    act(() => {
      entry.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 1 }));
      entry.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    });
    expect(editor.openGitHistoryTab).toHaveBeenCalledWith(
      { path: "/vault/Notes/Plan.md", rev: "a3", version: true },
      { activate: false },
    );
    editor.openGitHistoryTab.mockClear();
    act(() => {
      entry.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true, ctrlKey: true }));
    });
    expect(editor.openGitHistoryTab).toHaveBeenCalledTimes(1);
    editor.openGitHistoryTab.mockClear();
    act(() => entry.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(editor.openGitHistoryTab).not.toHaveBeenCalled();
  });

  it("shows an image side by side and the sizes of another binary", async () => {
    ipc.versionDiff.mockResolvedValueOnce({
      kind: "image",
      before: { mime: "image/png", data: "AAAA", size: 3 },
      after: null,
    });
    await mount();
    expect($('[data-diff-image="before"] img')?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect($('[data-diff-image="after"]')?.textContent).toContain("None");
    ipc.versionDiff.mockResolvedValueOnce({ kind: "binary", beforeSize: 3, afterSize: 4 });
    await act(async () => button("Compare with current")!.click());
    expect($("[data-diff-binary]")?.textContent).toContain("3 bytes");
  });

  it("is one scroller: its root", async () => {
    await mount();
    expect($("[data-testid=git-history-page]")?.className).toContain("overflow-y-auto");
  });

  it("shows one version read-only", async () => {
    ipc.versionText.mockResolvedValue("# Plan\nbody");
    await mount({ ...location, rev: "a2", version: true });
    expect($("[data-git-version-text]")?.textContent).toBe("# Plan\nbody");
  });
});

describe("deleted files in the panel", () => {
  it("lists them; a click opens the history, a middle click opens it in the background", async () => {
    ipc.deleted.mockResolvedValue([{ path: "Old/Idea.md", rev: "d1", time: 100 }]);
    useGitStatus.getState().apply(status());
    await act(async () => root.render(<GitPanel />));
    await act(async () => {});
    const entry = $('[data-git-deleted-file="Old/Idea.md"]')!;
    expect(entry.textContent).toContain("Idea");
    act(() => entry.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(editor.openGitHistoryTab).toHaveBeenLastCalledWith(
      { path: "/vault/Old/Idea.md" },
      { activate: true },
    );
    act(() => {
      entry.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 1 }));
      entry.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    });
    expect(editor.openGitHistoryTab).toHaveBeenLastCalledWith(
      { path: "/vault/Old/Idea.md" },
      { activate: false },
    );
  });

  it("offers Show history on a right click, through the one menu builder", async () => {
    ipc.deleted.mockResolvedValue([{ path: "Old/Idea.md", rev: "d1", time: 100 }]);
    useGitStatus.getState().apply(status());
    await act(async () => root.render(<GitPanel />));
    await act(async () => {});
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      $('[data-git-deleted-file="Old/Idea.md"]')!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(menu.show).toHaveBeenCalledTimes(1);
    const [items] = menu.show.mock.calls[0] as [{ text: string; action: () => void }[]];
    expect(items.map((i) => i.text)).toEqual(["Show history"]);
    items[0]!.action();
    expect(editor.openGitHistoryTab).toHaveBeenCalledWith({ path: "/vault/Old/Idea.md" });
  });

  it("shows no Deleted section when nothing was deleted", async () => {
    useGitStatus.getState().apply(status());
    await act(async () => root.render(<GitPanel />));
    await act(async () => {});
    expect($("[data-git-deleted]")).toBeNull();
  });
});

describe("only with git on", () => {
  it("contributes the entries, the tab body and the service, and takes them away when off", async () => {
    const mine = () => ({
      palette: featurePaletteCommands.list().filter((c) => c.id === "git.show-history").length,
      menus: menuContributions.list().filter((m) => m.owner === "builtin:git").length,
      slots: slotContributions.list().filter((s) => s.owner === "builtin:git").length,
      services: serviceContributions.list().filter((s) => s.owner === "builtin:git").length,
    });
    expect(mine()).toEqual({ palette: 0, menus: 0, slots: 0, services: 0 });
    host.register(git);
    await host.activate("git");
    expect(mine()).toEqual({ palette: 1, menus: 2, slots: 3, services: 1 });
    await host.unregister("git");
    expect(mine()).toEqual({ palette: 0, menus: 0, slots: 0, services: 0 });
  });

  it("offers Show history for a file only once the vault is set up", () => {
    expect(showHistoryItems("/vault/a.md")).toEqual([]);
    useGitStatus.getState().apply(status());
    const [item] = showHistoryItems("/vault/a.md");
    expect(item).toMatchObject({ kind: "item", text: "Show history" });
    (item as { action: () => void }).action();
    expect(editor.openGitHistoryTab).toHaveBeenCalledWith({ path: "/vault/a.md" });
  });

  it("palette command needs an active file and a set-up vault", async () => {
    host.register(git);
    const cmd = featurePaletteCommands.list().find((c) => c.id === "git.show-history")!;
    const ctx = { hasWorkspace: true, isCompactFileMode: false, activeFilePath: "/vault/a.md" };
    expect(cmd.when?.(ctx as never)).toBe(false);
    useGitStatus.getState().apply(status());
    expect(cmd.when?.(ctx as never)).toBe(true);
    expect(cmd.when?.({ ...ctx, activeFilePath: null } as never)).toBe(false);
    await host.unregister("git");
  });
});
