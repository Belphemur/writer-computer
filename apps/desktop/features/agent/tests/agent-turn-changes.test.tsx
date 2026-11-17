// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({ open: vi.fn() }));
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
}));

import { TurnChangesCard } from "@features/agent/web/components/turn-changes-card";
import { chatFromNote } from "@features/agent/web/lib/chat-from-note";
import { parseChatNote, serializeChatNote } from "@features/agent/web/lib/chat-note";
import {
  buildNote,
  newNoteState,
  recordEvents,
  recordSend,
} from "@features/agent/web/lib/chat-persist";
import {
  collapseContext,
  defaultExpanded,
  middleTruncate,
  totals,
} from "@features/agent/web/lib/diff-rows";
import type {
  AgentEvent,
  DiffRow,
  FileChange,
  RevertOutcome,
  TurnChanges,
  TurnChangesSummary,
} from "@features/agent/web/lib/events";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import { appendUserTurn, createChat, reduceEvents } from "@features/agent/web/lib/reduce";
import type { Turn } from "@features/agent/web/lib/transcript";
import {
  configureAgentRuntimeForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTurnChangesStore } from "@features/agent/web/stores/turn-changes-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summaryOf = (files: TurnChangesSummary["files"], bash = false): TurnChangesSummary => ({
  turnId: "t1",
  files,
  ...(bash ? { bash } : {}),
});
const changesEvent = (s: TurnChangesSummary): AgentEvent => ({ type: "turn-changes", ...s });
const FILE_A = { path: "Notes/a.md", status: "modified", added: 2, removed: 1 } as const;

// ---------------------------------------------------------------------------------------------
describe("diff rows", () => {
  const row = (kind: DiffRow["kind"], n: number): DiffRow => ({
    kind,
    oldLine: kind === "add" ? null : n,
    newLine: kind === "del" ? null : n,
    text: `l${n}`,
  });

  it("folds long unchanged runs, keeping 3 lines around each change", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row("context", i + 1)),
      row("add", 11),
      ...Array.from({ length: 12 }, (_, i) => row("context", i + 12)),
    ];
    const segs = collapseContext(rows);
    expect(segs.map((s) => [s.kind, s.rows.length])).toEqual(
      [
        ["gap", 7],
        ["rows", 3],
        ["rows", 1],
        ["rows", 3],
        ["gap", 9],
      ].reduce<[string, number][]>((acc, cur) => {
        // adjacent "rows" segments merge: 3 context + the change + 3 context
        const last = acc[acc.length - 1];
        if (last && last[0] === cur[0] && cur[0] === "rows") last[1] += cur[1] as number;
        else acc.push([cur[0] as string, cur[1] as number]);
        return acc;
      }, []),
    );
    // the hidden lines are exactly the unchanged ones that are not next to the change
    expect(segs[0]!.rows[0]!.text).toBe("l1");
  });

  it("does not fold when it would hide fewer than two lines", () => {
    const rows = [
      row("del", 1),
      ...[2, 3, 4, 5, 6, 7, 8].map((n) => row("context", n)),
      row("add", 9),
    ];
    expect(collapseContext(rows).every((s) => s.kind === "rows")).toBe(true);
  });

  it("totals, truncation and default expansion", () => {
    expect(totals([FILE_A, { ...FILE_A, added: 5, removed: 0 }])).toEqual({ added: 7, removed: 1 });
    const long = "Projects/Client Alpha/Meetings/2026/11/weekly-sync-notes.md";
    const short = middleTruncate(long, 30);
    expect(short.length).toBeLessThanOrEqual(30);
    expect(short.endsWith("sync-notes.md")).toBe(true);
    expect(middleTruncate("a.md")).toBe("a.md");
    expect(defaultExpanded(1)).toEqual({ card: true, firstFile: true });
    expect(defaultExpanded(5)).toEqual({ card: true, firstFile: false });
    expect(defaultExpanded(6)).toEqual({ card: false, firstFile: false });
  });
});

