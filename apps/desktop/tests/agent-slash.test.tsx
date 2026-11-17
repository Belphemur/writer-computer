// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
vi.mock("../src/lib/tauri", () => ({
  fuzzySearch: async () => [],
  resolveWikiLinkTarget: vi.fn(),
  recentLogErrors: vi.fn(async () => []),
  openLogFolder: vi.fn(),
}));

import { AgentPane } from "../src/components/agent/agent-pane";
import type { DiskSkill } from "../src/lib/agent/events";
import { createMockAgentClient, type Goldens } from "../src/lib/agent/mock-client";
import {
  SLASH_EMPTY_TEXT,
  loadedLabel,
  applySlash,
  filterSlash,
  mergeSlashItems,
  slashQuery,
} from "../src/lib/agent/slash-commands";
import { configureAgentRuntimeForTests, useAgentStore } from "../src/stores/agent-store";
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
    name: "writer-search",
    description: "Search the vault from the shell",
    scope: "vault",
    path: ".agents/skills/writer-search/SKILL.md",
  },
  {
    name: "release-notes",
    description: "Draft bullets for a release",
    scope: "project",
    path: "P/.claude/skills/release-notes/SKILL.md",
  },
  {
    name: "my-global",
    description: "Mine, from the home folder",
    scope: "global",
    path: "/Users/me/.claude/skills/my-global/SKILL.md",
  },
];

describe("slash menu logic", () => {
  it("merges disk skills and the CLI's list by name: project, vault, global, then Claude-only", () => {
    const items = mergeSlashItems(DISK, {
      slashCommands: ["compact", "context", "Writer-CLI", "user-skill"],
      skills: ["user-skill", "writer-cli"],
    });
    expect(items.map((i) => i.name)).toEqual([
      "release-notes",
      "writer-cli",
      "writer-search",
      "my-global",
      "user-skill",
      "compact",
      "context",
    ]);
    expect(items.map((i) => i.source)).toEqual([
      "project",
      "vault",
      "vault",
      "global",
      "cli",
      "cli",
      "cli",
    ]);
    expect(items[1]).toMatchObject({ kind: "skill", description: "Use the writer command line" });
    expect(items.find((i) => i.name === "user-skill")).toMatchObject({
      source: "cli",
      kind: "skill",
    });
    expect(items.find((i) => i.name === "compact")).toMatchObject({
      source: "cli",
      kind: "command",
    });
  });

  it("precedence project over vault over global for the same name", () => {
    const mk = (scope: DiskSkill["scope"], d: string): DiskSkill => ({
      name: "dup",
      description: d,
      scope,
      path: d,
    });
    const items = mergeSlashItems([mk("global", "g"), mk("vault", "v"), mk("project", "p")], null);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "project", description: "p" });
  });

  it("loaded means the CLI listed it for this chat; null before any session", () => {
    const cli = {
      slashCommands: ["writer-cli", "compact"],
      skills: ["writer-cli", "plugin-skill"],
    };
    const own = mergeSlashItems(DISK, cli);
    const by = (n: string) => own.find((i) => i.name === n)!;
    expect(by("writer-cli").loaded).toBe(true);
    expect(by("release-notes").loaded).toBe(false); // on disk, not in the CLI's list
    expect(by("my-global").loaded).toBe(false);
    expect(by("plugin-skill")).toMatchObject({ source: "cli", loaded: true, kind: "skill" });
    expect(loadedLabel(by("writer-cli"))).toBe("loaded");
    expect(loadedLabel(by("release-notes"))).toBe("not loaded");
    expect(loadedLabel(by("compact"))).toBe(""); // commands have no loaded state
    const before = mergeSlashItems(DISK, null);
    expect(before.every((i) => i.loaded === null)).toBe(true);
    expect(loadedLabel(before[0]!)).toBe("");
  });

  it("a chat without a session of its own shows the window's last CLI list, status unknown", () => {
    const items = mergeSlashItems(DISK, null, {
      slashCommands: ["compact", "context"],
      skills: ["plugin-skill"],
    });
    expect(items.map((i) => i.name)).toContain("plugin-skill");
    expect(items.map((i) => i.name)).toContain("compact");
    expect(items.every((i) => i.loaded === null)).toBe(true);
  });

  it("lists nothing before any source exists (no invented built-ins)", () => {
    expect(mergeSlashItems([], null)).toEqual([]);
  });

  it("shows the menu for a leading slash, also after spaces, never mid-sentence or in a path", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/wri")).toBe("wri");
    expect(slashQuery("   /wri")).toBe("wri");
    expect(slashQuery("\n/x")).toBe("x");
    expect(slashQuery("see /wri")).toBeNull();
    expect(slashQuery("/usr/bin/env")).toBeNull();
    expect(slashQuery("/foo bar")).toBeNull();
    expect(slashQuery("a/b")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });

  it("picking replaces only the command word", () => {
    expect(applySlash("/wri", "writer-cli")).toBe("/writer-cli ");
    expect(applySlash("  /", "compact")).toBe("/compact ");
  });

  it("filters fuzzily on the name with the vault ranker, then by description words", () => {
    const items = mergeSlashItems(DISK, { slashCommands: ["compact"], skills: [] });
    expect(filterSlash(items, "").map((i) => i.name)).toHaveLength(5);
    expect(filterSlash(items, "search")[0]!.name).toBe("writer-search");
    expect(filterSlash(items, "wcli").map((i) => i.name)).toEqual(["writer-cli"]);
    expect(filterSlash(items, "relnot").map((i) => i.name)).toContain("release-notes");
    expect(filterSlash(items, "notes").map((i) => i.name)).toContain("release-notes");
    expect(filterSlash(items, "bullets").map((i) => i.name)).toEqual(["release-notes"]);
    expect(filterSlash(items, "zzzz")).toEqual([]);
    expect(filterSlash(items, "", 2)).toHaveLength(2);
  });
});

