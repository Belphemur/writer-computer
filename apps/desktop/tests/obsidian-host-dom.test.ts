// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createApp, type App } from "../src/lib/obsidian-host/api/app";
import { createHostServices, Plugin } from "../src/lib/obsidian-host/api/core";
import { installDomHelpers } from "../src/lib/obsidian-host/api/dom";
import { addIcon, setIcon } from "../src/lib/obsidian-host/api/functions";
import {
  Menu,
  Modal,
  PluginSettingTab,
  Setting,
  FuzzySuggestModal,
  SuggestModal,
} from "../src/lib/obsidian-host/api/ui";
import {
  detachedBridge,
  ItemView,
  MarkdownView,
  type EditorBackend,
  type WorkspaceBridge,
  type WorkspaceLeaf,
} from "../src/lib/obsidian-host/api/views";
import { createMemoryVaultIo } from "../src/lib/obsidian-host/testing";

function makeApp(bridge?: Partial<WorkspaceBridge>): App {
  const services = createHostServices({ read: async () => null, write: async () => {} });
  // A fresh bridge per app: never mutate the shared detachedBridge singleton.
  return createApp({
    io: createMemoryVaultIo({ "n.md": "hello" }),
    services,
    bridge: { ...detachedBridge, ...bridge },
  });
}

function makePlugin(app: App, id = "demo"): Plugin {
  return new Plugin(app, { id, name: "Demo", version: "1.0.0" });
}

beforeAll(() => installDomHelpers(window));
afterEach(() => {
  document.body.replaceChildren();
});

describe("DOM helpers", () => {
  it("createDiv/createEl/empty/addClass behave like Obsidian's", () => {
    const root = document.createElement("div");
    const child = (root as any).createDiv({ cls: "a b", text: "hi", attr: { "data-x": "1" } });
    expect(child.className).toBe("a b");
    expect(child.dataset.x).toBe("1");
    expect(child.parentElement).toBe(root);
    const span = (root as any).createEl("span", { text: "s" }, (el: HTMLElement) =>
      el.classList.add("cb"),
    );
    expect(span.className).toBe("cb");
    (root as any).empty();
    expect(root.children).toHaveLength(0);
    (root as any).addClass("x", "y");
    expect(root.className).toBe("x y");
  });
});

describe("icons", () => {
  it("renders a registered svg and a neutral glyph for unknown names", () => {
    addIcon("my-icon", '<path d="M0 0h10v10z"/>');
    const el = document.createElement("div");
    setIcon(el, "my-icon");
    expect(el.querySelector("svg path")).not.toBeNull();
    setIcon(el, "lucide-unknown");
    expect(el.querySelector("svg")?.getAttribute("data-icon")).toBe("lucide-unknown");
  });
});

describe("Setting and components", () => {
  it("builds name/desc and wires components", () => {
    const container = document.createElement("div");
    const onText = vi.fn();
    const onToggle = vi.fn();
    const onDrop = vi.fn();
    const onClick = vi.fn();
    let toggle: any;
    new Setting(container)
      .setName("Name")
      .setDesc("Desc")
      .addText((t) => t.setPlaceholder("p").setValue("v").onChange(onText))
      .addToggle((t) => {
        toggle = t;
        t.setValue(false).onChange(onToggle);
      })
      .addDropdown((d) => d.addOptions({ a: "A", b: "B" }).setValue("b").onChange(onDrop))
      .addButton((b) => b.setButtonText("Go").setCta().onClick(onClick))
      .addSlider((s) => s.setLimits(0, 10, 1).setValue(3));
    expect(container.querySelector(".setting-item-name")?.textContent).toBe("Name");
    expect(container.querySelector(".setting-item-description")?.textContent).toBe("Desc");

    const input = container.querySelector("input[type=text]") as HTMLInputElement;
    expect(input.value).toBe("v");
    input.value = "typed";
    input.dispatchEvent(new Event("input"));
    expect(onText).toHaveBeenCalledWith("typed");

    (container.querySelector(".checkbox-container") as HTMLElement).click();
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(toggle.getValue()).toBe(true);

    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("b");
    select.value = "a";
    select.dispatchEvent(new Event("change"));
    expect(onDrop).toHaveBeenCalledWith("a");

    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.classList.contains("mod-cta")).toBe(true);
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect((container.querySelector("input[type=range]") as HTMLInputElement).value).toBe("3");
  });

  it("PluginSettingTab.display renders into containerEl and hide clears it", () => {
    const app = makeApp();
    const plugin = makePlugin(app);
    class Tab extends PluginSettingTab {
      display(): void {
        new Setting(this.containerEl).setName("X");
      }
    }
    const tab = new Tab(app, plugin);
    plugin.addSettingTab(tab);
    expect(app.services.settingTabs.has("demo:demo")).toBe(true);
    tab.display();
    expect(tab.containerEl.textContent).toContain("X");
    app.services.sweep("demo");
    expect(app.services.settingTabs.size).toBe(0);
    expect(tab.containerEl.children).toHaveLength(0);
  });
});

