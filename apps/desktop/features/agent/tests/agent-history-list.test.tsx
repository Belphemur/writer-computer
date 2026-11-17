// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import { HistoryList } from "@features/agent/web/components/history-list";
import type { ChatHistoryClient } from "@features/agent/web/lib/chat-history-client";
import { serializeChatNote, emptyMeta } from "@features/agent/web/lib/chat-note";
import type { RegenerateOutcome } from "@features/agent/web/lib/auto-title";
import type { ChatSummary } from "@features/agent/web/lib/events";

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
  titleSource: "none",
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
    regenerateTitle: vi.fn(),
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

  describe("row menu and Regenerate title", () => {
    const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
    const item = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (b) => b.textContent === label,
      )!;
    const more = (row: HTMLElement) =>
      row.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!;
    const openMenu = async (row = rows()[0]) => act(async () => more(row).click());
    const deferred = () => {
      let resolve!: (o: RegenerateOutcome) => void;
      const promise = new Promise<RegenerateOutcome>((r) => (resolve = r));
      return { promise, resolve };
    };
    const done = (id: string, title: string): RegenerateOutcome => ({
      status: "done",
      summary: mk(id, { title, titleSource: "auto" }),
    });
    const retitle = (id: string, title: string, titleSource: ChatSummary["titleSource"]) => {
      chats = chats.map((c) => (c.chatId === id ? { ...c, title, titleSource } : c));
    };

    it("opens from the ... button with every action, and closes on Esc, outside click and a pick", async () => {
      await mount();
      await openMenu();
      expect(menu()).not.toBeNull();
      expect(more(rows()[0]).getAttribute("aria-expanded")).toBe("true");
      expect([...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual(
        [
          "Resume",
          "Rename",
          "Pin",
          "Archive",
          "Regenerate title",
          "Copy as markdown",
          "Reveal note",
          "Delete",
        ],
      );
      await act(async () =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(menu()).toBeNull();
      await openMenu();
      await act(async () =>
        document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
      );
      expect(menu()).toBeNull();
      // the other actions stay reachable from the menu
      await openMenu();
      await act(async () => item("Pin").click());
      expect(menu()).toBeNull();
      expect(calls).toEqual(["pin:alpha"]);
    });

    it("opens on right click and moves with the arrow keys", async () => {
      await mount();
      await act(async () => {
        rows()[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
      expect(menu()).not.toBeNull();
      expect(document.activeElement).toBe(item("Resume"));
      const key = (k: string) =>
        act(async () => {
          menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
        });
      await key("ArrowDown");
      expect(document.activeElement).toBe(item("Rename"));
      await key("ArrowUp");
      await key("ArrowUp");
      expect(document.activeElement).toBe(item("Delete"));
    });

    it("regenerates a closed chat: Generating... on its row, then the new title", async () => {
      const d = deferred();
      const regenerateTitle = vi.fn(() => d.promise);
      await mount({ regenerateTitle });
      await openMenu();
      await act(async () => item("Regenerate title").click());
      expect(regenerateTitle).toHaveBeenCalledWith("alpha");
      const status = rows()[0].querySelector('[role="status"]')!;
      expect(status.textContent).toContain("Generating");
      expect(container.textContent).toContain("Quarterly review");
      // the entry is disabled while the call runs
      await openMenu();
      expect(item("Regenerate title").disabled).toBe(true);
      await act(async () =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      retitle("alpha", "Q4 review plan", "auto");
      await act(async () => d.resolve(done("alpha", "Q4 review plan")));
      await flush();
      expect(rows()[0].querySelector('[role="status"]')).toBeNull();
      expect(container.textContent).toContain("Q4 review plan");
      expect(container.textContent).not.toContain("Quarterly review");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    it("shows a short inline error, keeps the old title, and allows a retry", async () => {
      const regenerateTitle = vi
        .fn<(id: string) => Promise<RegenerateOutcome>>()
        .mockResolvedValueOnce({ status: "refused", reason: "no-binary" })
        .mockRejectedValueOnce(new Error("disk full"));
      await mount({ regenerateTitle });
      await openMenu();
      await act(async () => item("Regenerate title").click());
      await flush();
      const alert = rows()[0].querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain("Claude Code was not found");
      expect(container.textContent).toContain("Quarterly review");
      await openMenu();
      await act(async () => item("Regenerate title").click());
      await flush();
      expect(rows()[0].querySelector('[role="alert"]')!.textContent).toContain("disk full");
      await act(async () => button(rows()[0], "Dismiss").click());
      expect(rows()[0].querySelector('[role="alert"]')).toBeNull();
      expect(regenerateTitle).toHaveBeenCalledTimes(2);
    });

    it("asks before replacing a title the user chose, and Cancel does nothing", async () => {
      chats = chats.map((c) => (c.chatId === "alpha" ? { ...c, titleSource: "user" } : c));
      const regenerateTitle = vi.fn(async () => done("alpha", "Auto words"));
      await mount({ regenerateTitle });
      await openMenu();
      await act(async () => item("Regenerate title").click());
      expect(regenerateTitle).not.toHaveBeenCalled();
      expect(rows()[0].textContent).toContain("Replace your title?");
      await act(async () => button(rows()[0], "Cancel").click());
      expect(rows()[0].textContent).not.toContain("Replace your title?");
      await openMenu();
      await act(async () => item("Regenerate title").click());
      await act(async () => button(rows()[0], "Replace").click());
      await flush();
      expect(regenerateTitle).toHaveBeenCalledTimes(1);
    });

    it("does not ask for an automatic or placeholder title", async () => {
      const regenerateTitle = vi.fn(async () => done("beta", "Shopping list"));
      await mount({ regenerateTitle });
      const beta = rows().find((r) => r.dataset.agentHistoryRow === "beta")!;
      await openMenu(beta);
      await act(async () => item("Regenerate title").click());
      await flush();
      expect(regenerateTitle).toHaveBeenCalledWith("beta");
      expect(container.textContent).not.toContain("Replace your title?");
    });

    it("is disabled for a chat with nothing to title", async () => {
      chats = chats.map((c) => (c.chatId === "alpha" ? { ...c, turnCount: 0 } : c));
      const regenerateTitle = vi.fn(async () => done("alpha", "x"));
      await mount({ regenerateTitle });
      await openMenu();
      const entry = item("Regenerate title");
      expect(entry.disabled).toBe(true);
      expect(entry.title).toMatch(/no reply/);
      await act(async () => entry.click());
      expect(regenerateTitle).not.toHaveBeenCalled();
      // the keyboard skips it
      expect(document.activeElement).toBe(item("Resume"));
    });

    it("guards a double click: one call per chat", async () => {
      chats = chats.map((c) => (c.chatId === "alpha" ? { ...c, titleSource: "user" } : c));
      const d = deferred();
      const regenerateTitle = vi.fn(() => d.promise);
      await mount({ regenerateTitle });
      await openMenu();
      await act(async () => item("Regenerate title").click());
      const replace = button(rows()[0], "Replace");
      await act(async () => {
        replace.click();
        replace.click();
      });
      expect(regenerateTitle).toHaveBeenCalledTimes(1);
      await act(async () => d.resolve(done("alpha", "Once")));
      await flush();
    });
  });
});