// ---------------------------------------------------------------------------------------------
describe("reducer: the card's data", () => {
  const base = () =>
    appendUserTurn(createChat("c"), { messageId: "u1", text: "hi", context: [] }, 0, true);

  it("attaches the summary once, to the finished turn, even after the next turn opened", () => {
    let chat = reduceEvents(base(), goldens["ok-turn"]!, 10);
    chat = appendUserTurn(chat, { messageId: "u2", text: "next", context: [] }, 20, true);
    const ev = changesEvent(summaryOf([FILE_A]));
    chat = reduceEvents(chat, [ev, ev], 30);
    expect(chat.turns[0]!.changes?.files).toHaveLength(1);
    expect(chat.turns[1]!.changes).toBeUndefined();
  });

  it("a read-only turn has no changes", () => {
    const chat = reduceEvents(base(), goldens["ok-turn"]!, 10);
    expect(chat.turns[0]!.changes).toBeUndefined();
  });
});

describe("persistence of the summary", () => {
  it("is stored in the note (no contents) and comes back on the turn", () => {
    let note = newNoteState("c1", null, 0);
    note = recordSend(note, { messageId: "m1", text: "edit", context: [], ts: 1 });
    const done = recordEvents(note, goldens["ok-turn"]!, 2);
    expect(done.finished).toBe(true);
    const withChanges = recordEvents(
      done.note,
      [
        changesEvent(
          summaryOf([FILE_A, { path: "b.md", status: "deleted", added: 0, removed: 4 }], true),
        ),
      ],
      3,
    );
    expect(withChanges.finished).toBe(true);
    // a second delivery (resync) changes nothing
    expect(
      recordEvents(withChanges.note, [changesEvent(summaryOf([FILE_A]))], 4).note.messages,
    ).toEqual(withChanges.note.messages);
    const { markdown } = buildNote(
      { chatId: "c1", title: "t", projectPath: null, session: null, resumeSessionId: null },
      withChanges.note,
      5,
    );
    expect(markdown).toContain("writer:changes");
    const doc = parseChatNote(markdown);
    expect(serializeChatNote(doc)).toBe(markdown);
    const chat = chatFromNote(doc, { projectPath: null });
    expect(chat.turns[0]!.changes).toMatchObject({ turnId: "t1", bash: true });
    expect(chat.turns[0]!.changes!.files.map((f) => f.path)).toEqual(["Notes/a.md", "b.md"]);
  });

  it("keeps the sub-agent role of an entry through the note", () => {
    let note = newNoteState("c1", null, 0);
    note = recordSend(note, { messageId: "m1", text: "edit", context: [], ts: 1 });
    const done = recordEvents(note, goldens["ok-turn"]!, 2);
    const withChanges = recordEvents(
      done.note,
      [changesEvent(summaryOf([{ ...FILE_A, by: "worker" }]))],
      3,
    );
    const { markdown } = buildNote(
      { chatId: "c1", title: "t", projectPath: null, session: null, resumeSessionId: null },
      withChanges.note,
      5,
    );
    const chat = chatFromNote(parseChatNote(markdown), { projectPath: null });
    expect(chat.turns[0]!.changes!.files[0]!.by).toBe("worker");
  });

  it("a read-only turn writes no changes comment", () => {
    let note = newNoteState("c1", null, 0);
    note = recordSend(note, { messageId: "m1", text: "hi", context: [], ts: 1 });
    note = recordEvents(note, goldens["ok-turn"]!, 2).note;
    expect(
      buildNote(
        { chatId: "c1", title: "t", projectPath: null, session: null, resumeSessionId: null },
        note,
        3,
      ).markdown,
    ).not.toContain("writer:changes");
  });
});

