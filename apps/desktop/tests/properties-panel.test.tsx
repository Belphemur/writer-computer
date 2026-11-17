// @vitest-environment jsdom
// The properties panel in jsdom: collapsed summary, size heuristic, session toggle, bounded
// body, edits written back to the frontmatter text with minimal changes, source view, refused
// shapes. The frontmatter is synthetic; the backend is a fake.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));
vi.mock("../src/lib/save", () => ({
  scheduleSave: vi.fn(),
  cancelSave: vi.fn(),
  registerSaveStore: vi.fn(),
}));
const ipc = vi.hoisted(() => ({
  propertyTypes: vi.fn(),
  propertyTypeSet: vi.fn(async (_name: string, _ty: string, _values?: string[]) => {}),
}));
// The fake backend keeps what was recorded, as the real one does, for the refetch after a write.
const recorded = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/lib/property-types-ipc", () => ipc);
const VAULT_TYPES = [
  { key: "status", count: 4, types: { text: 4 }, type: "text", source: "inferred", mismatched: 0 },
  { key: "due", count: 2, types: { date: 2 }, type: "date", source: "writer", mismatched: 0 },
  { key: "dueDate", count: 1, types: { date: 1 }, type: "date", source: "writer", mismatched: 0 },
  {
    key: "rating",
    count: 3,
    types: { number: 3 },
    type: "number",
    source: "obsidian",
    mismatched: 1,
  },
];
vi.mock("../src/lib/tauri", async (orig) => ({
  ...(await orig<object>()),
  resolveWikiLinkTarget: vi.fn(async (t: string) => (t === "Missing" ? null : `/vault/${t}.md`)),
  fuzzySearch: vi.fn(async () => [
    { path: "/vault/Alpha.md", filename: "Alpha.md", relative_path: "Alpha.md", title: null },
  ]),
}));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));

import { scheduleSave } from "../src/lib/save";
import * as tauri from "../src/lib/tauri";
import { PropertiesPanel } from "../src/components/editor-area/properties-panel";
import { useEditorStore } from "../src/stores/editor-store";
import { usePropertiesPanelStore } from "../src/stores/properties-panel-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { usePropertyTypesStore } from "../src/stores/property-types-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "/vault/note.md";
let host: HTMLDivElement;
let root: Root;

function setFrontmatter(frontmatter: string | null) {
  useEditorStore.setState({
    openFiles: new Map([[PATH, { path: PATH, frontmatter, content: "" } as never]]),
  });
}
const stored = () => useEditorStore.getState().openFiles.get(PATH)?.frontmatter;

