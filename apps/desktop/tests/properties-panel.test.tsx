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
vi.mock("../src/lib/bases/ipc", () => ({
  indexProperties: vi.fn(async () => [
    { key: "status", count: 4, types: { text: 4 } },
    { key: "due", count: 2, types: { date: 2 } },
  ]),
}));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));

import { PropertiesPanel } from "../src/components/editor-area/properties-panel";
import { useEditorStore } from "../src/stores/editor-store";
import { usePropertiesPanelStore } from "../src/stores/properties-panel-store";
import { useSettingsStore } from "../src/stores/settings-store";

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
    // The vault knows `due` as a date, so the type picker follows it.
    expect((q('select[aria-label="New property type"]') as HTMLSelectElement).value).toBe("date");
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
