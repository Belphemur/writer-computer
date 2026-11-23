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
  propertyPinSet: vi.fn(async (_name: string, _pinned: boolean) => {}),
}));
// The fake backend keeps what was recorded, as the real one does, for the refetch after a write.
const recorded = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/lib/property-types-ipc", () => ipc);
// The backend's "I changed the type record" notice (an enum gained values); tests fire it by hand.
const changed = vi.hoisted(() => ({ handler: null as null | (() => void) }));
vi.mock("../src/lib/property-types-events", () => ({
  onPropertyTypesChanged: async (h: () => void) => {
    changed.handler = h;
    return () => {};
  },
}));
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
// A small stand-in for the Hugeicons shards (the picker would load all 26 chunks, ~6 MB).
vi.mock("@/lib/icon-picker/icon-shards", () => {
  const glyph = (id: string) => [["path", { d: `M0 0h${id.length}`, key: id }]];
  return {
    SHARD_LETTERS: ["H"],
    shardOf: (n: string) => (n.startsWith("H") ? "H" : null),
    loadShard: async () => ({ Home01Icon: glyph("Home01Icon"), HeartIcon: glyph("HeartIcon") }),
  };
});

import { openUrl } from "@tauri-apps/plugin-opener";
import { scheduleSave } from "../src/lib/save";
import * as tauri from "../src/lib/tauri";
import { PropertiesPanel } from "../src/components/editor-area/properties-panel";
import { chipText, orderRows, shortDate } from "../src/components/editor-area/pinned-properties";
import { parseProperties } from "../src/lib/frontmatter-properties";
import { useEditorStore } from "../src/stores/editor-store";
import { usePropertiesPanelStore } from "../src/stores/properties-panel-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useUIStore } from "../src/stores/ui-store";
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
function setBody(content: string) {
  useEditorStore.setState((s) => {
    const files = new Map(s.openFiles);
    files.set(PATH, { ...files.get(PATH)!, content } as never);
    return { openFiles: files };
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

  describe("body tags", () => {
    const bodyChips = () =>
      [...host.querySelectorAll<HTMLElement>('button[title="In the note"]')].map(
        (e) => e.textContent,
      );

    it("shows the body's tags after the front matter's chips, read-only, once each", async () => {
      setFrontmatter("tags:\n  - a\n  - b");
      setBody("Some #Draft text #a and #draft again #b/c");
      await mount();
      expect(bodyChips()).toEqual(["#draft", "#b/c"]);
      const row = q('[aria-label="Remove a"]')!.closest("li")!;
      const chips = [...row.querySelectorAll("button, input")].map(
        (e) => e.getAttribute("title") ?? e.getAttribute("aria-label"),
      );
      // front matter chips (with their remove buttons), then the body's, then the add field
      expect(chips.indexOf("Remove b")).toBeLessThan(chips.indexOf("In the note"));
      expect(chips.indexOf("In the note")).toBeLessThan(chips.indexOf("Add to tags"));
    });

    it("follows the typing in the body", async () => {
      setFrontmatter("tags: [a]");
      setBody("nothing");
      await mount();
      expect(bodyChips()).toEqual([]);
      await act(async () => setBody("nothing #new"));
      expect(bodyChips()).toEqual(["#new"]);
      await act(async () => setBody("nothing #new #a"));
      expect(bodyChips()).toEqual(["#new"]);
      await act(async () => setBody("nothing"));
      expect(bodyChips()).toEqual([]);
    });

    it("ignores tags in code and URLs", async () => {
      setFrontmatter("tags: [a]");
      setBody("`#no` https://x.com/#no\n```\n#no\n```\n#yes");
      await mount();
      expect(bodyChips()).toEqual(["#yes"]);
    });

    it("gets a row of its own when the front matter has no tags", async () => {
      setFrontmatter("status: todo");
      setBody("a #idea");
      await mount();
      expect(bodyChips()).toEqual(["#idea"]);
      expect(q('button[title="In the note"]')!.closest("li")).toBeNull();
      expect(host.textContent).toContain("tags");
    });

    it("a click searches the tag", async () => {
      setFrontmatter("tags: [a]");
      setBody("#Idea");
      useUIStore.getState().closeCommandPalette();
      await mount();
      await act(async () => (q('button[title="In the note"]') as HTMLButtonElement).click());
      expect(useUIStore.getState().commandPaletteIntent).toBe("search-notes");
      expect(useUIStore.getState().commandPaletteSearch).toBe("tag:idea ");
    });

    it("does not touch the front matter", async () => {
      setFrontmatter("tags: [a]");
      setBody("#idea");
      await mount();
      expect(stored()).toBe("tags: [a]");
    });
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
      "URL",
      "Enum",
      "Object",
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
    expect(openNew).toHaveBeenCalledWith("/vault/Alpha.md", { activate: false });
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
  const enumInfo = (values: string[], icons: Record<string, string> = {}) => ({
    key: "status",
    count: 3,
    types: { text: 3 },
    type: "enum",
    source: "writer",
    mismatched: 0,
    obsidianType: "text",
    values,
    icons,
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

  it("a value the backend auto-added to the list shows in the dropdown, no longer marked", async () => {
    await mountAndLoad("status: blocked");
    expect(trigger().textContent).toContain("not in list"); // until the backend has seen it
    ipc.propertyTypes.mockImplementation(
      async () => [enumInfo(["todo", "doing", "done", "blocked"])] as never,
    );
    await act(async () => changed.handler!()); // `property-types://changed`
    await act(async () => {});
    expect(trigger().dataset.notInList).toBeUndefined();
    expect(trigger().textContent).not.toContain("not in list");
    await act(async () => trigger().click());
    expect(optionLabels()).toEqual(["No value", "todo", "doing", "done", "blocked"]);
    expect(stored()).toBe("status: blocked"); // the note is never rewritten
  });

  describe("value icons", () => {
    // jsdom has no layout: give the picker's grid a size so the virtualizer renders a window
    for (const [name, value] of [
      ["offsetHeight", 216],
      ["clientHeight", 216],
      ["offsetWidth", 316],
      ["clientWidth", 316],
    ] as const) {
      let original: PropertyDescriptor | undefined;
      beforeEach(() => {
        original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
        Object.defineProperty(HTMLElement.prototype, name, {
          configurable: true,
          get: () => value,
        });
      });
      afterEach(() => {
        if (original) Object.defineProperty(HTMLElement.prototype, name, original);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      });
    }

    const slot = (v: string) =>
      document.querySelector<HTMLButtonElement>(`button[aria-label="Icon of ${v}"]`)!;
    const picker = () =>
      document.querySelector<HTMLElement>('[role="dialog"][aria-label^="Icon of"]');
    const list = () => document.querySelector('[role="listbox"]');
    const pause = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

    beforeEach(() => {
      ipc.propertyTypes.mockImplementation(
        async () =>
          [
            enumInfo(["todo", "doing", "done"], { done: "emoji:✅", todo: "icon:Home01Icon" }),
          ] as never,
      );
    });

    it("shows a value's icon in the cell and in its dropdown row; a value without one looks as before", async () => {
      await mountAndLoad("status: done");
      expect(trigger().querySelector('[data-icon-glyph="emoji"]')?.textContent).toBe("✅");
      await act(async () => trigger().click());
      expect(slot("done").querySelector("[data-icon-glyph]")).not.toBeNull();
      await pause(); // the icon set loads lazily
      expect(slot("todo").querySelector('[data-icon-glyph="icon"] svg')).not.toBeNull();
      expect(slot("doing").querySelector("[data-icon-glyph]")).toBeNull();
      await act(async () => optionNamed("doing").click());
      expect(stored()).toBe("status: doing");
      expect(trigger().querySelector("[data-icon-glyph]")).toBeNull();
    });

    it("the slot opens the picker; picking an emoji records it through the one write path", async () => {
      await mountAndLoad("status: doing");
      await act(async () => trigger().click());
      await act(async () => slot("doing").click());
      await pause();
      expect(picker()).not.toBeNull();
      await act(async () => {
        [...picker()!.querySelectorAll<HTMLElement>('[role="tab"]')]
          .find((t) => t.textContent === "Emoji")!
          .click();
      });
      for (let i = 0; i < 50 && !picker()!.querySelector('[role="option"][data-emoji="😀"]'); i++)
        await act(async () => void (await new Promise((r) => setTimeout(r, 40)))); // emoji.json loads lazily
      const grin = picker()!.querySelector<HTMLElement>('[role="option"][data-emoji="😀"]')!;
      await act(async () => {
        grin.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      expect(ipc.propertyTypeSet).toHaveBeenLastCalledWith(
        "status",
        "enum",
        ["todo", "doing", "done"],
        { done: "emoji:✅", todo: "icon:Home01Icon", doing: "emoji:😀" },
      );
      expect(picker()).toBeNull();
      expect(list()).not.toBeNull(); // the dropdown stays open
      expect(stored()).toBe("status: doing"); // the note is never touched
    });

    it("Remove icon drops it; a click inside the picker does not close the dropdown", async () => {
      await mountAndLoad("status: todo");
      await act(async () => trigger().click());
      await act(async () => slot("done").click());
      await pause();
      await act(async () => {
        picker()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      });
      expect(list()).not.toBeNull();
      await act(async () =>
        [...picker()!.querySelectorAll("button")]
          .find((b) => b.textContent === "Remove icon")!
          .click(),
      );
      expect(ipc.propertyTypeSet).toHaveBeenLastCalledWith(
        "status",
        "enum",
        ["todo", "doing", "done"],
        { todo: "icon:Home01Icon" },
      );
    });

    it("Escape closes the picker first, then the dropdown", async () => {
      await mountAndLoad("status: todo");
      await act(async () => trigger().click());
      await act(async () => slot("doing").click());
      await pause();
      const search = picker()!.querySelector<HTMLInputElement>("input[aria-label='Search icons']")!;
      await press(search, "Escape");
      expect(picker()).toBeNull();
      expect(list()).not.toBeNull();
      expect(document.activeElement).toBe(slot("doing"));
      await press(document.activeElement!, "Escape");
      expect(list()).toBeNull();
    });

    it("Tab walks the rows and slots; it leaves the list from the last one", async () => {
      await mountAndLoad("status: todo");
      await act(async () => trigger().click());
      const last = [...document.querySelectorAll<HTMLElement>('[role="listbox"] button')].at(-1)!;
      last.focus();
      await act(async () => {
        last.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        );
      });
      expect(list()).toBeNull();
      await act(async () => trigger().click());
      slot("todo").focus();
      await act(async () => {
        slot("todo").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        );
      });
      expect(list()).not.toBeNull(); // moves to the row's own button
    });
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

describe("object properties", () => {
  const SKILL = [
    "name: demo",
    "metadata:",
    "  author: ada # who",
    "  version: 2",
    "  flags:",
    "    beta: true",
    "    deep:",
    "      x: 1",
    "license: MIT",
  ].join("\n");
  beforeEach(() => {
    useSettingsStore.setState({ settings: { "editor.properties-default-collapsed": "expanded" } });
  });
  const clickButton = (label: string) =>
    act(async () => (q(`[aria-label="${label}"]`) as HTMLButtonElement).click());
  const field = (label: string) => q(`input[aria-label="${label}"]`) as HTMLInputElement;
  const addKey = async (owner: string, name: string) => {
    // the owner's own button comes last: a nested map's is listed before it
    const open = [
      ...host.querySelectorAll<HTMLButtonElement>(`[aria-label="${owner} keys"] ~ ul button`),
    ]
      .filter((b) => b.textContent === "+ Add key")
      .at(-1) as HTMLButtonElement;
    await act(async () => open.click());
    await type(q('input[aria-label="New key name"]') as HTMLInputElement, name, "enter");
  };

  it("shows a skill's metadata as an Object property with indented key rows", async () => {
    await mountAndLoad(SKILL);
    expect(typeButton("metadata", "Object").dataset.type).toBe("object");
    expect(q('[aria-label="metadata keys"]')?.textContent).toContain("3 keys");
    expect(field("metadata.author value").value).toBe("ada");
    expect(field("metadata.version value").value).toBe("2");
    expect(field("metadata.flags.beta value").checked).toBe(true);
    // the top-level row and the one inside the map share no label
    expect(field("name value").value).toBe("demo");
    expect(host.textContent).not.toContain("Not an object");
  });

  it("edits one nested value and changes only that line", async () => {
    await mountAndLoad(SKILL);
    await type(field("metadata.author value"), "grace");
    expect(stored()).toBe(SKILL.replace("author: ada # who", "author: grace # who"));
    await type(field("metadata.version value"), "3", "enter");
    expect(stored()).toBe(
      SKILL.replace("author: ada # who", "author: grace # who").replace("version: 2", "version: 3"),
    );
  });

  it("Escape reverts a nested edit without writing", async () => {
    await mountAndLoad(SKILL);
    const input = field("metadata.author value");
    await act(async () => {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "zed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(input.value).toBe("ada");
    expect(stored()).toBe(SKILL);
  });

  it("edits a level-2 map: toggles a checkbox, adds and removes a key", async () => {
    await mountAndLoad(SKILL);
    await act(async () => field("metadata.flags.beta value").click());
    expect(stored()).toBe(SKILL.replace("beta: true", "beta: false"));
    await addKey("metadata.flags", "gamma");
    expect(stored()).toBe(
      SKILL.replace("beta: true", "beta: false").replace("      x: 1", "      x: 1\n    gamma:"),
    );
    await clickButton("Remove metadata.flags.beta");
    expect(stored()).toBe(
      SKILL.replace("    beta: true\n", "").replace("      x: 1", "      x: 1\n    gamma:"),
    );
  });

  it("adds a key at the end of the map, renames and removes one", async () => {
    await mountAndLoad(SKILL);
    await addKey("metadata", "homepage");
    expect(stored()).toBe(SKILL.replace("license: MIT", "  homepage:\nlicense: MIT"));
    await type(field("Property name metadata.homepage"), "site", "enter");
    expect(stored()).toBe(SKILL.replace("license: MIT", "  site:\nlicense: MIT"));
    await clickButton("Remove metadata.site");
    expect(stored()).toBe(SKILL);
  });

  it("a duplicate key name is refused and the text stays", async () => {
    await mountAndLoad(SKILL);
    await type(field("Property name metadata.version"), "author", "enter");
    expect(stored()).toBe(SKILL);
    expect(q('[role="alert"]')?.textContent).toContain("already exists");
  });

  it("removing the last key leaves {}", async () => {
    await mountAndLoad("metadata:\n  k: v\nz: 1");
    await clickButton("Remove metadata.k");
    expect(stored()).toBe("metadata: {}\nz: 1");
    expect(q('[aria-label="metadata keys"]')?.textContent).toContain("Empty");
  });

  it("a map at level 3 is read-only, shown as source, and never rewritten", async () => {
    await mountAndLoad(SKILL);
    const deep = [...host.querySelectorAll("li")]
      .filter((li) => li.querySelector('input[aria-label="Property name metadata.flags.deep"]'))
      .at(-1) as HTMLElement;
    expect(deep.querySelector("input[aria-label$=' value']")).toBeNull();
    expect(deep.textContent).toContain("x: 1");
    expect(deep.textContent).toContain("Edit in Source");
    await addKey("metadata.flags", "gamma");
    expect(stored()).toContain("    deep:\n      x: 1\n");
  });

  it("a flow map is read-only with its source and an unchanged block", async () => {
    await mountAndLoad("meta: {a: 1}\nz: 1");
    expect(host.textContent).toContain("{a: 1}");
    expect(host.textContent).toContain("Edit in Source");
    expect(q('[aria-label="meta keys"]')).toBeNull();
    await type(field("z value"), "2");
    expect(stored()).toBe("meta: {a: 1}\nz: 2");
  });

  it("a nested list is edited as chips", async () => {
    await mountAndLoad("m:\n  tags:\n    - a\n    - b\nz: 1");
    await type(field("Add to m.tags"), "c", "enter");
    expect(stored()).toBe("m:\n  tags:\n    - a\n    - b\n    - c\nz: 1");
    await clickButton("Remove a");
    expect(stored()).toBe("m:\n  tags:\n    - b\n    - c\nz: 1");
  });
});

// ---------------------------------------------------------------------------
// url: link chips that open on click, edited with a pencil
// ---------------------------------------------------------------------------

describe("url properties", () => {
  const chips = (key = "site") => [
    ...host.querySelectorAll<HTMLElement>(`li:has([aria-label^="Add to ${key}"]) [data-url-chip]`),
  ];
  const chipLink = (i = 0) => chips()[i]!.querySelector<HTMLButtonElement>("button[title]")!;
  const pencil = () => q('button[aria-label="Edit site"]') as HTMLButtonElement;
  const edit = () => q('input[aria-label="site value"]') as HTMLInputElement;
  const clickWith = (el: Element, init: MouseEventInit) =>
    act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    });
  const opened = () => vi.mocked(openUrl);

  beforeEach(() => {
    opened().mockReset().mockResolvedValue(undefined);
    recorded.set("site", "url");
  });

  it("a recorded url shows a link chip: host and path, the full value in the title", async () => {
    await mountAndLoad("site: https://www.example.com/docs/a?x=1");
    expect(typeButton("site", "URL").dataset.type).toBe("url");
    expect(chips()).toHaveLength(1);
    expect(chipLink().textContent).toBe("example.com/docs/a?x=1");
    expect(chipLink().title).toBe("https://www.example.com/docs/a?x=1");
    expect(q('[role="status"]')).toBeNull();
  });

  it("is inferred from the value when the vault has no record", async () => {
    recorded.clear();
    await mountAndLoad("link: https://example.com\nbare: example.org\nnote: hello");
    expect(typeButton("link", "URL")).not.toBeNull();
    expect(typeButton("bare", "URL")).not.toBeNull();
    expect(typeButton("note", "Text")).not.toBeNull();
  });

  it("a click opens it through link activation: plain, Cmd/Ctrl and middle click", async () => {
    await mountAndLoad("site: example.com/a");
    await clickWith(chipLink(), {});
    expect(opened()).toHaveBeenLastCalledWith("https://example.com/a"); // a bare domain opens as https
    await clickWith(chipLink(), { metaKey: true, ctrlKey: true });
    expect(opened()).toHaveBeenCalledTimes(2);
    await act(async () => {
      chipLink().dispatchEvent(
        new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
      );
    });
    expect(opened()).toHaveBeenCalledTimes(3);
    await act(async () => {
      chipLink().dispatchEvent(
        new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true }),
      );
    });
    expect(opened()).toHaveBeenCalledTimes(3); // the context-menu button is not a link press
    expect(stored()).toBe("site: example.com/a"); // opening never edits
  });

  it("the pencil edits the raw text: Enter saves, Escape keeps the old value", async () => {
    await mountAndLoad("site: https://old.example");
    await act(async () => pencil().click());
    expect(edit().value).toBe("https://old.example");
    expect(document.activeElement).toBe(edit());
    await type(edit(), "https://new.example/x", "enter");
    expect(stored()).toBe("site: https://new.example/x");
    expect(chipLink().textContent).toBe("new.example/x");
    await act(async () => pencil().click());
    await act(async () => {
      edit().value = "changed";
      edit().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(stored()).toBe("site: https://new.example/x");
    expect(edit()).toBeNull();
    // clearing the text empties the property
    await act(async () => pencil().click());
    await type(edit(), "", "enter");
    expect(stored()).toBe("site:");
  });

  it("the empty part of the row edits too", async () => {
    await mountAndLoad("site: https://a.example");
    const cell = chips()[0]!.parentElement!;
    await act(async () => cell.click());
    expect(edit()).not.toBeNull();
  });

  it("a list adds and removes: a second URL turns a single value into a list", async () => {
    await mountAndLoad("site:");
    const add = () => q('input[aria-label="Add to site"]') as HTMLInputElement;
    await type(add(), "one.example", "enter");
    expect(stored()).toBe("site: one.example");
    await type(add(), "https://two.example", "enter");
    expect(stored()).toBe("site:\n  - one.example\n  - https://two.example");
    expect(chips()).toHaveLength(2);
    expect(pencil()).toBeNull(); // a list is edited by × and add
    await type(add(), "three.example", "blur");
    expect(stored()).toBe("site:\n  - one.example\n  - https://two.example\n  - three.example");
    await act(async () => q('button[aria-label="Remove one.example"]')!.click());
    expect(stored()).toBe("site:\n  - https://two.example\n  - three.example");
    await act(async () => q('button[aria-label="Remove three.example"]')!.click());
    expect(stored()).toBe("site:\n  - https://two.example");
  });

  it("a value that is not a URL is marked and never rewritten or made a link", async () => {
    const fm = "site: just some words";
    await mountAndLoad(fm);
    expect(q('[role="status"]')?.textContent).toBe("Not a URL");
    expect(chips()[0]!.dataset.invalid).toBe("true");
    expect(chips()[0]!.querySelector("button[title]")).toBeNull();
    expect(chips()[0]!.textContent).toBe("just some words");
    expect(stored()).toBe(fm);
    // a bad item in a list is marked too, the others stay links
    await act(async () => root.unmount());
    root = createRoot(host);
    await mountAndLoad("site:\n  - good.example\n  - nope nope");
    expect(chips().map((c) => c.dataset.invalid)).toEqual([undefined, "true"]);
    expect(q('[role="status"]')?.textContent).toBe("Not a URL");
    expect(stored()).toBe("site:\n  - good.example\n  - nope nope");
  });

  it("converting to URL keeps the value as written and marks a bad one", async () => {
    recorded.clear();
    await mountAndLoad("a: hello there\nb: x.example");
    vi.mocked(scheduleSave).mockClear();
    await act(async () => typeButton("a", "Text").click());
    await act(async () => menuItem("URL").click());
    expect(stored()).toBe("a: hello there\nb: x.example");
    expect(vi.mocked(scheduleSave)).not.toHaveBeenCalled();
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("a", "url");
    expect(q('[role="status"]')?.textContent).toBe("Not a URL");
  });
});

describe("pinned properties", () => {
  // the fake backend keeps pins (lower-cased name -> place) the way the record does
  const pins = new Map<string, number>();
  const info = (key: string, type: string, extra: object = {}) => ({
    key,
    count: 3,
    types: {},
    type,
    source: "writer",
    mismatched: 0,
    obsidianType: "text",
    values: [],
    icons: {},
    pinned: pins.get(key.toLowerCase()) ?? null,
    ...extra,
  });
  const pin = (...names: string[]) => names.forEach((n, i) => pins.set(n, i));
  const COLLAPSED = (rest: string) =>
    `${Array.from({ length: 7 }, (_, i) => `k${i}: v${i}`).join("\n")}\n${rest}`;
  const chips = () => [...host.querySelectorAll<HTMLElement>("[data-pinned-chip]")];
  const chipLabels = () => chips().map((c) => c.getAttribute("aria-label"));
  const pinButton = (name: string) => q(`button[aria-label$="property ${name}"][aria-pressed]`);

  beforeEach(() => {
    pins.clear();
    ipc.propertyTypes.mockImplementation(
      async () =>
        [
          info("status", "enum", {
            values: ["todo", "doing", "done"],
            icons: { doing: "emoji:🚧" },
          }),
          info("due", "date"),
          info("priority", "text"),
          info("project", "relationships"),
          info("sources", "multitext"),
          info("k0", "text"),
          info("k1", "text"),
        ] as never,
    );
    ipc.propertyPinSet.mockReset().mockImplementation(async (name: string, pinned: boolean) => {
      if (pinned) pins.set(name.toLowerCase(), pins.size);
      else pins.delete(name.toLowerCase());
    });
  });

  it("formats chip values as the panel does: short dates, link titles, lists with +n", () => {
    const text = (fm: string) => chipText(parseProperties(fm).ok ? parseRows(fm)[0] : null!);
    const parseRows = (fm: string) => {
      const parsed = parseProperties(fm);
      return parsed.ok ? parsed.rows : [];
    };
    expect(shortDate("2026-11-20", new Date("2026-06-01"))).toBe("Nov 20");
    expect(shortDate("2025-01-05", new Date("2026-06-01"))).toBe("Jan 5, 2025");
    expect(shortDate("2026-11-20T14:30", new Date("2026-06-01"))).toBe("Nov 20 14:30");
    expect(chipText(parseRows("due: 2026-11-20")[0], new Date("2026-06-01"))).toBe("Nov 20");
    expect(text('project: "[[Plans/Roadmap|The plan]]"')).toBe("The plan");
    expect(text("t: [a, b, c, d]")).toBe("a, b +2");
    expect(text("t: [[[x]], b]")).toBe("x, b");
    expect(text("a:")).toBeNull();
    expect(text("t: []")).toBeNull();
    expect(text("n: 3")).toBe("3");
    expect(text("done: false")).toBe("No");
  });

  it("orders the expanded rows pinned first without touching the file", async () => {
    pin("priority", "status");
    const fm = "title: T\nstatus: todo\ndue: 2026-11-20\npriority: P2";
    await mountAndLoad(fm);
    const names = () =>
      [...host.querySelectorAll<HTMLInputElement>('input[aria-label^="Property name"]')].map(
        (i) => i.value,
      );
    expect(names()).toEqual(["priority", "status", "title", "due"]);
    expect(stored()).toBe(fm);
    const parsed = parseProperties(fm);
    const rows = parsed.ok ? parsed.rows : [];
    expect(orderRows(rows, {}).map((r) => r.key)).toEqual(["title", "status", "due", "priority"]);
  });

  it("the pin button is hidden until hover, shown in the accent while pinned, and tags have none", async () => {
    pin("due");
    await mountAndLoad("tags: [a]\nstatus: todo\ndue: 2026-11-20");
    expect(q('button[aria-label="Pin property tags"]')).toBeNull();
    expect(pinButton("status")?.getAttribute("aria-label")).toBe("Pin property status");
    expect(pinButton("status")?.getAttribute("title")).toBe("Pin");
    expect(pinButton("status")?.className).toContain("group-hover:opacity-100");
    expect(pinButton("status")?.className).not.toContain("var(--accent)");
    expect(pinButton("due")?.getAttribute("aria-label")).toBe("Unpin property due");
    expect(pinButton("due")?.getAttribute("title")).toBe("Unpin");
    expect(pinButton("due")?.className).toContain("var(--accent)");
    expect(pinButton("due")?.className).not.toContain("opacity-0");
  });

  it("pinning and unpinning go through the one write path and reorder the rows", async () => {
    await mountAndLoad("title: T\nstatus: todo");
    await act(async () => pinButton("status")!.click());
    expect(ipc.propertyPinSet).toHaveBeenCalledWith("status", true);
    expect(pinButton("status")?.getAttribute("aria-pressed")).toBe("true");
    expect(
      (q('input[aria-label^="Property name"]') as HTMLInputElement).value,
      "pinned row comes first",
    ).toBe("status");
    await act(async () => pinButton("status")!.click());
    expect(ipc.propertyPinSet).toHaveBeenLastCalledWith("status", false);
    expect(pinButton("status")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("a failed pin rolls back and says so", async () => {
    ipc.propertyPinSet.mockRejectedValueOnce(new Error("disk full"));
    await mountAndLoad("title: T\nstatus: todo");
    await act(async () => pinButton("status")!.click());
    expect(pinButton("status")?.getAttribute("aria-pressed")).toBe("false");
    expect(q('[role="alert"]')?.textContent).toContain("Could not save the pin of");
  });

  it("the collapsed header shows pinned chips after the tags, in pin order, with the type or enum icon", async () => {
    pin("due", "status", "priority");
    await mountAndLoad(COLLAPSED("tags: [x]\nstatus: doing\ndue: 2026-11-20\npriority: P2"));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(chipLabels()).toEqual(["due: Nov 20", "status: doing", "priority: P2"]);
    expect(chips().map((c) => c.title)).toEqual(["due", "status", "priority"]);
    expect(chips()[0].querySelector("svg")).not.toBeNull(); // the date's type icon
    expect(chips()[1].querySelector('[data-icon-glyph="emoji"]')?.textContent).toBe("🚧");
    expect(chips()[1].querySelector("svg")).toBeNull();
    // tags first, then the chips (they are not inside the toggle button)
    expect(toggle().textContent).toContain("x");
    expect(toggle().contains(chips()[0])).toBe(false);
  });

  it("shows nothing for a pinned property the note lacks or leaves empty, and +n past four", async () => {
    pin("due", "status", "priority", "sources", "project", "k0");
    await mountAndLoad(COLLAPSED("due:\npriority: P2\nsources: [a, b]\nproject: '[[Alpha]]'"));
    // status is absent and due is empty
    expect(chipLabels()).toEqual(["priority: P2", "sources: a, b", "project: Alpha", "k0: v0"]);
    pin("due", "status", "priority", "sources", "project", "k0", "k1");
    usePropertyTypesStore.setState({ loadedAt: 0 });
    await act(async () => {
      await usePropertyTypesStore.getState().load(true);
    });
    expect(chipLabels()).toHaveLength(4);
    expect(host.querySelector("section")?.textContent).toContain("+1");
  });

  it("shows no chips when expanded", async () => {
    pin("status");
    await mountAndLoad("status: todo");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(chips()).toHaveLength(0);
  });

  it("clicking a text chip edits it in place without expanding, and writes the note", async () => {
    pin("priority");
    await mountAndLoad(COLLAPSED("priority: P2"));
    await act(async () => chips()[0].click());
    const input = document.querySelector<HTMLInputElement>(
      '[role="dialog"] input[aria-label="priority value"]',
    )!;
    expect(input.value).toBe("P2");
    expect(document.activeElement).toBe(input);
    await type(input, "P1", "enter");
    expect(stored()).toContain("priority: P1");
    expect(stored()).toContain("k0: v0");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(chipLabels()).toEqual(["priority: P1"]);
  });

  it("Escape closes the editor without writing", async () => {
    pin("priority");
    await mountAndLoad(COLLAPSED("priority: P2"));
    vi.mocked(scheduleSave).mockClear();
    await act(async () => chips()[0].click());
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await act(async () => {
      input.value = "zzz";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(stored()).toContain("priority: P2");
  });

  it("a click outside commits a typed value", async () => {
    pin("priority");
    await mountAndLoad(COLLAPSED("priority: P2"));
    await act(async () => chips()[0].click());
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "P3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(stored()).toContain("priority: P3");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("a date chip opens the date editor and a pick writes it", async () => {
    pin("due");
    await mountAndLoad(COLLAPSED("due: 2026-11-20"));
    await act(async () => chips()[0].click());
    const input = document.querySelector<HTMLInputElement>(
      '[role="dialog"] input[aria-label="due value"]',
    )!;
    expect(input.type).toBe("date");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "2026-12-01");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(stored()).toContain("due: 2026-12-01");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("an enum chip opens the dropdown under it; a pick writes the value and closes", async () => {
    pin("status");
    await mountAndLoad(COLLAPSED("status: todo"));
    await act(async () => chips()[0].click());
    const options = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(["No value", "todo", "doing", "done"]);
    await act(async () => options.find((o) => o.textContent?.startsWith("done"))!.click());
    expect(stored()).toContain("status: done");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(chipLabels()).toEqual(["status: done"]);
  });

  it("pins are vault-wide: another note with the property shows the chip too", async () => {
    pin("status");
    await mountAndLoad(COLLAPSED("status: doing"));
    expect(chipLabels()).toEqual(["status: doing"]);
    await act(async () => root.unmount());
    root = createRoot(host);
    usePropertiesPanelStore.setState({ notes: new Map() });
    await mountAndLoad(COLLAPSED("other: 1\nstatus: done"));
    expect(chipLabels()).toEqual(["status: done"]);
  });
});