describe("Modal", () => {
  it("opens, closes on Escape, and the host can close it", () => {
    const app = makeApp();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    class M extends Modal {
      onOpen() {
        onOpen();
        this.contentEl.setText("body");
      }
      onClose() {
        onClose();
      }
    }
    const m = new M(app);
    m.open();
    expect(document.body.contains(m.containerEl)).toBe(true);
    expect(app.modals.has(m)).toBe(true);
    expect(m.contentEl.textContent).toBe("body");
    m.containerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.body.contains(m.containerEl)).toBe(false);
    expect(app.modals.size).toBe(0);

    const m2 = new M(app);
    m2.open();
    app.services.sweep("anything");
    expect(app.modals.size).toBe(0);
  });
});

describe("SuggestModal", () => {
  it("filters, navigates with the keyboard and chooses with Enter", async () => {
    const app = makeApp();
    const chosen = vi.fn();
    class S extends SuggestModal<string> {
      getSuggestions(q: string) {
        return ["apple", "apricot", "banana"].filter((x) => x.includes(q));
      }
      renderSuggestion(v: string, el: HTMLElement) {
        el.setText(v);
      }
      onChooseSuggestion(item: string) {
        chosen(item);
      }
    }
    const s = new S(app);
    s.open();
    await vi.waitFor(() => expect(s.resultContainerEl.children).toHaveLength(3));
    s.inputEl.value = "ap";
    s.inputEl.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(s.resultContainerEl.children).toHaveLength(2));
    s.containerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    s.containerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(chosen).toHaveBeenCalledWith("apricot");
    expect(document.body.contains(s.containerEl)).toBe(false);
  });

  it("FuzzySuggestModal ranks by fuzzy match", async () => {
    const app = makeApp();
    const chosen = vi.fn();
    class F extends FuzzySuggestModal<string> {
      getItems() {
        return ["foo bar", "fobar", "zzz"];
      }
      getItemText(i: string) {
        return i;
      }
      onChooseItem(i: string) {
        chosen(i);
      }
    }
    const f = new F(app);
    f.open();
    f.inputEl.value = "fbr";
    f.inputEl.dispatchEvent(new Event("input"));
    await vi.waitFor(() =>
      expect(f.resultContainerEl.querySelectorAll(".suggestion-item")).toHaveLength(2),
    );
    f.containerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(chosen).toHaveBeenCalledWith("fobar");
  });
});

describe("Menu", () => {
  it("renders items, runs onClick and hides", () => {
    const menu = new Menu();
    const click = vi.fn();
    const hidden = vi.fn();
    menu.addItem((i) => i.setTitle("One").setIcon("x").onClick(click)).addSeparator();
    menu.onHide(hidden);
    menu.showAtPosition({ x: 10, y: 20 });
    expect(document.body.contains(menu.dom)).toBe(true);
    (menu.dom.querySelector(".menu-item") as HTMLElement).click();
    expect(click).toHaveBeenCalledTimes(1);
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(document.body.contains(menu.dom)).toBe(false);
  });
});

describe("plugin-owned UI teardown", () => {
  it("ribbon and status bar elements are removed on sweep", () => {
    const app = makeApp();
    const plugin = makePlugin(app);
    const click = vi.fn();
    const ribbon = plugin.addRibbonIcon("dice", "Roll", click);
    const status = plugin.addStatusBarItem();
    document.body.append(ribbon, status);
    ribbon.click();
    expect(click).toHaveBeenCalledTimes(1);
    expect(app.services.ribbon.size).toBe(1);
    expect(app.services.statusBar.size).toBe(1);
    app.services.sweep("demo");
    expect(document.body.contains(ribbon)).toBe(false);
    expect(document.body.contains(status)).toBe(false);
    expect(app.services.ribbon.size).toBe(0);
  });
});