// ---------------------------------------------------------------------------------------------
describe("store gating", () => {
  beforeEach(() => {
    configureAgentRuntimeForTests(
      createMockAgentClient({ goldens: goldens as unknown as Goldens }),
    );
    useAgentStore.setState({ chats: {}, notes: {}, activeChatId: null });
  });
  afterEach(() => {
    useSettingsStore.setState({ settings: {} });
    configureAgentRuntimeForTests(null);
  });

  function chatWithTurn() {
    let chat = createChat("c1");
    chat = appendUserTurn(chat, { messageId: "u", text: "hi", context: [] }, 0, true);
    useAgentStore.setState({ chats: { c1: chat }, notes: {} });
  }

  it("ingests the summary by default and drops it when agent.show-turn-changes is off", () => {
    chatWithTurn();
    const events = [...goldens["ok-turn"]!, changesEvent(summaryOf([FILE_A]))];
    useAgentStore.getState().ingest("c1", events, 99);
    expect(useAgentStore.getState().chats.c1!.turns[0]!.changes).toBeDefined();

    chatWithTurn();
    useSettingsStore.setState({ settings: { "agent.show-turn-changes": false } });
    useAgentStore.getState().ingest("c1", events, 99);
    expect(useAgentStore.getState().chats.c1!.turns[0]!.changes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
describe("TurnChangesCard", () => {
  let container: HTMLElement;
  let root: Root;
  const turnChanges =
    vi.fn<(a: { chatId: string; turnId: string }) => Promise<TurnChanges | null>>();
  const revertChanges =
    vi.fn<
      (a: { chatId: string; turnId: string; paths: string[] }) => Promise<RevertOutcome[] | null>
    >();
  const flush = async () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const button = (name: string | RegExp) =>
    $$("button").find((b) => {
      const text = `${b.textContent ?? ""}|${b.getAttribute("aria-label") ?? ""}`;
      return typeof name === "string" ? text.includes(name) : name.test(text);
    })!;

  const rows: DiffRow[] = [
    { kind: "context", oldLine: 1, newLine: 1, text: "# Title" },
    { kind: "del", oldLine: 2, newLine: null, text: "old line" },
    { kind: "add", oldLine: null, newLine: 2, text: "new line" },
    ...Array.from({ length: 12 }, (_, i) => ({
      kind: "context" as const,
      oldLine: i + 3,
      newLine: i + 3,
      text: `tail ${i}`,
    })),
  ];
  const detail = (over: Partial<FileChange> = {}): TurnChanges => ({
    turnId: "t1",
    files: [
      {
        ...FILE_A,
        rows,
        undo: "available",
        ...over,
      },
    ],
  });
  const turn = (
    changes: TurnChangesSummary | undefined,
    status: Turn["status"] = "completed",
  ): Turn => ({
    id: "turn-0",
    user: null,
    blocks: [],
    status,
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    usage: null,
    liveOutputTokens: 0,
    errors: [],
    ...(changes ? { changes } : {}),
  });
  const mount = async (t: Turn) => {
    await act(async () => root.render(<TurnChangesCard chatId="c1" turn={t} />));
    await flush();
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    turnChanges.mockReset().mockResolvedValue(detail());
    revertChanges.mockReset().mockResolvedValue([{ path: FILE_A.path, result: "reverted" }]);
    hoisted.open.mockReset();
    useTurnChangesStore.setState({ entries: {} });
    useSettingsStore.setState({ settings: {} });
    configureAgentRuntimeForTests({
      ...createMockAgentClient({ goldens: goldens as unknown as Goldens }),
      turnChanges: turnChanges,
      revertChanges: revertChanges,
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    configureAgentRuntimeForTests(null);
    useSettingsStore.setState({ settings: {} });
  });

  it("a single-file turn shows the header, the diff with line numbers and folded context", async () => {
    await mount(turn(summaryOf([FILE_A])));
    const region = container.querySelector('[role="region"]')!;
    expect(region.getAttribute("aria-label")).toBe("Changes: 1 file changed, 2 added, 1 removed");
    expect(container.textContent).toContain("1 file changed");
    expect(container.textContent).toContain("+2");
    expect(turnChanges).toHaveBeenCalledWith({ chatId: "c1", turnId: "t1" });
    const added = container.querySelector('[data-diff-row="add"]')!;
    const removed = container.querySelector('[data-diff-row="del"]')!;
    expect(added.textContent).toContain("new line");
    expect(removed.textContent).toContain("old line");
    expect(added.textContent).toMatch(/2/); // new line number
    // 12 trailing unchanged lines: 3 kept, 9 folded behind a button
    expect(button("Show 9 lines")).toBeDefined();
    expect(container.textContent).not.toContain("tail 5");
    await act(async () => button("Show 9 lines").click());
    expect(container.textContent).toContain("tail 5");
  });

  it("labels a file a sub-agent edited with its role, and none the main agent edited", async () => {
    await mount(
      turn(
        summaryOf([
          { ...FILE_A, by: "worker" },
          { ...FILE_A, path: "b.md" },
        ]),
      ),
    );
    const labels = [...container.querySelectorAll<HTMLElement>("[data-agent-change-by]")];
    expect(labels.map((l) => l.textContent)).toEqual(["worker"]);
    expect(
      container.querySelector('[data-agent-change-file="Notes/a.md"] [data-agent-change-by]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-agent-change-file="b.md"] [data-agent-change-by]'),
    ).toBeNull();
  });

  it("more than five files start collapsed and the header toggles them", async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `n${i}.md`,
      status: "modified" as const,
      added: 1,
      removed: 0,
    }));
    await mount(turn(summaryOf(files)));
    const header = button("6 files changed");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-agent-change-file]")).toBeNull();
    expect(turnChanges).not.toHaveBeenCalled();
    await act(async () => header.click());
    await flush();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect($$("[data-agent-change-file]")).toHaveLength(6);
    // several files: rows are listed, diffs stay folded until asked for
    expect(container.querySelector("[data-agent-diff]")).toBeNull();
  });

  it("every control is a labelled button with aria-expanded, so Enter and Space work", async () => {
    const files = [FILE_A, { path: "b.md", status: "added" as const, added: 3, removed: 0 }];
    await mount(turn(summaryOf(files)));
    const toggle = button("Show diff of Notes/a.md");
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBeTruthy();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Hide diff of Notes/a.md");
    for (const b of $$("button"))
      expect(`${b.textContent}${b.getAttribute("aria-label")}`.trim()).not.toBe("");
  });

  it("clicking the file name opens it in the editor; a deleted file is not a link", async () => {
    await mount(
      turn(summaryOf([FILE_A, { path: "gone.md", status: "deleted", added: 0, removed: 3 }])),
    );
    await act(async () => button("Open Notes/a.md").click());
    expect(hoisted.open).toHaveBeenCalledWith("Notes/a.md");
    await act(async () => {
      button("Open Notes/a.md").dispatchEvent(
        new MouseEvent("auxclick", { bubbles: true, button: 1 }),
      );
    });
    expect(hoisted.open).toHaveBeenLastCalledWith("Notes/a.md", "bg"); // middle-click: background tab
    expect($$("button").some((b) => b.getAttribute("aria-label") === "Open gone.md")).toBe(false);
  });

  it("long paths wrap and carry the full path in a tooltip", async () => {
    const long =
      "Projects/Client Alpha/Meetings/2026/11/a-very-long-weekly-sync-notes-file-name.md";
    await mount(turn(summaryOf([{ ...FILE_A, path: long }])));
    const name = button(`Open ${long}`);
    expect(name.title).toBe(long);
    expect(name.className).toContain("break-all");
    expect(name.textContent!.length).toBeLessThan(long.length);
  });

  it("Undo asks first, then reverts and refreshes the state", async () => {
    await mount(turn(summaryOf([FILE_A])));
    await act(async () => button("Undo changes to Notes/a.md").click());
    expect(revertChanges).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Undo changes to Notes/a.md?");
    turnChanges.mockResolvedValue(detail({ undo: "reverted" }));
    await act(async () => button("Confirm undo").click());
    await flush();
    expect(revertChanges).toHaveBeenCalledWith({
      chatId: "c1",
      turnId: "t1",
      paths: [FILE_A.path],
    });
    expect(container.textContent).toContain("Undone");
  });

  it("cancelling the confirmation reverts nothing", async () => {
    await mount(turn(summaryOf([FILE_A])));
    await act(async () => button("Undo changes to Notes/a.md").click());
    await act(async () => button("Cancel").click());
    expect(revertChanges).not.toHaveBeenCalled();
  });

  it("Undo all covers every file that can still be undone", async () => {
    const files = [
      FILE_A,
      { path: "b.md", status: "added" as const, added: 3, removed: 0 },
      { path: "c.md", status: "modified" as const, added: 1, removed: 1 },
    ];
    turnChanges.mockResolvedValue({
      turnId: "t1",
      files: [
        { ...files[0]!, rows: [], undo: "available" },
        { ...files[1]!, rows: [], undo: "available" },
        { ...files[2]!, rows: [], undo: "changed-since" },
      ],
    });
    revertChanges.mockResolvedValue([]);
    await mount(turn(summaryOf(files)));
    expect(container.textContent).toContain("File changed since");
    await act(async () => button("Undo all").click());
    expect(container.textContent).toContain("Undo changes to 2 files?");
    await act(async () => button("Confirm undo").click());
    await flush();
    expect(revertChanges).toHaveBeenCalledWith({
      chatId: "c1",
      turnId: "t1",
      paths: ["Notes/a.md", "b.md"],
    });
  });

  it("a file that changed since the turn cannot be undone, and says so inline", async () => {
    turnChanges.mockResolvedValue(detail({ undo: "changed-since" }));
    await mount(turn(summaryOf([FILE_A])));
    expect(container.textContent).toContain("File changed since");
    expect(
      $$("button").some((b) => (b.getAttribute("aria-label") ?? "").startsWith("Undo changes")),
    ).toBe(false);
  });

  it("a refused or failed Undo is shown inline as an error", async () => {
    revertChanges.mockResolvedValue([
      { path: FILE_A.path, result: "failed", message: "permission denied" },
    ]);
    await mount(turn(summaryOf([FILE_A])));
    await act(async () => button("Undo changes to Notes/a.md").click());
    await act(async () => button("Confirm undo").click());
    await flush();
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("permission denied");

    revertChanges.mockRejectedValue(new Error("ipc down"));
    await act(async () => button("Undo changes to Notes/a.md").click());
    await act(async () => button("Confirm undo").click());
    await flush();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("ipc down");
  });

  it("without a snapshot the counts stay and the diff says it is gone", async () => {
    turnChanges.mockResolvedValue(null);
    await mount(turn(summaryOf([FILE_A])));
    expect(container.textContent).toContain("+2");
    expect(container.textContent).toContain("Diff no longer available after restart");
    expect(
      $$("button").some((b) => (b.getAttribute("aria-label") ?? "").startsWith("Undo changes")),
    ).toBe(false);
  });

  it("a load error is inline and a binary file is listed without a diff", async () => {
    turnChanges.mockRejectedValue(new Error("boom"));
    await mount(turn(summaryOf([FILE_A])));
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("boom");

    act(() => root.unmount());
    root = createRoot(container);
    useTurnChangesStore.setState({ entries: {} });
    turnChanges.mockResolvedValue({
      turnId: "t1",
      files: [
        {
          path: "logo.png",
          status: "modified",
          added: 0,
          removed: 0,
          noDiff: true,
          rows: [],
          undo: "unavailable",
        },
      ],
    });
    await mount(
      turn(
        summaryOf([{ path: "logo.png", status: "modified", added: 0, removed: 0, noDiff: true }]),
      ),
    );
    expect(container.textContent).toContain("listed without a diff");
  });

  it("mentions that shell commands are not tracked only when one ran", async () => {
    await mount(turn(summaryOf([FILE_A], true)));
    expect(container.textContent).toContain("A shell command ran in this turn");
    await mount(turn(summaryOf([FILE_A], false)));
    expect(container.textContent).not.toContain("A shell command ran");
  });

  it("renders nothing for a read-only turn, a running turn or when the setting is off", async () => {
    await mount(turn(undefined));
    expect(container.innerHTML).toBe("");
    await mount(turn(summaryOf([FILE_A]), "running"));
    expect(container.innerHTML).toBe("");
    useSettingsStore.setState({ settings: { "agent.show-turn-changes": false } });
    await mount(turn(summaryOf([FILE_A])));
    expect(container.innerHTML).toBe("");
  });

  it("a long diff is capped behind Show more", async () => {
    const many: DiffRow[] = Array.from({ length: 1000 }, (_, i) => ({
      kind: "add",
      oldLine: null,
      newLine: i + 1,
      text: `row ${i}`,
    }));
    turnChanges.mockResolvedValue(detail({ rows: many }));
    await mount(turn(summaryOf([{ ...FILE_A, added: 1000, removed: 0 }])));
    expect($$("[data-diff-row]").length).toBe(400);
    await act(async () => button("Show more").click());
    expect($$("[data-diff-row]").length).toBe(800);
  });
});
