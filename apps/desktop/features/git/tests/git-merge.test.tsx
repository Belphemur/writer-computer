// The merge view: three columns, a choice above every overlap (Take mine, Take theirs, Take both)
// over an editable Result, a choice per front matter property and per path after a rename, Save
// and Cancel; the entries that open it (the panel's conflict rows with link activation, the note's
// bar, the palette), the binary buttons, and everything that exists only while git is on.
// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const ipc = vi.hoisted(() => ({
  status: vi.fn(),
  history: vi.fn(),
  deleted: vi.fn(),
  conflictOpen: vi.fn(),
  conflictSave: vi.fn(),
  conflictTake: vi.fn(),
  commitNow: vi.fn(),
  setPaused: vi.fn(),
  syncNow: vi.fn(),
  setSyncPaused: vi.fn(),
  dismissNotices: vi.fn(),
  pluginDecision: vi.fn(),
  mergeText: vi.fn(),
}));
vi.mock("../web/ipc", () => ({ ...ipc, GIT_CHANGED: "changed", GIT_APPLYING: "applying" }));
const editor = vi.hoisted(() => ({
  openGitMergeTab: vi.fn(),
  closeTab: vi.fn(),
  getOpenFile: vi.fn(),
  openSettings: vi.fn(),
  openGitHistoryTab: vi.fn(),
}));
vi.mock("@/hooks/editor-api", async (orig) => ({ ...(await orig<object>()), ...editor }));

