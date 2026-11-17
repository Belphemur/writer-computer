// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({ reveal: vi.fn(), search: vi.fn(async () => []) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: hoisted.reveal,
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
vi.mock("../src/lib/tauri", () => ({
  fuzzySearch: hoisted.search,
  resolveWikiLinkTarget: vi.fn(),
  recentLogErrors: vi.fn(async () => []),
  openLogFolder: vi.fn(),
}));

import { AgentPane } from "../src/components/agent/agent-pane";
import type { DiskSkill } from "../src/lib/agent/events";
import { createMockAgentClient, type Goldens } from "../src/lib/agent/mock-client";
import { configureAgentRuntimeForTests, useAgentStore } from "../src/stores/agent-store";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import { goldens } from "./helpers/agent-goldens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DISK: DiskSkill[] = [
  {
    name: "writer-cli",
    description: "Use the writer command line",
    scope: "vault",
    path: ".claude/skills/writer-cli/SKILL.md",
  },
  {
    name: "my-global",
    description: "Mine, from the home folder",
    scope: "global",
    path: "/Users/me/.claude/skills/my-global/SKILL.md",
  },
];

describe("@activenote and the Skills chip", () => {
  let container: HTMLElement;
  let root: Root;
  let mock: ReturnType<typeof createMockAgentClient>;
  const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
  const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const flush = async (ms = 0) =>
    act(async () => void (await new Promise((r) => setTimeout(r, ms))));
  function type(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set as (
      this: HTMLTextAreaElement,
      v: string,
    ) => void;
    act(() => {
      setter.call(el, value);
      el.setSelectionRange(value.length, value.length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const key = (el: Element, k: string) =>
    act(
      () =>
        void el.dispatchEvent(
          new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
        ),
    );
  const ta = () => $("textarea") as HTMLTextAreaElement;
  const id = () => useAgentStore.getState().activeChatId!;
  const draft = () => useAgentStore.getState().drafts[id()]!;

  beforeEach(async () => {
    hoisted.reveal.mockClear();
    mock = createMockAgentClient({ goldens: goldens as unknown as Goldens });
    configureAgentRuntimeForTests({ ...mock, listSkills: vi.fn(async () => DISK) } as typeof mock);
    act(() => {
      useWorkspaceStore.setState({ root: "/v" } as never);
      useEditorStore.setState({ activeFilePath: "/v/Notes/Plan.md" } as never);
    });
    useAgentStore.setState({
      chats: {},
      order: [],
      activeChatId: null,
      drafts: {},
      queued: {},
      modes: {},
      chatModels: {},
      notes: {},
      resuming: {},
      skills: {},
      cliCatalog: null,
      paneOpen: false,
      view: "chat",
      backend: "tauri",
      binary: { found: true, path: "/x", version: "1", source: "path" },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => useAgentStore.getState().openPane());
    await act(async () => root.render(<AgentPane />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("@ lists @activenote first and filters it by what is typed", async () => {
    type(ta(), "@");
    await flush(5);
    expect($$("[role=option]")[0]!.textContent).toContain("activenote");
    expect($$("[role=option]")[0]!.textContent).toContain("Plan.md");
    type(ta(), "@act");
    await flush(5);
    expect($$("[role=option]").map((o) => o.textContent)[0]).toContain("activenote");
    type(ta(), "@zzz");
    await flush(5);
    expect($$("[role=option]").some((o) => o.textContent!.includes("activenote"))).toBe(false);
  });

  it("picking @activenote brings the removed active-note chip back", async () => {
    act(() => $("[aria-label^='Remove Plan']")!.click());
    expect(draft().activeNote).toBe(false);
    expect($("[data-agent-chip]")).toBeNull();
    type(ta(), "@act");
    await flush(5);
    key(ta(), "Enter");
    await flush();
    expect(draft().activeNote).toBe(true);
    expect($("[data-agent-chip]")!.textContent).toContain("Plan");
    expect(ta().value).toBe("@activenote ");
  });

  it("typing @activenote verbatim sends the active note even with the chip removed", async () => {
    act(() => $("[aria-label^='Remove Plan']")!.click());
    const starts: unknown[] = [];
    const send = vi.fn(mock.send);
    configureAgentRuntimeForTests({
      ...mock,
      send,
      listSkills: vi.fn(async () => DISK),
    } as typeof mock);
    void starts;
    await act(async () => await useAgentStore.getState().sendMessage("check @activenote now"));
    await flush(5);
    expect(send.mock.calls[0]![0].context).toEqual([
      { kind: "active-note", path: "Notes/Plan.md", inline: false },
    ]);
    // without it nothing is attached
    await act(async () => await mock.idle(id()));
    await act(async () => await useAgentStore.getState().sendMessage("plain"));
    await flush(5);
    expect(send.mock.calls[1]![0].context).toEqual([]);
  });

  it("two mentions in one message each get a chip, deduplicated, and the text keeps the readable name", async () => {
    hoisted.search.mockResolvedValue([
      { relative_path: "Notes/A.md" },
      { relative_path: "Notes/B.md" },
    ] as never);
    type(ta(), "compare @Notes/A");
    await flush(5);
    key(ta(), "Enter");
    await flush();
    type(ta(), `${ta().value}with @Notes/B`);
    await flush(5);
    const rows = $$("[role=option]").map((o) => o.textContent!);
    const b = rows.findIndex((r) => r.includes("B"));
    for (let i = 0; i < b; i++) key(ta(), "ArrowDown");
    key(ta(), "Enter");
    await flush();
    expect(ta().value).toBe("compare @A with @B ");
    expect(draft().mentions).toEqual([
      { kind: "note", path: "Notes/A.md", label: "A" },
      { kind: "note", path: "Notes/B.md", label: "B" },
    ]);
    type(ta(), `${ta().value}and @Notes/A`);
    await flush(5);
    key(ta(), "Enter");
    await flush();
    expect(draft().mentions).toHaveLength(2);
    act(() => $("[aria-label='Remove A']")!.click());
    expect(ta().value).toContain("@A");
    hoisted.search.mockResolvedValue([] as never);
  });

  it("menu rows show the folder after the name, with the full path as tooltip", async () => {
    hoisted.search.mockResolvedValue([
      { relative_path: "Alpha/Plan.md" },
      { relative_path: "Team/2026/11/Plan.md" },
    ] as never);
    type(ta(), "@Plan");
    await flush(5);
    const rows = $$("[role=option]").filter((o) => !o.textContent!.includes("activenote"));
    expect(rows.map((r) => r.title)).toEqual(["Alpha/Plan.md", "Team/2026/11/Plan.md"]);
    expect(rows[0]!.textContent).toBe("·PlanAlpha");
    expect(rows[1]!.textContent).toBe("·PlanTeam/2026/11");
    hoisted.search.mockResolvedValue([] as never);
  });

  it("two notes with the same label get a folder-qualified token", async () => {
    hoisted.search.mockResolvedValue([
      { relative_path: "Alpha/Plan.md" },
      { relative_path: "Team/Plan.md" },
    ] as never);
    const pick = async (row: number) => {
      const all = $$("[role=option]");
      const rows = all.filter((o) => !o.textContent!.includes("activenote"));
      for (let n = 0; n < all.indexOf(rows[row]!); n++) key(ta(), "ArrowDown");
      key(ta(), "Enter");
      await flush();
    };
    type(ta(), "@Pla");
    await flush(5);
    await pick(0);
    type(ta(), `${ta().value}and @Pla`);
    await flush(5);
    await pick(1);
    expect(ta().value).toBe("@Plan and @Team/Plan ");
    expect(draft().mentions).toEqual([
      { kind: "note", path: "Alpha/Plan.md", label: "Plan" },
      { kind: "note", path: "Team/Plan.md", label: "Team/Plan" },
    ]);
    hoisted.search.mockResolvedValue([] as never);
  });

  it("hints about a token with no attached note, can be dismissed, never blocks send", async () => {
    type(ta(), "check @Plan now");
    await flush(5);
    const hint = () => $("[data-agent-unattached-hint]");
    expect(hint()!.textContent).toContain("@Plan is not attached: pick a note from the menu");
    act(() => hint()!.querySelector<HTMLElement>("[aria-label=Dismiss]")!.click());
    expect(hint()).toBeNull();
    type(ta(), "check @Plan now and @Other now");
    await flush(5);
    expect(hint()!.textContent).toContain("@Other is not attached");
    key(ta(), "Enter");
    await flush(5);
    expect(useAgentStore.getState().chats[id()]!.turns[0]!.user!.text).toBe(
      "check @Plan now and @Other now",
    );
  });

  it("the Skills chip counts every skill, shows source and a global reveal link", async () => {
    await flush(5);
    const chip = $("[data-agent-skills-chip]")!;
    expect(chip.textContent).toBe("Skills (2)");
    act(() => chip.click());
    const rows = $$("[data-agent-skill-row]").map((r) => r.textContent!);
    expect(rows[0]).toContain("/writer-cli");
    expect(rows[0]).toContain("vault");
    expect(rows[1]).toContain("/my-global");
    expect(rows[1]).toContain("global");
    const reveal = $$("[data-agent-skill-row] button").find(
      (b) => b.textContent === "Show in Finder",
    )!;
    act(() => reveal.click());
    expect(hoisted.reveal).toHaveBeenCalledWith("/Users/me/.claude/skills/my-global/SKILL.md");
    expect($$("[data-agent-skill-row] button").some((b) => b.textContent === "Open SKILL.md")).toBe(
      true,
    );
  });

  it("after the first turn the CLI's list marks skills loaded and adds Claude-only ones", async () => {
    await act(async () => await useAgentStore.getState().sendMessage("hello"));
    await flush(20);
    // the mock's session reports its own lists; make them explicit for the assertion
    act(() =>
      useAgentStore.setState((s) => {
        const chat = s.chats[id()]!;
        return {
          chats: {
            ...s.chats,
            [id()]: {
              ...chat,
              session: {
                ...chat.session!,
                skills: ["writer-cli", "plugin-skill"],
                slashCommands: ["writer-cli", "plugin-skill", "compact"],
              },
            },
          },
        };
      }),
    );
    act(() => $("[data-agent-skills-chip]")!.click());
    const rows = $$("[data-agent-skill-row]").map((r) => r.textContent!);
    expect(rows.find((r) => r.includes("/writer-cli"))).toContain("loaded");
    expect(rows.find((r) => r.includes("/my-global"))).toContain("not loaded");
    expect(rows.find((r) => r.includes("/plugin-skill"))).toContain("from Claude");
  });

  it("a new chat gets the window's last CLI list in the / menu, status unknown", async () => {
    act(() =>
      useAgentStore.setState({
        cliCatalog: { slashCommands: ["compact", "plugin-skill"], skills: ["plugin-skill"] },
      }),
    );
    act(() => void useAgentStore.getState().newChat());
    await flush(5);
    type(ta(), "/");
    await flush(5);
    const names = $$("[role=option]").map((o) => o.textContent!);
    expect(names.some((n) => n.includes("/plugin-skill"))).toBe(true);
    expect(names.some((n) => n.includes("/compact"))).toBe(true);
    expect(names.some((n) => n.includes("not loaded"))).toBe(false);
  });
});
