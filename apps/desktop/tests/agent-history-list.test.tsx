// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../src/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import { HistoryList } from "../src/components/agent/history-list";
import type { ChatHistoryClient } from "../src/lib/agent/chat-history-client";
import { serializeChatNote, emptyMeta } from "../src/lib/agent/chat-note";
import type { ChatSummary } from "../src/lib/agent/events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 17);
const mk = (id: string, over: Partial<ChatSummary> = {}): ChatSummary => ({
  chatId: id,
  path: `P/.chats/${id}.md`,
  title: id,
  projectPath: null,
  sessionId: id,
  createdAt: NOW - 3 * DAY,
  updatedAt: NOW - DAY,
  turnCount: 1,
  archived: false,
  pinned: false,
  ...over,
});

let container: HTMLElement;
let root: Root;
let chats: ChatSummary[];
let calls: string[];
let client: ChatHistoryClient;

const flush = () => act(async () => {});
const rows = () => [...container.querySelectorAll<HTMLElement>("[data-agent-history-row]")];
const ids = () => rows().map((r) => r.dataset.agentHistoryRow);
const button = (row: HTMLElement | Document, text: string) =>
  [...(row as HTMLElement).querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;

async function mount(props: Partial<Parameters<typeof HistoryList>[0]> = {}) {
  const onOpen = vi.fn();
  await act(async () => {
    root.render(<HistoryList onOpen={onOpen} client={client} now={() => NOW} {...props} />);
  });
  await flush();
  return onOpen;
}

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  chats = [
    mk("alpha", { title: "Quarterly review", projectPath: "Projects/Demo", preview: "plan q4" }),
    mk("beta", { title: "Groceries", preview: "buy oat milk", updatedAt: NOW - 2 * DAY }),
    mk("gamma", { title: "Archived one", archived: true }),
    mk("delta", { title: "Ancient", updatedAt: NOW - 120 * DAY, projectPath: "Projects/Demo" }),
  ];
  calls = [];
  client = {
    list: vi.fn(async () => chats),
    load: vi.fn(async (chatId: string) => ({
      summary: chats.find((c) => c.chatId === chatId)!,
      markdown: serializeChatNote({
        meta: emptyMeta("5328964b-5fe4-4e06-8843-5cf92bdc9e7c", NOW),
        trimmed: 0,
        extraFrontmatter: "",
        messages: [{ role: "user", id: "u", at: NOW, text: "hello there" }],
      }),
    })),
    save: vi.fn(),
    action: vi.fn(async (chatId, action, title) => {
      calls.push(`${action}:${chatId}${title ? `:${title}` : ""}`);
      if (action === "delete") chats = chats.filter((c) => c.chatId !== chatId);
      if (action === "rename")
        chats = chats.map((c) => (c.chatId === chatId ? { ...c, title: title! } : c));
      return null;
    }),
    replay: vi.fn(),
    permissionRules: vi.fn(),
    removePermissionRule: vi.fn(),
  } as unknown as ChatHistoryClient;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HistoryList", () => {
  it("lists chats grouped by project, hides archived ones, newest first", async () => {
    await mount();
    const groups = [...container.querySelectorAll<HTMLElement>("[data-agent-history-group]")];
    expect(groups.map((g) => g.dataset.agentHistoryGroup)).toEqual(["Projects/Demo", ""]);
    expect(ids()).toEqual(["alpha", "delta", "beta"]);
    expect(container.textContent).not.toContain("Archived one");
  });

  it("shows archived chats on request", async () => {
    await mount();
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => box.click());
    expect(ids()).toContain("gamma");
  });

  it("searches titles and the first message", async () => {
    await mount();
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search chats"]')!;
    await type(search, "oat milk");
    expect(ids()).toEqual(["beta"]);
    await type(search, "zzz");
    expect(container.querySelector("[data-agent-history-empty]")?.textContent).toMatch(/match/);
  });

  it("filters to one project", async () => {
    await mount();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Project"]')!;
    await act(async () => {
      select.value = "Projects/Demo";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(ids()).toEqual(["alpha", "delta"]);
  });

  it("starts filtered when given an initial project", async () => {
    await mount({ initialProject: null });
    expect(ids()).toEqual(["beta"]);
  });

  it("resumes a chat on click", async () => {
    const onOpen = await mount();
    await act(async () => rows()[0].querySelector<HTMLButtonElement>("button")!.click());
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ chatId: "alpha" }));
  });

  it("renames inline and refreshes", async () => {
    await mount();
    await act(async () => button(rows()[0], "Rename").click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Chat title"]')!;
    await type(input, "Renamed chat");
    await act(async () => {
      input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(calls).toEqual(["rename:alpha:Renamed chat"]);
    expect(container.textContent).toContain("Renamed chat");
  });

  it("pins, archives and asks before deleting", async () => {
    await mount();
    await act(async () => button(rows()[0], "Pin").click());
    await act(async () => button(rows()[0], "Archive").click());
    expect(calls).toEqual(["pin:alpha", "archive:alpha"]);
    await act(async () => button(rows()[0], "Delete").click());
    expect(calls).toHaveLength(2);
    expect(container.textContent).toContain("Move this chat note to the Trash?");
    await act(async () => button(rows()[0], "Cancel").click());
    expect(calls).toHaveLength(2);
    await act(async () => button(rows()[0], "Delete").click());
    await act(async () => button(rows()[0], "Move to Trash").click());
    await flush();
    expect(calls.at(-1)).toMatch(/^delete:/);
    expect(ids()).toHaveLength(2);
  });

  it("copies the transcript as markdown and reveals the note", async () => {
    const copyText = vi.fn(async () => {});
    const onReveal = vi.fn();
    await mount({ copyText, onReveal });
    await act(async () => button(rows()[0], "Copy as markdown").click());
    await flush();
    expect(copyText).toHaveBeenCalledWith("**user**\n\nhello there");
    await act(async () => button(rows()[0], "Reveal note").click());
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ chatId: "alpha" }));
  });

  it("offers clean-up of old chats only when keep-days is set, and trashes them", async () => {
    await mount();
    expect(container.querySelector("[data-agent-history-cleanup]")).toBeNull();
    await mount({ keepDays: 90 });
    const bar = container.querySelector<HTMLElement>("[data-agent-history-cleanup]")!;
    expect(bar.textContent).toContain("1 chat not touched for 90 days");
    await act(async () => button(bar, "Clean up").click());
    await act(async () => button(bar, "Move 1 to Trash").click());
    await flush();
    expect(calls).toEqual(["delete:delta"]);
  });

  it("surfaces a load error", async () => {
    client.list = vi.fn(async () => {
      throw new Error("boom");
    });
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("boom");
  });
});
