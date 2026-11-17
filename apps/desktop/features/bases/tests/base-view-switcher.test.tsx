// @vitest-environment jsdom
// The Bases view dropdown: a trigger plus a portaled listbox, search past six views, keyboard,
// ARIA and focus. Driven through BaseToolbar with invented views; the backend is not involved.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BaseToolbar } from "../web/view/base-toolbar";
import "../web/view/builtin-views";
import type { ViewChoice } from "../web/lib/grid";
import { filterViews, typeaheadIndex } from "../web/lib/view-search";
import {
  key,
  open,
  optionNames,
  options,
  popover,
  searchBox,
  trigger,
} from "./helpers/view-switcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const some = (...names: string[]): ViewChoice[] =>
  names.map((name, i) => ({ name, type: ["table", "cards", "list"][i % 3] }));
const many = (n: number): ViewChoice[] =>
  some(...Array.from({ length: n }, (_, i) => `View ${i + 1}`));

let host: HTMLDivElement;
let root: Root;
let onSelect: ReturnType<typeof vi.fn<(name: string) => void>>;

function Harness({ views, initial }: { views: ViewChoice[]; initial?: string }) {
  const [selected, setSelected] = useState(initial);
  return (
    <>
      <button data-outside>outside</button>
      <BaseToolbar
        compact
        views={views}
        selected={selected}
        onSelect={(n) => {
          onSelect(n);
          setSelected(n);
        }}
        counts={null}
        querying={false}
      />
    </>
  );
}

