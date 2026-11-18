// @vitest-environment jsdom
// The chat's changed notes (ADR 2026-11-18): the state, the note, the tray row and the tab.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({ open: vi.fn(), sessionTab: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
vi.mock("@/hooks/workspace-api", async (orig) => ({
  ...(await orig<object>()),
  getWorkspaceRoot: () => "/v",
}));
vi.mock("@/hooks/editor-api", async (orig) => ({
  ...(await orig<object>()),
  navigateToFile: (p: string) => hoisted.open(p.replace("/v/", "")),
  openFileInNewTab: (p: string, o?: { activate?: boolean }) =>
    hoisted.open(p.replace("/v/", ""), o?.activate === false ? "bg" : "tab"),
  openSessionChangesTab: hoisted.sessionTab,
}));

import { SubagentTray } from "@features/agent/web/components/subagent-tray";
import { SessionChangesTab } from "@features/agent/web/components/session-changes-tab";
import { chatFromNote } from "@features/agent/web/lib/chat-from-note";
import { parseChatNote, serializeChatNote } from "@features/agent/web/lib/chat-note";
import {
  buildNote,
  newNoteState,
  noteStateFromDoc,
  recordEvents,
} from "@features/agent/web/lib/chat-persist";
import type { AgentEvent, FileChangeSummary, SessionChanges } from "@features/agent/web/lib/events";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import { createChat, reduceEvents } from "@features/agent/web/lib/reduce";
import {
  hideSessionChanges,
  noteParts,
  restoreSessionChanges,
  selectSessionChanges,
  sessionChangesFiles,
} from "@features/agent/web/lib/session-changes";
import {
  configureAgentRuntimeForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";
import { dispatchMouse } from "@tests/helpers/events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A: FileChangeSummary = { path: "Notes/a.md", status: "modified", added: 2, removed: 1 };
const B: FileChangeSummary = { path: "b.md", status: "added", added: 3, removed: 0 };
const GONE: FileChangeSummary = { path: "Old/gone.md", status: "deleted", added: 0, removed: 4 };
const MOVED: FileChangeSummary = {
  path: "New/m.md",
  status: "renamed",
  added: 0,
  removed: 0,
  oldPath: "Old/m.md",
};
const sc = (files: FileChangeSummary[]): AgentEvent => ({ type: "session-changes", files });
const chatWith = (...events: AgentEvent[]) => reduceEvents(createChat("c1"), events, 1000);

describe("the chat's changed-notes state", () => {
  it("is empty before the first write and appears with it", () => {
    expect(selectSessionChanges(chatWith())).toBeNull();
    const view = selectSessionChanges(chatWith(sc([A])))!;
    expect(view.files).toEqual([A]);
    expect([view.added, view.removed, view.hidden]).toEqual([2, 1, false]);
  });

  it("counts every note across turns and sub-agents, updated on each event", () => {
    const first = chatWith(sc([A]));
    const next = reduceEvents(
      first,
      [
        sc([
          { ...A, added: 5 },
          { ...B, by: "worker" },
        ]),
      ],
      2000,
    );
    const view = selectSessionChanges(next)!;
    expect(view.files.map((f) => f.path)).toEqual(["Notes/a.md", "b.md"]);
    expect([view.added, view.removed]).toEqual([8, 1]);
    expect(view.files[1]!.by).toBe("worker");
  });

  it("hidden by the x, and back with the next change to the list", () => {
    let chat = chatWith(sc([A]));
    chat = { ...chat, sessionChanges: hideSessionChanges(chat.sessionChanges!) };
    expect(selectSessionChanges(chat)!.hidden).toBe(true);
    // the repeat at the end of a turn is the same list: still closed
    chat = reduceEvents(chat, [sc([A])], 2000);
    expect(selectSessionChanges(chat)!.hidden).toBe(true);
    // a new write changes the list: the row comes back
    chat = reduceEvents(chat, [sc([A, B])], 3000);
    expect(selectSessionChanges(chat)!.hidden).toBe(false);
  });

  it("a restored list stays until the backend reports its path; the marker names the rest", () => {
    const restored = restoreSessionChanges([A, GONE]);
    const before = selectSessionChanges({ sessionChanges: restored })!;
    expect([...before.restored].sort()).toEqual(["Notes/a.md", "Old/gone.md"]);
    expect([before.added, before.removed]).toEqual([2, 5]);
    const chat = reduceEvents(
      { ...createChat("c1"), sessionChanges: restored },
      [sc([{ ...A, added: 1 }])],
      1,
    );
    const view = selectSessionChanges(chat)!;
    expect(view.files.map((f) => f.path)).toEqual(["Old/gone.md", "Notes/a.md"]);
    expect([...view.restored]).toEqual(["Old/gone.md"]);
    expect(sessionChangesFiles(chat.sessionChanges!)).toEqual(view.files);
  });

  it("splits a path into name and folder", () => {
    expect(noteParts("Notes/Deep/Plan.md")).toEqual({ name: "Plan", folder: "Notes/Deep" });
    expect(noteParts("b.md")).toEqual({ name: "b", folder: "" });
    expect(noteParts("a/data.csv")).toEqual({ name: "data.csv", folder: "a" });
  });
});

describe("the list in the chat note", () => {
  it("is paths and counts only, round-trips, and restores the row after a reopen", () => {
    let note = newNoteState("c1", null, 0);
    note = recordEvents(note, [sc([A, MOVED])], 5).note;
    const { markdown } = buildNote(createChat("c1"), note, 10, null);
    expect(markdown).toContain("<!-- writer:session-changes ");
    expect(markdown).not.toMatch(/"rows"|"text"/);
    const doc = parseChatNote(markdown);
    expect(doc.sessionChanges).toEqual([A, MOVED]);
    expect(serializeChatNote(doc)).toBe(markdown);
    const chat = chatFromNote(doc, { projectPath: null });
    const view = selectSessionChanges(chat)!;
    expect(view.files).toEqual([A, MOVED]);
    expect(view.restored.size).toBe(2);
    expect(noteStateFromDoc(doc).sessionChanges).toEqual(restoreSessionChanges([A, MOVED]));
  });

  it("a note without the list has none", () => {
    const { markdown } = buildNote(createChat("c1"), newNoteState("c1", null, 0), 10, null);
    expect(markdown).not.toContain("session-changes");
    expect(parseChatNote(markdown).sessionChanges).toBeUndefined();
  });

  it("asks for a write only between turns, never mid-turn", () => {
    const base = newNoteState("c1", null, 0);
    const mid = recordEvents(
      { ...base, pending: [{ type: "text-delta" } as AgentEvent] },
      [sc([A])],
      1,
    );
    expect(mid.finished).toBe(false);
    expect(mid.note.sessionChanges?.live).toEqual([A]);
    expect(recordEvents(base, [sc([A])], 1).finished).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the changed-notes row and the Session changes tab", () => {
  let container: HTMLElement;
  let root: Root;
  const sessionChanges = vi.fn(async (): Promise<SessionChanges | null> => null);
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
  const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];

  function Connected() {
    const chat = useAgentStore((s) => s.chats.c1)!;
    return <SubagentTray chat={chat} />;
  }
  const setChat = (chat: ReturnType<typeof chatWith>) =>
    act(() => useAgentStore.setState((s) => ({ chats: { ...s.chats, c1: chat } })));

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    hoisted.open.mockReset();
    hoisted.sessionTab.mockReset();
    sessionChanges.mockReset().mockResolvedValue(null);
    useSettingsStore.setState({ settings: {} });
    configureAgentRuntimeForTests({
      ...createMockAgentClient({ goldens: goldens as unknown as Goldens }),
      sessionChanges,
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    configureAgentRuntimeForTests(null);
    useAgentStore.setState({ chats: {} });
  });

  it("shows nothing before a write, then one line with the count and the totals", async () => {
    setChat(chatWith());
    await act(async () => root.render(<Connected />));
    expect($("[data-agent-tray]")).toBeNull();
    setChat(chatWith(sc([A, B])));
    expect($("[data-agent-changed-label]")!.textContent).toBe("Changed 2 notes");
    expect($("[data-agent-changed-notes]")!.textContent).toContain("+5");
    expect($("[data-agent-changed-notes] [aria-expanded]")!.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect($$("[data-agent-changed-note]")).toHaveLength(0);
    // counts follow the next event
    setChat(reduceEvents(chatWith(sc([A])), [sc([A, B, GONE])], 2));
    expect($("[data-agent-changed-label]")!.textContent).toBe("Changed 3 notes");
  });

  it("expands into one row per note with name, folder, counts and marks", async () => {
    setChat(chatWith(sc([A, B, GONE, MOVED])));
    await act(async () => root.render(<Connected />));
    act(() => $("[data-agent-changed-notes] [aria-expanded]")!.click());
    const rows = $$("[data-agent-changed-note]");
    expect(rows.map((r) => r.dataset.agentChangedNote)).toEqual([
      "Notes/a.md",
      "b.md",
      "Old/gone.md",
      "New/m.md",
    ]);
    expect(rows[0]!.textContent).toContain("a");
    expect(rows[0]!.textContent).toContain("Notes");
    expect(rows[0]!.textContent).toContain("+2");
    expect(
      rows.map((r) => r.querySelector("[data-agent-changed-mark]")?.textContent ?? ""),
    ).toEqual(["", "created", "deleted", "renamed"]);
    // a deleted note is not a link
    expect(rows[2]!.querySelector('button[aria-label^="Open"]')).toBeNull();
  });

  it("marks a note changed by a command or with an unknown before: no counts, no hidden status guess", async () => {
    const CMD: FileChangeSummary = {
      path: "Notes/run.md",
      status: "modified",
      added: 0,
      removed: 0,
      noDiff: true,
      origin: "command",
      by: "worker",
    };
    const UNKNOWN: FileChangeSummary = { ...CMD, path: "u.md", origin: "before-unknown", by: null };
    setChat(chatWith(sc([A, CMD, UNKNOWN])));
    await act(async () => root.render(<Connected />));
    act(() => $("[data-agent-changed-notes] [aria-expanded]")!.click());
    const rows = $$("[data-agent-changed-note]");
    expect(
      rows.map((r) => r.querySelector("[data-agent-change-origin]")?.textContent ?? ""),
    ).toEqual(["", "by command", "before unknown"]);
    // no counts for them, the ordinary edit keeps its own
    expect(rows[1]!.textContent).not.toMatch(/[+−]\d/);
    expect(rows[0]!.textContent).toContain("+2");
  });

  it("opens a note like a browser link: left click here, middle click a background tab", async () => {
    setChat(chatWith(sc([A])));
    await act(async () => root.render(<Connected />));
    act(() => $("[data-agent-changed-notes] [aria-expanded]")!.click());
    const open = $('[aria-label="Open Notes/a.md"]')!;
    act(() => void dispatchMouse(open, "click", { button: 0 }));
    expect(hoisted.open).toHaveBeenLastCalledWith("Notes/a.md");
    act(() => void dispatchMouse(open, "auxclick", { button: 1 }));
    expect(hoisted.open).toHaveBeenLastCalledWith("Notes/a.md", "bg");
  });

  it("Diff opens the Session changes tab on that note", async () => {
    setChat(chatWith(sc([A, B])));
    await act(async () => root.render(<Connected />));
    act(() => $("[data-agent-changed-notes] [aria-expanded]")!.click());
    act(() => $('[aria-label="Diff of b.md"]')!.click());
    expect(hoisted.sessionTab).toHaveBeenCalledWith({ chatId: "c1", focus: "b.md" });
  });

  it("the x hides the row; the next write brings it back", async () => {
    setChat(chatWith(sc([A])));
    await act(async () => root.render(<Connected />));
    act(() => $('[aria-label="Hide changed notes"]')!.click());
    expect($("[data-agent-tray]")).toBeNull();
    // the end-of-turn repeat does not reopen it
    setChat(reduceEvents(useAgentStore.getState().chats.c1!, [sc([A])], 2));
    expect($("[data-agent-tray]")).toBeNull();
    setChat(reduceEvents(useAgentStore.getState().chats.c1!, [sc([A, B])], 3));
    expect($("[data-agent-changed-label]")!.textContent).toBe("Changed 2 notes");
  });

  it("the setting that hides the Changes card also drops the row's events", () => {
    useSettingsStore.setState({ settings: { "agent.show-turn-changes": false } });
    useAgentStore.setState((s) => ({ chats: { ...s.chats, c1: createChat("c1") } }));
    useAgentStore.getState().ingest("c1", [{ seq: 1, event: sc([A]) } as never], 1);
    expect(useAgentStore.getState().chats.c1!.sessionChanges).toBeUndefined();
  });

  const detail = (): SessionChanges => ({
    files: [
      {
        ...A,
        rows: [
          { kind: "del", oldLine: 1, newLine: null, text: "old first touch" },
          { kind: "add", oldLine: null, newLine: 1, text: "new text" },
        ],
      },
      {
        ...GONE,
        rows: [{ kind: "del", oldLine: 1, newLine: null, text: "removed text" }],
      },
    ],
  });
  const tab = (focus?: string) => (
    <SessionChangesTab
      location={{ kind: "session-changes", chatId: "c1", focus }}
      isActive
      tabId="t"
    />
  );

  it("the tab shows each note against its first-touch version and scrolls to the chosen one", async () => {
    sessionChanges.mockResolvedValue(detail());
    setChat(chatWith(sc([A, GONE])));
    const scrolled: string[] = [];
    const proto = HTMLElement.prototype as { scrollIntoView?: () => void };
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset.sessionChangeFile ?? "");
    };
    await act(async () => root.render(tab("Old/gone.md")));
    await flush();
    expect(sessionChanges).toHaveBeenCalledWith({ chatId: "c1" });
    expect($$("[data-session-change-file]").map((e) => e.dataset.sessionChangeFile)).toEqual([
      "Notes/a.md",
      "Old/gone.md",
    ]);
    expect(container.textContent).toContain("old first touch");
    expect(container.textContent).toContain("removed text"); // a deleted note shows its text
    expect($("[data-session-changes-restart]")).toBeNull();
    expect(scrolled).toEqual(["Old/gone.md"]);
    delete proto.scrollIntoView;
  });

  it("after a restart the list stays, with the mark instead of the diff of an untouched note", async () => {
    sessionChanges.mockResolvedValue({ files: [detail().files[0]!] });
    const restored = { ...createChat("c1"), sessionChanges: restoreSessionChanges([GONE]) };
    setChat(reduceEvents(restored, [sc([A])], 1));
    await act(async () => root.render(tab()));
    await flush();
    expect($("[data-session-changes-restart]")!.textContent).toBe("since Writer restarted");
    const files = $$("[data-session-change-file]");
    expect(files.map((e) => e.dataset.sessionChangeFile)).toEqual(["Old/gone.md", "Notes/a.md"]);
    expect(files[0]!.textContent).toContain("since Writer restarted");
    expect(files[1]!.textContent).toContain("new text");
  });

  it("the tab says why a note has no diff", async () => {
    const CMD: FileChangeSummary = {
      path: "run.md",
      status: "modified",
      added: 0,
      removed: 0,
      noDiff: true,
      origin: "command",
    };
    sessionChanges.mockResolvedValue({ files: [{ ...CMD, rows: [] }] });
    setChat(chatWith(sc([CMD])));
    await act(async () => root.render(tab()));
    await flush();
    const file = $("[data-session-change-file]")!;
    expect(file.querySelector("[data-agent-change-origin='command']")).not.toBeNull();
    expect(file.textContent).toContain("Changed");
    expect(file.textContent).toContain("listed without a diff");
  });

  it("with no changes the tab says so", async () => {
    setChat(chatWith());
    await act(async () => root.render(tab()));
    expect(container.textContent).toBe("No changes");
  });
});