import { featurePaletteCommands } from "@/lib/features/palette";
import { createFeatureHost } from "@/lib/features/registry";
import { slotContributions } from "@/lib/features/slots";
import { useUIStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import git from "../web";
import MergePage from "../web/components/merge-page";
import GitNoteBar from "../web/components/note-bar";
import GitPanel from "../web/components/panel";
import { both, layoutOf, textFor, valueOf } from "../web/lib/merge-model";
import { summarize } from "../web/lib/state";
import { useGitStatus } from "../web/lib/status-store";
import type { ConflictView, GitStatus } from "../web/ipc";
import { baseStatus } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MINE = "# Title\n\none\nthree from B\nfour\n";
const view = (patch: Partial<ConflictView> = {}): ConflictView => ({
  path: "Note.md",
  theirsPath: null,
  markdown: true,
  mine: MINE,
  properties: [],
  parts: [
    { text: "# Title\n\none\n", conflict: null },
    { text: "", conflict: { base: "three\n", mine: "three from B\n", theirs: "three from A\n" } },
    { text: "four\n", conflict: null },
  ],
  ...patch,
});

const remoteStatus = (patch: Partial<GitStatus> = {}) =>
  baseStatus({
    lastCommit: 1,
    remote: "github.com/me/vault",
    branch: "main",
    conflicts: [{ path: "Note.md", hunks: 1, properties: [], theirsPath: null }],
    ...patch,
  });

let container: HTMLDivElement;
let root: Root;
const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const result = () => EditorView.findFromDOM($('[data-git-merge-column="result"]')!)!;
const column = (name: string) =>
  EditorView.findFromDOM($(`[data-git-merge-column="${name}"]`)!)!.state.doc.toString();
const take = async (choice: string, hunk = 0) =>
  act(async () => $(`[data-git-merge-hunk="${hunk}"] [data-git-merge-take="${choice}"]`)!.click());
const saveButton = () => $("[data-git-merge-save]") as HTMLButtonElement;
const location = { kind: "git-merge" as const, path: "/vault/Note.md" };

async function mountPage(v: ConflictView = view()) {
  ipc.conflictOpen.mockResolvedValue(v);
  await act(async () => root.render(<MergePage location={location} isActive tabId="tab-1" />));
  await act(async () => {});
}

beforeEach(() => {
  Object.values(ipc).forEach((f) => f.mockReset());
  Object.values(editor).forEach((f) => f.mockReset());
  editor.getOpenFile.mockReturnValue(null);
  ipc.conflictSave.mockResolvedValue(remoteStatus({ conflicts: [] }));
  useGitStatus.getState().reset();
  useWorkspaceStore.setState({ root: "/vault" } as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the layout", () => {
  it("builds Mine, Theirs and the starting Result and places every overlap", () => {
    const l = layoutOf(view().parts);
    expect(l.mineDoc).toBe(MINE);
    expect(l.theirsDoc).toBe("# Title\n\none\nthree from A\nfour\n");
    expect(l.resultDoc).toBe(MINE);
    const [h] = l.hunks;
    expect(l.mineDoc.slice(h!.inMine.from, h!.inMine.to)).toBe("three from B\n");
    expect(l.theirsDoc.slice(h!.inTheirs.from, h!.inTheirs.to)).toBe("three from A\n");
    expect(l.resultDoc.slice(h!.inResult.from, h!.inResult.to)).toBe("three from B\n");
  });

  it("takes both as mine then theirs, with a line break when mine has none", () => {
    expect(both("a\n", "b\n")).toBe("a\nb\n");
    expect(both("a", "b\n")).toBe("a\nb\n");
    expect(both("", "b\n")).toBe("b\n");
    expect(textFor({ mine: "m\n", theirs: "t\n" }, "both")).toBe("m\nt\n");
  });

  it("shows a property's value, not its key", () => {
    expect(valueOf("status: done\n")).toBe("done");
    expect(valueOf(null)).toBe("");
  });
});

describe("the page", () => {
  it("shows three columns: Mine, the Result starting as mine, and Theirs", async () => {
    await mountPage();
    expect(column("mine")).toBe(MINE);
    expect(column("result")).toBe(MINE);
    expect(column("theirs")).toBe("# Title\n\none\nthree from A\nfour\n");
    expect($("[data-git-merge-left]")!.textContent).toBe("1 left");
    expect(saveButton().disabled).toBe(true);
    // the overlaps are marked in every column, and Mine and Theirs cannot be typed in
    expect($$(".git-merge-open").length).toBeGreaterThanOrEqual(3);
    const mine = EditorView.findFromDOM($('[data-git-merge-column="mine"]')!)!;
    expect(mine.state.readOnly).toBe(true);
  });

  it.each([
    ["mine", "# Title\n\none\nthree from B\nfour\n"],
    ["theirs", "# Title\n\none\nthree from A\nfour\n"],
    ["both", "# Title\n\none\nthree from B\nthree from A\nfour\n"],
  ])("Take %s makes that exact result, and Save writes it", async (choice, expected) => {
    await mountPage();
    await take(choice);
    expect(result().state.doc.toString()).toBe(expected);
    expect($("[data-git-merge-left]")!.textContent).toBe("Ready");
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(ipc.conflictSave).toHaveBeenCalledWith("Note.md", {
      mine: MINE,
      body: expected,
      picks: [],
      finalPath: null,
    });
    expect(editor.closeTab).toHaveBeenCalledWith("tab-1");
  });

  it("lets a choice be changed, and edited text counts as a decision", async () => {
    await mountPage();
    await take("theirs");
    await take("both");
    expect(result().state.doc.toString()).toContain("three from B\nthree from A\n");
    // typing inside the overlap
    const doc = result().state.doc.toString();
    const at = doc.indexOf("three from A");
    act(() => result().dispatch({ changes: { from: at, to: at + 5, insert: "THREE" } }));
    expect($("[data-git-merge-hunk='0']")!.dataset.gitMergeState).toBe("edited");
    expect(saveButton().disabled).toBe(false);
  });

  it("saves an editable Result as typed", async () => {
    await mountPage();
    act(() =>
      result().dispatch({
        changes: { from: 0, to: result().state.doc.length, insert: "written by hand\n" },
      }),
    );
    // the whole overlap was rewritten: it counts as decided
    expect($("[data-git-merge-hunk]")!.dataset.gitMergeState).toBe("edited");
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(ipc.conflictSave.mock.calls[0]![1]).toMatchObject({ body: "written by hand\n" });
  });

  it("keeps an undecided overlap from being saved: Save waits for a choice", async () => {
    await mountPage();
    expect(saveButton().disabled).toBe(true);
    await act(async () => saveButton().click());
    expect(ipc.conflictSave).not.toHaveBeenCalled();
  });

  it("Cancel closes the tab and writes nothing", async () => {
    await mountPage();
    await take("theirs");
    await act(async () =>
      $$("button")
        .find((b) => b.textContent === "Cancel")!
        .click(),
    );
    expect(editor.closeTab).toHaveBeenCalledWith("tab-1");
    expect(ipc.conflictSave).not.toHaveBeenCalled();
    expect(ipc.conflictTake).not.toHaveBeenCalled();
  });

  it("shows a failed Save and keeps the view", async () => {
    ipc.conflictSave.mockRejectedValue(new Error("Choose a value for: status"));
    await mountPage();
    await take("mine");
    await act(async () => saveButton().click());
    expect($("[role=alert]")!.textContent).toContain("Choose a value");
    expect(editor.closeTab).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);
  });

  it("asks per property when front matter conflicts, and sends the picks", async () => {
    const v = view({
      parts: [{ text: "body\n", conflict: null }],
      properties: [
        {
          name: "status",
          base: "status: draft\n",
          mine: "status: review\n",
          theirs: "status: done\n",
        },
        { name: "owner", base: null, mine: null, theirs: "owner: Sam\n" },
      ],
    });
    await mountPage(v);
    expect($("[data-git-merge-property='status']")!.textContent).toContain("Mine: review");
    expect($("[data-git-merge-property='status']")!.textContent).toContain("Theirs: done");
    expect($("[data-git-merge-property='owner']")!.textContent).toContain("Mine: none");
    expect(saveButton().disabled).toBe(true);
    expect($("[data-git-merge-left]")!.textContent).toBe("2 left");
    const pick = (name: string, side: string) =>
      act(async () =>
        $(`[data-git-merge-property='${name}'] [data-git-merge-pick='${side}']`)!.click(),
      );
    await pick("status", "theirs");
    expect(saveButton().disabled).toBe(true);
    await pick("owner", "mine");
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(ipc.conflictSave.mock.calls[0]![1]).toMatchObject({
      body: "body\n",
      picks: [
        { name: "status", side: "theirs" },
        { name: "owner", side: "mine" },
      ],
    });
  });

  it("offers both names after a rename and sends the one kept", async () => {
    await mountPage(view({ path: "FromB.md", theirsPath: "FromA.md" }));
    await take("mine");
    const radios = $$("[data-git-merge-paths] input[type=radio]") as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    await act(async () => radios[1]!.click());
    await act(async () => saveButton().click());
    expect(ipc.conflictSave.mock.calls[0]![1]).toMatchObject({ finalPath: "FromA.md" });
  });

  it("opens with the user's buffer when the note has unsaved typing, else reads the file", async () => {
    editor.getOpenFile.mockReturnValue({
      frontmatter: null,
      content: "typed buffer\n",
      isDirty: true,
    });
    await mountPage();
    expect(ipc.conflictOpen).toHaveBeenCalledWith("/vault/Note.md", "typed buffer\n");
    act(() => root.unmount());
    root = createRoot(container);
    editor.getOpenFile.mockReturnValue({ frontmatter: null, content: "saved\n", isDirty: false });
    await mountPage();
    expect(ipc.conflictOpen).toHaveBeenLastCalledWith("/vault/Note.md", null);
  });

  it("says so when there is nothing to resolve", async () => {
    ipc.conflictOpen.mockRejectedValue(new Error("This file is not in conflict"));
    await act(async () => root.render(<MergePage location={location} isActive tabId="t" />));
    await act(async () => {});
    expect($("[data-git-merge-empty]")!.textContent).toContain("not in conflict");
  });
});

describe("the ways in", () => {
  const mountPanel = async (s: GitStatus) => {
    useGitStatus.getState().apply(s);
    ipc.deleted.mockResolvedValue([]);
    await act(async () => root.render(<GitPanel />));
    await act(async () => {});
  };

  it("the panel lists each conflict, and a click opens its merge view", async () => {
    await mountPanel(remoteStatus());
    const row = $("[data-git-conflict='Note.md']")!;
    expect(row.textContent).toContain("1 overlap");
    await act(async () => row.click());
    expect(editor.openGitMergeTab).toHaveBeenCalledWith(
      { path: "/vault/Note.md" },
      { activate: true },
    );
  });

  it("a middle click and Cmd/Ctrl-click open it in the background", async () => {
    await mountPanel(remoteStatus());
    const row = $("[data-git-conflict='Note.md']")!;
    act(() => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 1 }));
      row.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    });
    expect(editor.openGitMergeTab).toHaveBeenCalledWith(
      { path: "/vault/Note.md" },
      { activate: false },
    );
    editor.openGitMergeTab.mockClear();
    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true, ctrlKey: true }));
    });
    expect(editor.openGitMergeTab).toHaveBeenCalledWith(
      { path: "/vault/Note.md" },
      { activate: false },
    );
  });

  it("names a rename and the status reads Conflict n, binaries counted", async () => {
    const s = remoteStatus({
      conflicts: [{ path: "B.md", hunks: 0, properties: [], theirsPath: "A.md" }],
      copies: [{ path: "img/p.png", copy: "img/p (conflict B 2026-11-20 1403).png" }],
    });
    expect(summarize(s)).toMatchObject({ label: "Conflict 2", tone: "error" });
    await mountPanel(s);
    expect($("[data-git-conflict='B.md']")!.textContent).toContain("Renamed");
  });

  it("a binary lists its copy with Keep mine, Keep theirs and Keep both", async () => {
    const copies = [{ path: "img/p.png", copy: "img/p (conflict B 2026-11-20 1403).png" }];
    ipc.conflictTake.mockResolvedValue(remoteStatus({ conflicts: [], copies }));
    await mountPanel(remoteStatus({ conflicts: [], copies }));
    const box = $("[data-git-binary='img/p.png']")!;
    expect(box.textContent).toContain("p (conflict B 2026-11-20 1403).png");
    for (const side of ["mine", "theirs", "both"]) {
      await act(async () => box.querySelector<HTMLElement>(`[data-git-keep='${side}']`)!.click());
      expect(ipc.conflictTake).toHaveBeenLastCalledWith("img/p.png", side);
    }
    // the answer is the new status: once Rust has settled it, the row goes
    ipc.conflictTake.mockResolvedValue(remoteStatus({ conflicts: [], copies: [] }));
    await act(async () => box.querySelector<HTMLElement>("[data-git-keep='mine']")!.click());
    expect($("[data-git-binary]")).toBeNull();
  });

  it("an open note in conflict gets a one-line bar that opens the merge view", async () => {
    useGitStatus.getState().apply(remoteStatus());
    await act(async () => root.render(<GitNoteBar path="/vault/Note.md" />));
    const bar = $("[data-git-note-bar]")!;
    expect(bar.textContent).toBe("Changed on another device —Resolve");
    await act(async () => $("[data-git-note-bar-resolve]")!.click());
    expect(editor.openGitMergeTab).toHaveBeenCalledWith({ path: "/vault/Note.md" }, undefined);
    // nothing is opened by itself, and the bar changes nothing in the editor or on disk
    expect(ipc.conflictOpen).not.toHaveBeenCalled();
    expect(ipc.conflictSave).not.toHaveBeenCalled();
  });

  it("shows no bar over a note that is not in conflict", async () => {
    useGitStatus.getState().apply(remoteStatus());
    await act(async () => root.render(<GitNoteBar path="/vault/Other.md" />));
    expect($("[data-git-note-bar]")).toBeNull();
    useGitStatus.getState().apply(remoteStatus({ conflicts: [] }));
    await act(async () => root.render(<GitNoteBar path="/vault/Note.md" />));
    expect($("[data-git-note-bar]")).toBeNull();
  });
});