describe("views and workspace", () => {
  class DemoView extends ItemView {
    opened = vi.fn();
    closed = vi.fn();
    getViewType() {
      return "demo-view";
    }
    getDisplayText() {
      return "Demo";
    }
    async onOpen() {
      this.opened();
      (this.containerEl.children[1] as HTMLElement).setText("mounted");
    }
    async onClose() {
      this.closed();
    }
  }

  it("registerView + getRightLeaf + setViewState opens the view in contentEl", async () => {
    const mounted: WorkspaceLeaf[] = [];
    const app = makeApp({ mountLeaf: (leaf) => void mounted.push(leaf) });
    const plugin = makePlugin(app);
    plugin.registerView("demo-view", (leaf) => new DemoView(leaf));
    const leaf = app.workspace.getRightLeaf(false);
    expect(mounted).toEqual([leaf]);
    await leaf.setViewState({ type: "demo-view", active: true });
    expect(leaf.view).toBeInstanceOf(DemoView);
    expect(leaf.containerEl.querySelector(".view-content")?.textContent).toBe("mounted");
    expect(app.workspace.getLeavesOfType("demo-view")).toEqual([leaf]);
    expect(app.workspace.activeLeaf).toBe(leaf);
    expect(app.workspace.getActiveViewOfType(DemoView)).toBe(leaf.view);
  });

  it("rejects an unknown view type and a duplicate registration", async () => {
    const app = makeApp();
    const leaf = app.workspace.getRightLeaf(false);
    await expect(leaf.setViewState({ type: "nope" })).rejects.toThrow(/Unknown view type/);
    app.workspace.registerView("v", (l) => new DemoView(l));
    expect(() => app.workspace.registerView("v", (l) => new DemoView(l))).toThrow(
      /existing view type/,
    );
  });

  it("detaching the plugin closes its leaves and unregisters its view types", async () => {
    const detached: WorkspaceLeaf[] = [];
    const app = makeApp({ detachLeaf: (l) => void detached.push(l) });
    const plugin = makePlugin(app);
    plugin.registerView("demo-view", (leaf) => new DemoView(leaf));
    const leaf = app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: "demo-view" });
    const view = leaf.view as DemoView;
    app.services.sweep("demo");
    await leaf.settled();
    expect(view.closed).toHaveBeenCalledTimes(1);
    expect(detached).toEqual([leaf]);
    expect(app.workspace.getLeavesOfType("demo-view")).toHaveLength(0);
    expect(app.workspace.viewCreator("demo-view")).toBeUndefined();
  });

  it("a view whose onOpen throws leaves the leaf empty and rejects", async () => {
    const app = makeApp();
    class Bad extends DemoView {
      async onOpen() {
        throw new Error("open failed");
      }
    }
    app.workspace.registerView("bad", (l) => new Bad(l));
    const leaf = app.workspace.getRightLeaf(false);
    await expect(leaf.setViewState({ type: "bad" })).rejects.toThrow("open failed");
    expect(leaf.view.getViewType()).toBe("empty");
  });

  it("onLayoutReady callbacks run once the host marks the layout ready", () => {
    const app = makeApp();
    const early = vi.fn();
    app.workspace.onLayoutReady(early);
    expect(early).not.toHaveBeenCalled();
    app.workspace.markLayoutReady();
    expect(early).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    app.workspace.onLayoutReady(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("getActiveFile and getActiveViewOfType(MarkdownView) come from the bridge", async () => {
    let text = "hello";
    const backend: EditorBackend = {
      getValue: () => text,
      replaceRange: (a, b, t) => void (text = text.slice(0, a) + t + text.slice(b)),
      getSelections: () => [{ anchor: 0, head: 5 }],
      setSelections: () => {},
      focus: () => {},
    };
    const app = makeApp({ getActiveFilePath: () => "n.md", getActiveEditor: () => backend });
    await app.vault.load();
    expect(app.workspace.getActiveFile()?.path).toBe("n.md");
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    expect(view?.file?.path).toBe("n.md");
    expect(view?.editor.getSelection()).toBe("hello");
    view?.editor.replaceSelection("bye");
    expect(text).toBe("bye");
    // editor commands see the same editor
    const plugin = makePlugin(app);
    const seen = vi.fn();
    plugin.addCommand({
      id: "ed",
      name: "Ed",
      editorCallback: (editor) => seen(editor.getValue()),
    });
    expect(app.commands.executeCommandById("demo:ed")).toBe(true);
    expect(seen).toHaveBeenCalledWith("bye");
  });
});
