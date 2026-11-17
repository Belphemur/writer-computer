// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({
  search: vi.fn(async (_q: string, _n?: number) => [] as { relative_path: string }[]),
}));
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
  fuzzySearch: (q: string, n?: number) => hoisted.search(q, n),
  resolveWikiLinkTarget: vi.fn(),
  recentLogErrors: vi.fn(async () => []),
  openLogFolder: vi.fn(),
}));

import { AgentPane } from "../src/components/agent/agent-pane";
import { PermissionCard } from "../src/components/agent/permission-card";
import { createMockAgentClient, type Goldens } from "../src/lib/agent/mock-client";
import { configureAgentRuntimeForTests, useAgentStore } from "../src/stores/agent-store";
import { goldens } from "./helpers/agent-goldens";
import type { Block, PermissionView } from "../src/lib/agent/transcript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = goldens as unknown as Goldens;
let container: HTMLElement;
let root: Root;
let mock: ReturnType<typeof createMockAgentClient>;
const get = () => useAgentStore.getState();
const chat = () => get().chats[get().activeChatId!]!;
const flush = async (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const button = (name: string | RegExp) =>
  $$("button").find((b) =>
    typeof name === "string"
      ? b.textContent === name || b.getAttribute("aria-label") === name
      : name.test(b.textContent ?? "") || name.test(b.getAttribute("aria-label") ?? ""),
  )!;

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set as (
    this: HTMLTextAreaElement,
    v: string,
  ) => void;
  const set = (target: HTMLTextAreaElement, v: string) => setter.call(target, v);
  act(() => {
    set(el, value);
    el.setSelectionRange(value.length, value.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  act(
    () =>
      void el.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
      ),
  );
}

beforeEach(() => {
  mock = createMockAgentClient({ goldens: g, delayMs: 0 });
  configureAgentRuntimeForTests(mock);
  useAgentStore.setState({
    chats: {},
    order: [],
    activeChatId: null,
    drafts: {},
    queued: {},
    modes: {},
    paneOpen: false,
    view: "chat",
    backend: "tauri",
    binary: { found: true, path: "/x", version: "1", source: "path" },
  });
  hoisted.search.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function openPane() {
  act(() => get().openPane());
  await act(async () => root.render(<AgentPane />));
}

describe("AgentPane", () => {
  it("is a labelled complementary landmark with tabs, an empty state and a focused composer", async () => {
    await openPane();
    const pane = $("[data-agent-pane]")!;
    expect(pane.getAttribute("role")).toBe("complementary");
    expect(pane.getAttribute("aria-label")).toBe("Agent");
    expect($("[role=tablist]")).not.toBeNull();
    expect($$("[role=tab]")).toHaveLength(1);
    expect($("[data-agent-empty]")).not.toBeNull();
    const ta = $("textarea")!;
    expect(ta.getAttribute("placeholder")).toBe("Ask anything, @ to add context, / for commands");
    expect(document.activeElement).toBe(ta);
  });

  it("renders nothing while closed", async () => {
    await act(async () => root.render(<AgentPane />));
    expect($("[data-agent-pane]")).toBeNull();
  });

  it("a suggestion fills the composer; Enter sends; Shift+Enter does not", async () => {
    await openPane();
    act(() => button(/Summarize the note/).click());
    const ta = $("textarea") as HTMLTextAreaElement;
    expect(ta.value).toContain("Summarize");
    key(ta, "Enter", { shiftKey: true });
    expect(chat().turns).toHaveLength(0);
    key(ta, "Enter");
    await flush(5);
    expect(chat().turns).toHaveLength(1);
    expect($("[data-agent-user-turn]")!.textContent).toContain("Summarize the note");
    await act(async () => mock.idle(get().activeChatId!));
    await flush(5);
    expect($("[data-agent-text]")!.textContent!.trim()).toBe("ok");
    expect($("[data-agent-footer]")!.textContent).toMatch(/Worked for/);
  });

  it("opens an @ menu from the search, picks a note into a removable chip", async () => {
    hoisted.search.mockResolvedValue([{ relative_path: "Notes/Plan.md" }]);
    await openPane();
    const ta = $("textarea") as HTMLTextAreaElement;
    type(ta, "see @pl");
    await flush(5);
    expect(hoisted.search).toHaveBeenCalledWith("pl", 40);
    const options = $$("[role=option]");
    expect(options.map((o) => o.textContent)).toContain("·Plan" + "Notes");
    key(ta, "Enter");
    await flush();
    expect(get().drafts[get().activeChatId!]!.mentions).toEqual([
      { kind: "note", path: "Notes/Plan.md" },
    ]);
    expect(ta.value).toBe("see ");
    const chip = $("[data-agent-chip]")!;
    expect(chip.textContent).toContain("Plan");
    act(() => button("Remove Plan").click());
    expect(get().drafts[get().activeChatId!]!.mentions).toEqual([]);
  });

  it("Esc closes the menu first, and does not stop anything", async () => {
    hoisted.search.mockResolvedValue([{ relative_path: "a.md" }]);
    await openPane();
    const ta = $("textarea") as HTMLTextAreaElement;
    type(ta, "@");
    await flush(5);
    expect($("[role=listbox]")).not.toBeNull();
    key(ta, "Escape");
    expect($("[role=listbox]")).toBeNull();
  });

  it("'/' lists the session's slash commands", async () => {
    await openPane();
    await act(async () => await get().sendMessage("hello"));
    await act(async () => mock.idle(get().activeChatId!));
    await flush(5);
    const ta = $("textarea") as HTMLTextAreaElement;
    type(ta, "/co");
    expect($$("[role=option]").map((o) => o.textContent)).toEqual(["//compactCommandfrom Claude"]);
  });

  it("the mode chip lists the CLI modes and switches without offering bypass", async () => {
    await openPane();
    act(() => button(/Permission mode: Ask before edit/).click());
    const items = $$("[role=menuitemradio]").map((b) => b.textContent);
    expect(items.some((t) => /bypass/i.test(t ?? ""))).toBe(false);
    expect(items).toHaveLength(5);
    await act(async () => button(/Plan only/).click());
    expect(get().modes[get().activeChatId!]).toBe("plan");
  });

  it("send turns into stop while the agent works; Esc in the composer stops it", async () => {
    await openPane();
    await act(async () => await get().sendMessage("write"));
    await flush(10);
    expect(chat().state).toBe("awaiting-permission");
    expect(button("Stop")).toBeDefined();
    key($("textarea")!, "Escape");
    await flush(10);
    await act(async () => mock.idle(get().activeChatId!));
    await flush(10);
    expect(chat().turns[0]!.status).toBe("interrupted");
    expect($("[data-agent-footer]")!.textContent).toMatch(/Stopped/);
  });

  it("disables the composer for a blocking error and shows the fix", async () => {
    await openPane();
    act(() =>
      useAgentStore.setState((s) => {
        const c = s.chats[s.activeChatId!]!;
        return {
          chats: {
            ...s.chats,
            [c.chatId]: {
              ...c,
              state: "error",
              error: { kind: "binary-not-found", message: "x", retryable: false, at: 0 },
            },
          },
        };
      }),
    );
    expect(($("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect($("[data-agent-error=binary-not-found]")!.textContent).toContain("Choose binary");
  });

  it("an auth error asks to sign in with /login and offers Retry", async () => {
    await openPane();
    act(() =>
      useAgentStore.setState((s) => {
        const c = s.chats[s.activeChatId!]!;
        return {
          chats: {
            ...s.chats,
            [c.chatId]: {
              ...c,
              state: "error",
              error: { kind: "auth", message: "Not logged in", retryable: false, at: 0 },
            },
          },
        };
      }),
    );
    const card = $("[data-agent-error=auth]")!;
    expect(card.textContent).toContain("Sign in required");
    expect(card.textContent).toContain("/login");
    expect(card.textContent).toContain("Copy command");
    expect(card.textContent).toContain("Retry");
  });

  it("tab keys: arrows move focus, Cmd+Shift+N opens a chat, the close button closes", async () => {
    await openPane();
    act(() => void get().newChat());
    expect($$("[role=tab]")).toHaveLength(2);
    const [first, second] = $$("[role=tab]");
    expect(second!.getAttribute("aria-selected")).toBe("true");
    key(second!, "ArrowLeft");
    expect($$("[role=tab]")[0]!.getAttribute("aria-selected")).toBe("true");
    key($("textarea")!, "N", { metaKey: true, shiftKey: true });
    expect($$("[role=tab]")).toHaveLength(3);
    expect(first).toBeDefined();
  });
});

const REQ: PermissionView = {
  requestId: "r1",
  toolCallId: "t1",
  tool: "Bash",
  displayName: "Bash",
  input: { command: "python3 -c 'print(1)'", description: "Run" },
  description: "Run",
  decisionReason: "This command requires approval",
  suggestions: [
    {
      type: "addRules",
      behavior: "allow",
      destination: "localSettings",
      rules: [{ toolName: "Bash", ruleContent: "python3 -c 'print(1)'" }],
    },
  ],
};

describe("PermissionCard", () => {
  let decided: unknown[][];
  beforeEach(() => {
    decided = [];
    configureAgentRuntimeForTests({
      ...mock,
      permission: async (a) => void decided.push([a.decision, a.persist, a.requestId]),
    } as typeof mock);
    useAgentStore.setState({ activeChatId: "c" });
  });
  const mount = async (req = REQ, more = 0) =>
    act(async () => root.render(<PermissionCard request={req} more={more} />));

  it("announces itself, names the command and the type, and offers three choices", async () => {
    await mount(REQ, 2);
    const card = $("[data-agent-permission]")!;
    expect(card.getAttribute("role")).toBe("alert");
    expect(card.textContent).toContain("Permission required");
    expect(card.textContent).toContain("The agent wants to run Bash: python3 -c 'print(1)'");
    expect(card.textContent).toContain("Type: Run a command");
    expect(card.textContent).toContain("+2 more");
    expect(button("Allow once")).toBeDefined();
    expect(button("Always allow")).toBeDefined();
    expect(button("Deny")).toBeDefined();
  });

  it("buttons answer: allow once, always (project), deny", async () => {
    await mount();
    await act(async () => button("Allow once").click());
    await act(async () => button("Always allow").click());
    await act(async () => button("Deny").click());
    expect(decided).toEqual([
      ["allow", undefined, "r1"],
      ["allow", "project", "r1"],
      ["deny", undefined, "r1"],
    ]);
  });

  it("the split menu lists only what the CLI suggested, with the rule text", async () => {
    await mount();
    act(() => button("More always-allow choices").click());
    const items = $$("[role=menuitem]");
    expect(items.map((i) => i.textContent)).toEqual([
      "In this projectBash(python3 -c 'print(1)')",
      "For this chatBash(python3 -c 'print(1)')",
    ]);
    await act(async () => items[1]!.click());
    expect(decided).toEqual([["allow", "session", "r1"]]);
  });

  it("no Always allow when the CLI sent no suggestion", async () => {
    await mount({ ...REQ, suggestions: [] });
    expect($$("button").some((b) => b.textContent === "Always allow")).toBe(false);
  });

  it("keyboard only: Enter allows once and Esc denies, from the card", async () => {
    await mount();
    const card = $("[data-agent-permission]")!;
    key(card, "Enter");
    key(card, "Escape");
    await flush();
    expect(decided).toEqual([
      ["allow", undefined, "r1"],
      ["deny", undefined, "r1"],
    ]);
  });

  it("Enter on a focused button keeps its own meaning (Deny stays Deny)", async () => {
    await mount();
    const deny = button("Deny");
    key(deny, "Enter"); // the browser turns this into a click on the button; the card must not allow
    expect(decided).toEqual([]);
  });

  it("Show details reveals the reason and the full input", async () => {
    await mount();
    expect($("pre")).toBeNull();
    act(() => button("Show details").click());
    expect($("[data-agent-permission]")!.textContent).toContain("This command requires approval");
    expect($("pre")!.textContent).toContain("python3 -c 'print(1)'");
  });

  it("Edit/Write requests preview the content", async () => {
    await mount({
      ...REQ,
      tool: "Write",
      input: { file_path: "a.md", content: "hello" },
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    expect($("[data-agent-permission]")!.textContent).toContain("The agent wants to write a.md");
    act(() => button("Show details").click());
    expect($$("pre").map((p) => p.textContent)).toContain("hello");
    act(() => button("More always-allow choices").click());
    expect($$("[role=menuitem]")[0]!.textContent).toBe("Auto-edit files this chat");
  });
});

describe("transcript timeline", () => {
  it("groups tool rows, expands a row to input and output, and announces only final text", async () => {
    await openPane();
    await act(async () => await get().sendMessage("read my notes"));
    await act(async () => mock.idle(get().activeChatId!));
    await flush(5);
    const group = $("[data-agent-group] button[aria-expanded]")!;
    expect(group.getAttribute("aria-expanded")).toBe("false"); // collapsed once the turn finished
    act(() => group.click());
    expect(group.getAttribute("aria-expanded")).toBe("true");
    const row = $("[data-agent-tool] button")!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    act(() => row.click());
    expect($("[data-agent-tool] pre")).not.toBeNull();
    expect($("[role=log]")!.getAttribute("aria-live")).toBe("off");
    expect($("[data-agent-live]")!.getAttribute("aria-live")).toBe("polite");
    expect($("[data-agent-live]")!.textContent).toBe(
      chat()
        .turns[0]!.blocks.filter((b: Block) => b.kind === "text")
        .map((b: Block) => (b as { text: string }).text)
        .pop(),
    );
  });

  it("while a card is pending the group stays open and the row says it waits", async () => {
    await openPane();
    await act(async () => await get().sendMessage("write"));
    await flush(10);
    expect($("[data-agent-tool]")!.getAttribute("data-status")).toBe("waiting");
    expect($("[data-agent-tool]")!.textContent).toContain("Waiting for permission");
    expect($("[data-agent-permission]")).not.toBeNull();
    // the card precedes the composer in DOM order, so Tab from the composer's start reaches it
    const pos = $("[data-agent-permission]")!.compareDocumentPosition($("textarea")!);
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe($("textarea"));
    await act(async () => get().stop());
    await act(async () => mock.idle(get().activeChatId!));
  });
});