describe("only with git on", () => {
  const host = createFeatureHost({ onError: () => {} });
  const resolve = () => featurePaletteCommands.list().find((c) => c.id === "git.resolve-conflicts");
  const mineSlots = () =>
    slotContributions
      .list()
      .filter((s) => s.owner === "builtin:git")
      .map((s) => s.slot)
      .sort();
  const ctx = (patch = {}) =>
    ({ hasWorkspace: true, isCompactFileMode: false, activeFilePath: null, ...patch }) as never;

  it("contributes the merge tab, the note bar and the palette entry, and takes them away when off", async () => {
    expect(resolve()).toBeUndefined();
    expect(mineSlots()).toEqual([]);
    host.register(git);
    await host.activate("git");
    expect(mineSlots()).toEqual(["note-bar", "page-view:git-history", "page-view:git-merge"]);
    expect(resolve()).toBeDefined();
    await host.unregister("git");
    expect(resolve()).toBeUndefined();
    expect(mineSlots()).toEqual([]);
  });

  it("offers Resolve conflicts only while a file is in conflict, and opens the active one first", async () => {
    host.register(git);
    await host.activate("git");
    const entry = resolve()!;
    useGitStatus.getState().apply(remoteStatus({ conflicts: [] }));
    expect(entry.when?.(ctx())).toBe(false);
    useGitStatus.getState().apply(
      remoteStatus({
        conflicts: [
          { path: "A.md", hunks: 1, properties: [], theirsPath: null },
          { path: "B.md", hunks: 1, properties: [], theirsPath: null },
        ],
      }),
    );
    expect(entry.when?.(ctx())).toBe(true);
    expect(entry.when?.(ctx({ hasWorkspace: false }))).toBe(false);
    await act(async () => entry.run(ctx({ activeFilePath: "/vault/B.md" })));
    expect(editor.openGitMergeTab).toHaveBeenLastCalledWith({ path: "/vault/B.md" }, undefined);
    await act(async () => entry.run(ctx({ activeFilePath: "/vault/Elsewhere.md" })));
    expect(editor.openGitMergeTab).toHaveBeenLastCalledWith({ path: "/vault/A.md" }, undefined);
    // only binaries: the panel, where they are settled
    useGitStatus
      .getState()
      .apply(
        remoteStatus({ conflicts: [], copies: [{ path: "p.png", copy: "p (conflict).png" }] }),
      );
    await act(async () => entry.run(ctx()));
    expect(useUIStore.getState().sidebarPanel).toBe("git.panel");
    await host.unregister("git");
  });
});