async function mount() {
  await act(async () => {
    root.render(<PropertiesPanel filePath={PATH} />);
  });
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const toggle = () => q("button[aria-expanded]") as HTMLButtonElement;

async function type(el: HTMLInputElement, value: string, commit: "blur" | "enter" = "blur") {
  await act(async () => {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (commit === "enter") {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    } else {
      el.blur();
    }
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  usePropertiesPanelStore.setState({ notes: new Map() });
  usePropertyTypesStore.setState({ byKey: {}, loadedAt: 0 });
  recorded.clear();
  ipc.propertyTypes.mockReset().mockImplementation(async () => [
    ...VAULT_TYPES.filter((p) => !recorded.has(p.key.toLowerCase())),
    ...[...recorded].map(([key, type]) => ({
      key,
      count: 1,
      types: {},
      type,
      source: "writer",
      mismatched: 0,
    })),
  ]);
  ipc.propertyTypeSet.mockReset().mockImplementation(async (name: string, ty: string) => {
    recorded.set(name.toLowerCase(), ty);
  });
  useSettingsStore.setState({ settings: {} });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("PropertiesPanel", () => {
  it("renders nothing without frontmatter", async () => {
    setFrontmatter(null);
    await mount();
    expect(host.innerHTML).toBe("");
  });

  it("is expanded for a small block and shows typed rows", async () => {
    setFrontmatter("title: Hello\ndone: true\ntags:\n  - a\n  - b");
    await mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().textContent).toContain("Properties (3)");
    expect((q('input[aria-label="done value"]') as HTMLInputElement).checked).toBe(true);
    expect(host.textContent).toContain("a");
    expect(q('[aria-label="Remove a"]')).not.toBeNull();
  });

  it("starts collapsed past 6 properties, with a one-row summary and tag chips", async () => {
    const lines = ["tags: [x, y, z, w]", ...Array.from({ length: 7 }, (_, i) => `k${i}: v${i}`)];
    setFrontmatter(lines.join("\n"));
    await mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toContain("Properties (8)");
    expect(toggle().textContent).toContain("x");
    expect(toggle().textContent).toContain("+1");
    expect(q("[id]:not(section)")).toBeNull();
    expect(q('input[aria-label="k0 value"]')).toBeNull();
  });

  it("toggles with one click, remembers per note for the session, and bounds the body", async () => {
    setFrontmatter(Array.from({ length: 9 }, (_, i) => `k${i}: v${i}`).join("\n"));
    await mount();
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const body = document.getElementById(toggle().getAttribute("aria-controls") ?? "");
    expect(body?.className).toContain("max-h-[40vh]");
    expect(body?.className).toContain("overflow-y-auto");
    expect(usePropertiesPanelStore.getState().notes.get(PATH)?.collapsed).toBe(false);
    // A remount keeps the user's choice even though the heuristic says collapsed.
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("follows the global setting", async () => {
    useSettingsStore.setState({ settings: { "editor.properties-default-collapsed": "collapsed" } });
    setFrontmatter("a: 1");
    await mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    useSettingsStore.setState({ settings: { "editor.properties-default-collapsed": "expanded" } });
    setFrontmatter(Array.from({ length: 12 }, (_, i) => `k${i}: v${i}`).join("\n"));
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("does not re-render when the body changes", async () => {
    setFrontmatter("a: 1");
    await mount();
    const before = q("section");
    await act(async () => {
      useEditorStore.setState((s) => {
        const files = new Map(s.openFiles);
        files.set(PATH, { ...files.get(PATH)!, content: "typing" } as never);
        return { openFiles: files };
      });
    });
    expect(q("section")).toBe(before);
  });

  it("edits a text value and keeps comments and neighbours", async () => {
    setFrontmatter('# note\ntitle: "Old" # keep\nn: 1');
    await mount();
    await type(q('input[aria-label="title value"]') as HTMLInputElement, "New");
    expect(stored()).toBe('# note\ntitle: "New" # keep\nn: 1');
    await type(q('input[aria-label="n value"]') as HTMLInputElement, "42", "enter");
    expect(stored()).toBe('# note\ntitle: "New" # keep\nn: 42');
  });

  it("toggles a checkbox and removes a property", async () => {
    setFrontmatter("a: false\nb: 2");
    await mount();
    await act(async () => (q('input[aria-label="a value"]') as HTMLInputElement).click());
    expect(stored()).toBe("a: true\nb: 2");
    await act(async () => (q('[aria-label="Remove property a"]') as HTMLButtonElement).click());
    expect(stored()).toBe("b: 2");
    await act(async () => (q('[aria-label="Remove property b"]') as HTMLButtonElement).click());
    expect(stored()).toBeNull();
  });

  it("adds and removes list items as chips", async () => {
    setFrontmatter("tags:\n  - a");
    await mount();
    await type(q('input[aria-label="Add to tags"]') as HTMLInputElement, "#b", "enter");
    expect(stored()).toBe("tags:\n  - a\n  - b");
    await act(async () => (q('[aria-label="Remove a"]') as HTMLButtonElement).click());
    expect(stored()).toBe("tags:\n  - b");
  });

  it("adds a property with a type", async () => {
    setFrontmatter("a: 1");
    await mount();
    await act(async () =>
      (
        [...host.querySelectorAll("button")].find(
          (b) => b.textContent === "+ Add property",
        ) as HTMLButtonElement
      ).click(),
    );
    const name = q('input[aria-label="New property name"]') as HTMLInputElement;
    await type(name, "due", "blur");
    // The vault knows `due` as a date, so the type icon follows it.
    expect(q('button[aria-label="New property: Date. Change type"]')).not.toBeNull();
    await act(async () => {
      name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(stored()).toMatch(/^a: 1\ndue: \d{4}-\d{2}-\d{2}$/);
  });

  it("shows the raw text for an unparsable block and edits it as text", async () => {
    setFrontmatter("a: [unclosed\nb: 1");
    await mount();
    expect(q('[role="alert"]')?.textContent).toContain("not valid YAML");
    expect(q('input[aria-label="a value"]')).toBeNull();
    const area = q("textarea") as HTMLTextAreaElement;
    expect(area.value).toBe("a: [unclosed\nb: 1");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(area, "a: [closed]\nb: 1");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(stored()).toBe("a: [closed]\nb: 1");
    expect(q('[role="alert"]')).toBeNull();
  });

  it("refuses duplicate keys and shows placeholders read-only without touching them", async () => {
    setFrontmatter("a: 1\na: 2");
    await mount();
    expect(q('[role="alert"]')?.textContent).toContain('"a" appears more than once');
    setFrontmatter("date: {{date}}\ntitle: x");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(host.textContent).toContain("{{date}}");
    expect(q('input[aria-label="date value"]')).toBeNull();
    await type(q('input[aria-label="title value"]') as HTMLInputElement, "y");
    expect(stored()).toBe("date: {{date}}\ntitle: y");
  });

  it("the Source toggle edits the raw block", async () => {
    setFrontmatter("a: 1");
    await mount();
    await act(async () => (q("button[aria-pressed]") as HTMLButtonElement).click());
    expect((q("textarea") as HTMLTextAreaElement).value).toBe("a: 1");
    expect(q("button[aria-pressed]")?.getAttribute("aria-pressed")).toBe("true");
  });
});

const doc = (sel: string) => document.querySelector<HTMLElement>(sel);
const typeButton = (key: string, label: string) =>
  q(`button[aria-label="${key}: ${label}. Change type"]`) as HTMLButtonElement;
const press = (el: Element, key: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((b) =>
    b.textContent?.startsWith(label),
  ) as HTMLButtonElement;
async function mountAndLoad(fm: string) {
  setFrontmatter(fm);
  await mount();
  await act(async () => {}); // the vault's property types arrive
}

describe("property type icon and menu", () => {
  it("shows a type icon per row, the declared type for a recorded name and the unknown state for a value that does not fit", async () => {
    await mountAndLoad("title: Hi\ndone: true\nn: 3\ndue: 2026-01-02\nrating: high\ntags: [a]");
    expect(typeButton("title", "Text").dataset.type).toBe("text");
    expect(typeButton("done", "Checkbox").dataset.type).toBe("checkbox");
    expect(typeButton("n", "Number")).not.toBeNull();
    expect(typeButton("due", "Date")).not.toBeNull();
    expect(typeButton("tags", "Tags")).not.toBeNull();
    // `rating` is a Number in the vault's record (Obsidian's file), this note says "high".
    const rating = typeButton("rating", "Number");
    expect(rating.dataset.mismatch).toBeDefined();
    expect(rating.title).toContain("not a number");
    expect(rating.title).toContain("Click to change type");
    expect(rating.title).toContain("1 note has a value that does not fit");
    expect(q('[role="status"]')?.textContent).toBe("Not a number");
  });

  it("opens a menu of the types with a check on the current one; Esc closes it and returns focus", async () => {
    await mountAndLoad("title: Hi");
    const icon = typeButton("title", "Text");
    await act(async () => icon.click());
    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    expect(items.map((i) => i.textContent)).toEqual([
      "Text",
      "List",
      "Relationships",
      "Enum",
      "Number",
      "Checkbox",
      "Date",
      "Date & time",
    ]);
    expect(menuItem("Text").getAttribute("aria-checked")).toBe("true");
    expect(menuItem("Number").getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(menuItem("Text"));
    await press(menuItem("Text"), "ArrowDown");
    expect(document.activeElement).toBe(menuItem("List"));
    await press(menuItem("List"), "ArrowUp");
    await press(menuItem("Text"), "ArrowUp"); // wraps
    expect(document.activeElement).toBe(menuItem("Date & time"));
    await press(menuItem("Date & time"), "Escape");
    expect(doc('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(icon);
  });

  it("closes on a click outside without moving focus", async () => {
    await mountAndLoad("title: Hi");
    await act(async () => typeButton("title", "Text").click());
    expect(doc('[role="menu"]')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(doc('[role="menu"]')).toBeNull();
  });

  it("choosing a type records it vault-wide and converts this note's value as ONE update", async () => {
    await mountAndLoad("# keep\nz: 1\nn: '42'\nt: a, b");
    vi.mocked(scheduleSave).mockClear();
    await act(async () => typeButton("n", "Text").click());
    await act(async () => menuItem("Number").click());
    expect(stored()).toBe("# keep\nz: 1\nn: 42\nt: a, b");
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("n", "number");
    expect(vi.mocked(scheduleSave)).toHaveBeenCalledTimes(1);
    expect(doc('[role="menu"]')).toBeNull();
    expect(typeButton("n", "Number")).not.toBeNull();
    // text -> list splits on commas
    await act(async () => typeButton("t", "Text").click());
    await act(async () => menuItem("List").click());
    expect(stored()).toBe("# keep\nz: 1\nn: 42\nt:\n  - a\n  - b");
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("t", "multitext");
  });

  it("a value that cannot convert is kept, the type is still recorded, and the row warns", async () => {
    await mountAndLoad("a: abc");
    vi.mocked(scheduleSave).mockClear();
    await act(async () => typeButton("a", "Text").click());
    await act(async () => menuItem("Number").click());
    expect(stored()).toBe("a: abc");
    expect(vi.mocked(scheduleSave)).not.toHaveBeenCalled();
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("a", "number");
    expect(q('[role="status"]')?.textContent).toBe("Not a number");
    expect(typeButton("a", "Number").dataset.mismatch).toBeDefined();
  });

  it("reports a failed type save", async () => {
    await mountAndLoad("a: 1");
    ipc.propertyTypeSet.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => typeButton("a", "Number").click());
    await act(async () => menuItem("Text").click());
    expect(q('[role="alert"]')?.textContent).toContain("disk full");
  });
});

describe("add property flow", () => {
  const openAdd = async () => {
    await act(async () =>
      (
        [...host.querySelectorAll("button")].find(
          (b) => b.textContent === "+ Add property",
        ) as HTMLButtonElement
      ).click(),
    );
    return q('input[aria-label="New property name"]') as HTMLInputElement;
  };

  it("picks the type up front from the same menu and records it", async () => {
    await mountAndLoad("a: 1");
    const name = await openAdd();
    await act(async () => typeButton("New property", "Text").click());
    await act(async () => menuItem("Checkbox").click());
    await type(name, "flag", "blur");
    await act(async () => {
      name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(stored()).toBe("a: 1\nflag: false");
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("flag", "checkbox");
  });

  it("suggests existing names with their type icons and defaults to a known name's type", async () => {
    await mountAndLoad("a: 1");
    const name = await openAdd();
    await type(name, "du", "blur");
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(["dueDate", "dueDateDate"]);
    await press(name, "ArrowDown");
    await press(name, "Enter");
    expect(name.value).toBe("due");
    expect(typeButton("New property", "Date")).not.toBeNull();
    await press(name, "Enter");
    expect(stored()).toMatch(/^a: 1\ndue: \d{4}-\d{2}-\d{2}$/);
    // a known name keeps its recorded type: nothing to write
    expect(ipc.propertyTypeSet).not.toHaveBeenCalled();
  });
});

describe("wikilink properties", () => {
  it("renders links in text and list properties as chips, dimming a missing note", async () => {
    await mountAndLoad(
      'rel: "[[Alpha|The Alpha]]"\nrefs:\n  - "[[Alpha#Intro]]"\n  - "[[Missing]]"\n  - plain\nun: [[Alpha]]',
    );
    const links = [...host.querySelectorAll<HTMLElement>("[data-wikilink]")];
    expect(links.map((l) => l.textContent)).toEqual([
      "The Alpha",
      "Alpha > Intro",
      "Missing",
      "Alpha",
    ]);
    expect(links.map((l) => l.dataset.unresolved !== undefined)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(host.textContent).toContain("plain");
  });

  it("typing [[ in a property input suggests notes and keeps the raw [[...]] text", async () => {
    await mountAndLoad("refs:\n  - a");
    const input = q('input[aria-label="Add to refs"]') as HTMLInputElement;
    await act(async () => {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "[[Al");
      input.setSelectionRange(4, 4);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const option = doc('[role="option"]');
    expect(option?.textContent).toContain("Alpha");
    await press(input, "Enter"); // accepts the suggestion, not the add
    expect(input.value).toBe("[[Alpha]]");
    expect(stored()).toBe("refs:\n  - a");
    await press(input, "Enter");
    expect(stored()).toMatch(/^refs:\n {2}- a\n {2}- ["']\[\[Alpha\]\]["']$/);
  });
});

// ---------------------------------------------------------------------------
// relationships: a link or a list of links
// ---------------------------------------------------------------------------

const FILES = [
  { path: "/vault/Alpha.md", filename: "Alpha.md", relative_path: "Alpha.md", title: null },
  { path: "/vault/Gamma.md", filename: "Gamma.md", relative_path: "Gamma.md", title: null },
  {
    path: "/vault/Projects/Beta.md",
    filename: "Beta.md",
    relative_path: "Projects/Beta.md",
    title: null,
  },
  {
    path: "/vault/Archive/Beta.md",
    filename: "Beta.md",
    relative_path: "Archive/Beta.md",
    title: null,
  },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle() {
  await act(async () => {
    await sleep(80); // the picker's search debounce
  });
}
const plus = (key: string) => q(`button[aria-label="Add to ${key}"]`) as HTMLButtonElement;
const picker = () => doc('[role="dialog"][aria-label="Add a link"]');
const options = () =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent);
async function search(text: string) {
  const input = doc('input[aria-label="Search notes"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  return input;
}

describe("relationships properties", () => {
  beforeEach(() => {
    vi.mocked(tauri.fuzzySearch).mockImplementation(async (query: string) =>
      FILES.filter((f) => f.filename.toLowerCase().includes(query.toLowerCase())).map((f) => ({
        ...f,
        score: 1,
        match_indices: [],
      })),
    );
  });

  it("a link or a list of links is inferred as relationships; a mixed list stays a list", async () => {
    await mountAndLoad(
      'manager: "[[Alpha]]"\nteam:\n  - "[[Alpha|A]]"\n  - "[[Projects/Beta#Top]]"\nmixed:\n  - "[[Alpha]]"\n  - plain\nnote: hello',
    );
    expect(typeButton("manager", "Relationships").dataset.type).toBe("relationships");
    expect(typeButton("team", "Relationships")).not.toBeNull();
    expect(typeButton("mixed", "List").dataset.type).toBe("multitext");
    expect(typeButton("note", "Text")).not.toBeNull();
    expect(q('[role="status"]')).toBeNull();
  });

  it("a recorded type wins over inference", async () => {
    ipc.propertyTypes.mockResolvedValue([
      {
        key: "manager",
        count: 1,
        types: { link: 1 },
        type: "text",
        source: "writer",
        mismatched: 0,
        obsidianType: "text",
      },
    ]);
    await mountAndLoad('manager: "[[Alpha]]"');
    expect(typeButton("manager", "Text")).not.toBeNull();
  });

  it("chips show each link, dim a missing note and remove one link from a list", async () => {
    await mountAndLoad('team:\n  - "[[Alpha]]"\n  - "[[Missing]]"\n  - "[[Gamma|G]]"');
    const links = [...host.querySelectorAll<HTMLElement>("[data-relationship] [data-wikilink]")];
    expect(links.map((l) => l.textContent)).toEqual(["Alpha", "Missing", "G"]);
    await act(async () => {});
    expect(links.map((l) => l.dataset.unresolved !== undefined)).toEqual([false, true, false]);
    await act(async () => q('button[aria-label="Remove [[Missing]]"]')!.click());
    expect(stored()).toBe('team:\n  - "[[Alpha]]"\n  - "[[Gamma|G]]"');
  });

  it("removing the only link of a single value empties the property", async () => {
    recorded.set("manager", "relationships"); // the vault's record keeps the type of an empty value
    await mountAndLoad('manager: "[[Alpha]]"');
    await act(async () => q('button[aria-label="Remove [[Alpha]]"]')!.click());
    expect(stored()).toBe("manager:");
    expect(plus("manager")).not.toBeNull(); // still a relationships property, ready for a link
  });

  it("+ opens a search over the vault's ranked file search and filters as you type", async () => {
    await mountAndLoad('team:\n  - "[[Gamma]]"');
    await act(async () => plus("team").click());
    await settle();
    expect(picker()).not.toBeNull();
    expect(document.activeElement).toBe(doc('input[aria-label="Search notes"]'));
    // note name with a folder hint; Gamma is already linked, so it is not offered
    expect(options()).toEqual(["Alpha", "BetaProjects", "BetaArchive"]);
    await search("bet");
    expect(tauri.fuzzySearch).toHaveBeenCalledWith("bet", expect.any(Number));
    expect(options()).toEqual(["BetaProjects", "BetaArchive"]);
    await search("zzz");
    expect(options()).toEqual([]);
    expect(doc('[role="status"]')?.textContent).toBe("No notes to link");
  });

  it("picking writes a quoted link by file name; a single stays single, a second makes a list", async () => {
    recorded.set("manager", "relationships");
    await mountAndLoad("manager:");
    vi.mocked(scheduleSave).mockClear();
    await act(async () => plus("manager").click());
    await settle();
    await act(async () => doc('[role="option"]')!.click()); // Alpha
    expect(stored()).toBe('manager: "[[Alpha]]"');
    expect(vi.mocked(scheduleSave)).toHaveBeenCalledTimes(1); // one undo step
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(plus("manager"));
    // a second link turns the single value into a list
    await act(async () => plus("manager").click());
    await settle();
    expect(options()).not.toContain("Alpha"); // already linked
    await act(async () => doc('[role="option"]')!.click()); // Gamma
    expect(stored()).toBe('manager:\n  - "[[Alpha]]"\n  - "[[Gamma]]"');
    expect(vi.mocked(scheduleSave)).toHaveBeenCalledTimes(2);
  });

  it("an ambiguous file name is written with its folder path", async () => {
    await mountAndLoad('team: ["[[Alpha]]"]');
    await act(async () => plus("team").click());
    await settle();
    const beta = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent?.includes("Archive"),
    )!;
    await act(async () => beta.click());
    expect(stored()).toBe('team: ["[[Alpha]]", "[[Archive/Beta]]"]');
  });

  it("notes linked with alias, heading or path forms are hidden from the picker", async () => {
    await mountAndLoad('team:\n  - "[[Alpha|A]]"\n  - "[[Projects/Beta#Top]]"');
    await act(async () => plus("team").click());
    await settle();
    expect(options()).toEqual(["Gamma", "BetaArchive"]);
  });

  it("the keyboard drives the picker: arrows move, Enter picks, Esc closes and refocuses +", async () => {
    recorded.set("team", "relationships");
    await mountAndLoad("team: []");
    await act(async () => plus("team").click());
    await settle();
    const input = doc('input[aria-label="Search notes"]') as HTMLInputElement;
    expect(doc('[role="option"][aria-selected="true"]')?.textContent).toBe("Alpha");
    await press(input, "ArrowDown");
    expect(doc('[role="option"][aria-selected="true"]')?.textContent).toBe("Gamma");
    await press(input, "ArrowUp");
    await press(input, "ArrowUp"); // wraps
    expect(doc('[role="option"][aria-selected="true"]')?.textContent).toContain("Beta");
    await press(input, "Escape");
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(plus("team"));
    expect(stored()).toBe("team: []");
    await act(async () => plus("team").click());
    await settle();
    await press(doc('input[aria-label="Search notes"]')!, "ArrowDown");
    await press(doc('input[aria-label="Search notes"]')!, "Enter");
    expect(stored()).toBe('team:\n  - "[[Gamma]]"');
  });

  it("a click outside closes the picker without adding anything", async () => {
    recorded.set("team", "relationships");
    await mountAndLoad("team: []");
    await act(async () => plus("team").click());
    await settle();
    expect(picker()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(picker()).toBeNull();
    expect(stored()).toBe("team: []");
  });

  it("converting text: [[a]], [[b]] splits, plain text resolves by file name or is refused", async () => {
    await mountAndLoad('many: "[[Alpha]], [[Gamma|G]]"\nplain: Alpha\nnope: Missing');
    vi.mocked(scheduleSave).mockClear();
    await act(async () => typeButton("many", "Text").click());
    await act(async () => menuItem("Relationships").click());
    expect(stored()).toContain('many:\n  - "[[Alpha]]"\n  - "[[Gamma|G]]"');
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("many", "relationships");
    await act(async () => typeButton("plain", "Text").click());
    await act(async () => menuItem("Relationships").click());
    expect(stored()).toContain('plain: "[[Alpha]]"');
    expect(vi.mocked(scheduleSave)).toHaveBeenCalledTimes(2); // one update per conversion
    await act(async () => typeButton("nope", "Text").click());
    await act(async () => menuItem("Relationships").click());
    expect(stored()).toContain("nope: Missing"); // refused, kept
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("nope", "relationships");
    expect(q('[role="status"]')?.textContent).toBe("Not a link");
  });
});

describe("middle-click on a relationship link", () => {
  it("opens the note in a new tab; a plain click navigates in place", async () => {
    const openNew = vi.fn(async () => {});
    const navigate = vi.fn(async () => {});
    useWorkspaceStore.setState({ root: "/vault" });
    useEditorStore.setState({ openFileInNewTab: openNew, navigateToFile: navigate } as never);
    recorded.set("manager", "relationships");
    await mountAndLoad('manager: "[[Alpha]]"');
    const link = q("[data-relationship] [data-wikilink]")!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    });
    await act(async () => {});
    expect(openNew).toHaveBeenCalledWith("/vault/Alpha.md");
    expect(navigate).not.toHaveBeenCalled();
    // other auxiliary buttons (right) do nothing; a left click still navigates in place
    await act(async () => {
      link.dispatchEvent(new MouseEvent("auxclick", { button: 2, bubbles: true }));
    });
    await act(async () => link.click());
    await act(async () => {});
    expect(openNew).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/vault/Alpha.md");
  });
});

describe("enum properties", () => {
  const enumInfo = (values: string[]) => ({
    key: "status",
    count: 3,
    types: { text: 3 },
    type: "enum",
    source: "writer",
    mismatched: 0,
    obsidianType: "text",
    values,
  });
  const trigger = () => q('button[aria-label="status value"]') as HTMLButtonElement;
  const optionLabels = () =>
    [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].map(
      (o) => o.textContent,
    );
  const optionNamed = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find((o) =>
      o.textContent?.startsWith(label),
    ) as HTMLButtonElement;

  beforeEach(() => {
    ipc.propertyTypes.mockImplementation(
      async () => [enumInfo(["todo", "doing", "done"])] as never,
    );
  });

  it("is always a dropdown of its values, with the current one ticked", async () => {
    await mountAndLoad("status: doing");
    expect(q('input[aria-label="status value"]')).toBeNull();
    expect(trigger().textContent).toContain("doing");
    expect(trigger().dataset.notInList).toBeUndefined();
    await act(async () => trigger().click());
    expect(optionLabels()).toEqual(["No value", "todo", "doing", "done"]);
    expect(optionNamed("doing").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(optionNamed("doing"));
    await press(document.activeElement!.closest('[role="listbox"]')!, "ArrowDown");
    expect(document.activeElement).toBe(optionNamed("done"));
  });

  it("picking writes the value, No value clears it, Escape keeps it", async () => {
    await mountAndLoad("status: doing");
    await act(async () => trigger().click());
    await act(async () => optionNamed("done").click());
    expect(stored()).toBe("status: done");
    await act(async () => trigger().click());
    await press(document.activeElement!.closest('[role="listbox"]')!, "Escape");
    expect(doc('[role="listbox"]')).toBeNull();
    expect(stored()).toBe("status: done");
    await act(async () => trigger().click());
    await act(async () => optionNamed("No value").click());
    expect(stored()).toBe("status:");
  });

  it("shows a value outside the list marked, selectable, and never rewrites it", async () => {
    await mountAndLoad("status: blocked");
    expect(trigger().dataset.notInList).toBe("");
    expect(trigger().textContent).toContain("not in list");
    expect(stored()).toBe("status: blocked");
    await act(async () => trigger().click());
    expect(optionLabels()).toEqual(["No value", "blockednot in list", "todo", "doing", "done"]);
    await act(async () => optionNamed("blocked").click()); // picking it again changes nothing
    expect(stored()).toBe("status: blocked");
  });

  it("Add value... appends to the type's values through the one write path and sets it", async () => {
    await mountAndLoad("status: todo");
    await act(async () => trigger().click());
    const add = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) =>
      b.textContent?.startsWith("Add value"),
    )!;
    await act(async () => add.click());
    const input = doc('input[aria-label="New value"]') as HTMLInputElement;
    await type(input, "  review ", "enter");
    await act(async () => {});
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("status", "enum", [
      "todo",
      "doing",
      "done",
      "review",
    ]);
    expect(usePropertyTypesStore.getState().byKey["status"]?.type).toBe("enum");
    expect(stored()).toBe("status: review");
    expect(doc('[role="listbox"]')).toBeNull();
  });

  it("choosing Enum in the type menu asks the backend to seed the values and keeps the notes", async () => {
    ipc.propertyTypes.mockImplementation(
      async () =>
        [
          {
            key: "status",
            count: 4,
            types: { text: 4 },
            type: "text",
            source: "inferred",
            mismatched: 0,
          },
        ] as never,
    );
    await mountAndLoad("status: doing");
    await act(async () => typeButton("status", "Text").click());
    await act(async () => menuItem("Enum").click());
    // no values sent: the backend seeds them from every value the vault holds
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("status", "enum");
    expect(stored()).toBe("status: doing");
  });
});