async function mount(views: ViewChoice[], initial?: string) {
  await act(async () => root.render(<Harness views={views} initial={initial} />));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onSelect = vi.fn<(name: string) => void>();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("filterViews and typeaheadIndex", () => {
  const v = some("Open tasks", "Board", "All Tasks", "Kanban by owner");
  it("keeps file order for a blank query", () => {
    expect(filterViews(v, "  ").map((x) => x.name)).toEqual(v.map((x) => x.name));
  });
  it("matches case-insensitively, prefix before word start before substring before subsequence", () => {
    expect(filterViews(v, "TASK").map((x) => x.name)).toEqual(["Open tasks", "All Tasks"]);
    const ranked = some("Subtasks", "Open tasks", "Tasks");
    expect(filterViews(ranked, "task").map((x) => x.name)).toEqual([
      "Tasks",
      "Open tasks",
      "Subtasks",
    ]);
    expect(filterViews(v, "bd").map((x) => x.name)).toEqual(["Board"]);
    expect(filterViews(v, "zzz")).toEqual([]);
  });
  it("finds the next name with a prefix, wrapping", () => {
    const names = ["Alpha", "Beta", "Apple"];
    expect(typeaheadIndex(names, "a", 1)).toBe(2);
    expect(typeaheadIndex(names, "a", 3)).toBe(0);
    expect(typeaheadIndex(names, "x", 0)).toBe(-1);
  });
});

describe("ViewSwitcher", () => {
  it("shows the selected view on the trigger and renders nothing without views", async () => {
    await mount(some("Table", "Board"), "Board");
    expect(trigger(host).textContent).toBe("Board");
    expect(trigger(host).getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger(host).getAttribute("aria-expanded")).toBe("false");
    await mount([]);
    expect(host.querySelector("[data-view-switcher]")).toBeNull();
  });

  it("defaults to the first view when none is selected", async () => {
    await mount(some("Table", "Board"));
    expect(trigger(host).textContent).toBe("Table");
  });

  it("opens a listbox in a portal with options, the active one checked, and a plain list for few views", async () => {
    await mount(some("Table", "Board", "Cards"), "Board");
    await open(host);
    const pop = popover()!;
    expect(pop.parentElement).toBe(document.body);
    expect(host.contains(pop)).toBe(false);
    expect(trigger(host).getAttribute("aria-expanded")).toBe("true");
    expect(searchBox()).toBeNull();
    const list = pop.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(trigger(host).getAttribute("aria-controls")).toBe(list.id);
    expect(optionNames()).toEqual(["Table", "Board", "Cards"]);
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    // The highlight starts on the active view; the list owns focus.
    expect(list.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    expect(document.activeElement).toBe(list);
  });

  it("selects with a click, closes and returns focus to the trigger", async () => {
    await mount(some("Table", "Board"), "Table");
    await open(host);
    await act(async () => options()[1]!.click());
    expect(onSelect).toHaveBeenCalledWith("Board");
    expect(popover()).toBeNull();
    expect(trigger(host).textContent).toBe("Board");
    expect(document.activeElement).toBe(trigger(host));
  });

  it("choosing the active view only closes", async () => {
    await mount(some("Table", "Board"), "Table");
    await open(host);
    await act(async () => options()[0]!.click());
    expect(onSelect).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
  });

  it("closes on an outside pointerdown without stealing focus, and on Escape with focus back", async () => {
    await mount(some("Table", "Board"), "Table");
    await open(host);
    await act(async () => {
      document
        .querySelector("[data-outside]")!
        .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(popover()).toBeNull();
    await open(host);
    await key(document.activeElement!, "Escape");
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger(host));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a pointerdown inside the popover keeps it open", async () => {
    await mount(some("Table", "Board"), "Table");
    await open(host);
    await act(async () => {
      options()[0]!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(popover()).not.toBeNull();
  });

  it("ArrowDown on the trigger opens it", async () => {
    await mount(some("Table", "Board"), "Table");
    await key(trigger(host), "ArrowDown");
    expect(popover()).not.toBeNull();
  });

  it("moves the highlight with arrows (wrapping), Home and End, and Enter selects it", async () => {
    await mount(some("A", "B", "C"), "A");
    await open(host);
    const list = () => document.activeElement!;
    const hl = () =>
      options().findIndex((o) => o.id === list().getAttribute("aria-activedescendant"));
    expect(hl()).toBe(0);
    await key(list(), "ArrowUp");
    expect(hl()).toBe(2);
    await key(list(), "ArrowDown");
    expect(hl()).toBe(0);
    await key(list(), "End");
    expect(hl()).toBe(2);
    await key(list(), "Home");
    expect(hl()).toBe(0);
    await key(list(), "ArrowDown");
    await key(list(), "Enter");
    expect(onSelect).toHaveBeenCalledWith("B");
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger(host));
  });

  it("hovering highlights an option", async () => {
    await mount(some("A", "B", "C"), "A");
    await open(host);
    await act(async () => {
      options()[2]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(document.activeElement!.getAttribute("aria-activedescendant")).toBe(options()[2]!.id);
  });

  it("type-ahead jumps to a name in a plain list", async () => {
    await mount(some("Alpha", "Beta", "Bravo"), "Alpha");
    await open(host);
    await key(document.activeElement!, "b");
    expect(document.activeElement!.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    await key(document.activeElement!, "b");
    expect(document.activeElement!.getAttribute("aria-activedescendant")).toBe(options()[2]!.id);
  });

  it("keeps keys inside the popover (they never reach an ancestor listener)", async () => {
    await mount(some("A", "B"), "A");
    const seen = vi.fn();
    host.addEventListener("keydown", seen);
    await open(host);
    await key(document.activeElement!, "ArrowDown");
    expect(seen).not.toHaveBeenCalled();
  });

  it("shows the search box only past six views", async () => {
    await mount(many(6));
    await open(host);
    expect(searchBox()).toBeNull();
    await act(async () => options()[0]!.click());
    await mount(many(7));
    await open(host);
    expect(searchBox()).not.toBeNull();
  });

  it("with search: autofocused combobox, placeholder, aria wiring, filtering and count", async () => {
    await mount(many(12), "View 3");
    await open(host);
    const box = searchBox()!;
    expect(document.activeElement).toBe(box);
    expect(box.placeholder).toBe("Search views…");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(box.getAttribute("aria-controls")).toBe(
      popover()!.querySelector('[role="listbox"]')!.id,
    );
    expect(box.getAttribute("aria-activedescendant")).toBe(options()[2]!.id);
    expect(popover()!.querySelector("[data-view-count]")!.textContent).toBe("12 views");

    const setValue = (v: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(box, v);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await setValue("view 1");
    expect(optionNames()).toEqual(["View 1", "View 10", "View 11", "View 12"]);
    expect(popover()!.querySelector("[data-view-count]")!.textContent).toBe("4 of 12 views");
    // The highlight resets to the best match, and Enter picks it.
    expect(box.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    await key(box, "ArrowDown");
    await key(box, "Enter");
    expect(onSelect).toHaveBeenCalledWith("View 10");
    expect(document.activeElement).toBe(trigger(host));
  });

  it("with search: shows 'No matching views' and Enter does nothing", async () => {
    await mount(many(8));
    await open(host);
    const box = searchBox()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "zzz");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(options()).toHaveLength(0);
    expect(popover()!.textContent).toContain("No matching views");
    expect(box.getAttribute("aria-activedescendant")).toBeNull();
    await key(box, "Enter");
    expect(onSelect).not.toHaveBeenCalled();
    expect(popover()).not.toBeNull();
  });

  it("handles 150 views and a selected view that no longer exists", async () => {
    await mount(many(150), "Gone");
    expect(trigger(host).textContent).toBe("Gone");
    await open(host);
    expect(options()).toHaveLength(150);
    expect(options().every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("has no edit actions: the popover holds only the search box and options", async () => {
    await mount(many(9));
    await open(host);
    expect(popover()!.querySelectorAll("button")).toHaveLength(0);
    expect([...popover()!.querySelectorAll("input")].map((i) => i.getAttribute("role"))).toEqual([
      "combobox",
    ]);
  });
});