describe("the / menu in the composer", () => {
  let container: HTMLElement;
  let root: Root;
  let mock: ReturnType<typeof createMockAgentClient>;
  let disk: DiskSkill[];
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

  beforeEach(async () => {
    disk = DISK;
    mock = createMockAgentClient({ goldens: goldens as unknown as Goldens });
    configureAgentRuntimeForTests({ ...mock, listSkills: vi.fn(async () => disk) } as typeof mock);
    useAgentStore.setState({
      chats: {},
      order: [],
      activeChatId: null,
      drafts: {},
      queued: {},
      modes: {},
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
  const ta = () => $("textarea") as HTMLTextAreaElement;
  const rows = () => $$("[role=option]").map((o) => o.textContent);

  it("typing / lists the skills found on disk with a description and a source tag, before any session", async () => {
    type(ta(), "/");
    await flush(5);
    expect(rows()).toEqual([
      "//release-notesDraft bullets for a releaseproject",
      "//writer-cliUse the writer command linevault",
      "//writer-searchSearch the vault from the shellvault",
      "//my-globalMine, from the home folderglobal",
    ]);
    expect(useAgentStore.getState().skills[""]!.status).toBe("ready");
  });

  it("filters while typing, and Enter or Tab inserts '/name ' for the user to add arguments", async () => {
    type(ta(), "/");
    await flush(5);
    type(ta(), "/sea");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("/writer-search");
    key(ta(), "Enter");
    const id = useAgentStore.getState().activeChatId!;
    expect(useAgentStore.getState().drafts[id]!.text).toBe("/writer-search ");
    expect($("[role=listbox]")).toBeNull();
    // nothing was sent by picking
    expect(useAgentStore.getState().chats[id]!.turns).toHaveLength(0);
    type(ta(), "/");
    await flush(5);
    key(ta(), "ArrowDown");
    key(ta(), "Tab");
    expect(useAgentStore.getState().drafts[id]!.text).toBe("/writer-cli ");
  });

  it("the typed text, not a rewritten one, is what gets sent", async () => {
    const send = vi.spyOn(mock, "send");
    configureAgentRuntimeForTests({ ...mock, send, listSkills: async () => disk } as typeof mock);
    type(ta(), "/writer-cli list notes");
    expect($("[role=listbox]")).toBeNull(); // a space ends the command word
    key(ta(), "Enter");
    await flush(5);
    expect(send.mock.calls[0]![0].text).toBe("/writer-cli list notes");
  });

  it("appears after leading spaces but not mid-sentence or for a path", async () => {
    type(ta(), "  /wr");
    await flush(5);
    expect(rows().length).toBeGreaterThan(0);
    type(ta(), "please run /wr");
    expect($("[role=listbox]")).toBeNull();
    type(ta(), "/usr/bin");
    expect($("[role=listbox]")).toBeNull();
  });

  it("explains where skills are read from when there are none", async () => {
    disk = [];
    type(ta(), "/");
    await flush(5);
    expect($("[role=listbox]")!.textContent).toBe(SLASH_EMPTY_TEXT);
    expect(SLASH_EMPTY_TEXT).toBe(
      "No skills found. Skills live in .claude/skills or .agents/skills.",
    );
  });

  it("a filter with no hit says so without the where-from text", async () => {
    type(ta(), "/");
    await flush(5);
    type(ta(), "/zzzz");
    expect($("[role=listbox]")!.textContent).toBe("No matching commands");
  });

  it("once the CLI has reported its list, built-ins and user skills join the disk skills", async () => {
    await act(async () => await useAgentStore.getState().sendMessage("hello"));
    await act(async () => mock.idle(useAgentStore.getState().activeChatId!));
    await flush(10);
    type(ta(), "/");
    await flush(5);
    const names = rows().map((r) => r!.split(/(?=[A-Z])/)[0]);
    expect(names.join(" ")).toContain("/compact");
    expect(names.join(" ")).toContain("/init");
    expect(rows().some((r) => r!.startsWith("//writer-cli") && r!.endsWith("not loaded"))).toBe(
      true,
    );
  });

  it("a failing lookup still shows the CLI's list and does not break typing", async () => {
    configureAgentRuntimeForTests({
      ...mock,
      listSkills: async () => {
        throw new Error("denied");
      },
    } as typeof mock);
    act(() => useAgentStore.setState({ skills: {} })); // the mount-time load already ran
    type(ta(), "/");
    await flush(5);
    expect(useAgentStore.getState().skills[""]!.status).toBe("error");
    expect($("[role=listbox]")!.textContent).toBe(SLASH_EMPTY_TEXT);
  });
});
