// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { installDomHelpers } from "../web/host/api/dom";
import { Menu } from "../web/host/api/ui";
import { POPUP_LAYER_ID } from "@/lib/popup-layer";

beforeAll(() => installDomHelpers());

const menus: Menu[] = [];
function open(build: (m: Menu) => void): Menu {
  const m = new Menu();
  build(m);
  m.showAtPosition({ x: 10, y: 10 });
  menus.push(m);
  return m;
}
afterEach(() => {
  for (const m of menus.splice(0)) m.hide();
  vi.useRealTimers();
});

const key = (k: string) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const titles = (m: Menu) =>
  [...m.dom.querySelectorAll(".menu-item-title")].map((e) => e.textContent);

describe("Menu structure", () => {
  it("renders the documented classes in the popup layer", () => {
    const m = open((m) =>
      m
        .addItem((i) => i.setTitle("Check").setIcon("checkbox-glyph"))
        .addSeparator()
        .addItem((i) => i.setTitle("Clear")),
    );
    expect(m.dom.parentElement?.id).toBe(POPUP_LAYER_ID);
    expect(m.dom.className).toBe("menu");
    expect([...m.dom.children].map((c) => c.className)).toEqual([
      "menu-item",
      "menu-separator",
      "menu-item",
    ]);
    const item = m.dom.querySelector(".menu-item")!;
    expect([...item.children].map((c) => c.className)).toEqual([
      "menu-item-icon",
      "menu-item-title",
    ]);
    expect(item.querySelector(".menu-item-icon svg")).not.toBeNull();
    expect(titles(m)).toEqual(["Check", "Clear"]);
  });

  it("toggles state classes", () => {
    const m = open((m) =>
      m.addItem((i) => i.setTitle("a").setChecked(true).setDisabled(true).setWarning(true)),
    );
    const cls = m.dom.querySelector(".menu-item")!.classList;
    expect([...cls]).toEqual(expect.arrayContaining(["is-checked", "is-disabled", "is-warning"]));
  });

  it("groups by section in first-seen order with danger last, separated", () => {
    const m = open((m) =>
      m
        .addItem((i) => i.setTitle("del").setSection("danger"))
        .addItem((i) => i.setTitle("a1").setSection("action"))
        .addItem((i) => i.setTitle("t1").setSection("title"))
        .addItem((i) => i.setTitle("a2").setSection("action")),
    );
    expect(titles(m)).toEqual(["a1", "a2", "t1", "del"]);
    expect(m.dom.querySelectorAll(".menu-separator")).toHaveLength(2);
  });
});

describe("Menu behaviour", () => {
  it("click runs onClick once, skips disabled items, and closes", () => {
    const go = vi.fn();
    const nope = vi.fn();
    const hide = vi.fn();
    const m = open((m) =>
      m
        .addItem((i) => i.setTitle("no").setDisabled(true).onClick(nope))
        .addItem((i) => i.setTitle("go").onClick(go)),
    );
    m.onHide(hide);
    const [no, yes] = [...m.dom.querySelectorAll<HTMLElement>(".menu-item")];
    no.click();
    expect(nope).not.toHaveBeenCalled();
    expect(m.dom.isConnected).toBe(true);
    yes.click();
    expect(go).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(m.dom.isConnected).toBe(false);
  });

  it("arrow keys move the selection (wrapping, skipping disabled), Enter activates", () => {
    const go = vi.fn();
    const m = open((m) =>
      m
        .addItem((i) => i.setTitle("a"))
        .addItem((i) => i.setTitle("skip").setDisabled(true))
        .addItem((i) => i.setTitle("c").onClick(go)),
    );
    const sel = () => m.dom.querySelector(".is-selected .menu-item-title")?.textContent;
    key("ArrowDown");
    expect(sel()).toBe("a");
    key("ArrowDown");
    expect(sel()).toBe("c");
    key("ArrowDown");
    expect(sel()).toBe("a");
    key("ArrowUp");
    expect(sel()).toBe("c");
    key("Enter");
    expect(go).toHaveBeenCalledTimes(1);
    expect(m.dom.isConnected).toBe(false);
  });

  it("Escape closes and is consumed", () => {
    const m = open((m) => m.addItem((i) => i.setTitle("a")));
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    key("Escape");
    window.removeEventListener("keydown", outer);
    expect(m.dom.isConnected).toBe(false);
    expect(outer).not.toHaveBeenCalled();
  });

  it("a press outside closes; a press inside does not", () => {
    vi.useFakeTimers();
    const m = open((m) => m.addItem((i) => i.setTitle("a")));
    vi.runAllTimers();
    m.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(m.dom.isConnected).toBe(true);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(m.dom.isConnected).toBe(false);
  });

  it("the opening click does not close it (outside listener is deferred)", () => {
    vi.useFakeTimers();
    const m = open((m) => m.addItem((i) => i.setTitle("a")));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(m.dom.isConnected).toBe(true);
  });

  it("a submenu opens with ArrowRight, Escape closes only it, a leaf click closes both", () => {
    const leaf = vi.fn();
    const m = open((m) =>
      m.addItem((i) => {
        i.setTitle("more");
        i.setSubmenu().addItem((s) => s.setTitle("leaf").onClick(leaf));
      }),
    );
    key("ArrowDown");
    key("ArrowRight");
    const layer = document.getElementById(POPUP_LAYER_ID)!;
    expect(layer.querySelectorAll(".menu")).toHaveLength(2);
    key("Escape");
    expect(layer.querySelectorAll(".menu")).toHaveLength(1);
    key("ArrowRight");
    layer
      .querySelectorAll<HTMLElement>(".menu")[1]!
      .querySelector<HTMLElement>(".menu-item")!
      .click();
    expect(leaf).toHaveBeenCalledTimes(1);
    expect(layer.querySelectorAll(".menu")).toHaveLength(0);
    expect(m.dom.isConnected).toBe(false);
  });

  it("removes its keyboard listener on hide", () => {
    const m = open((m) => m.addItem((i) => i.setTitle("a")));
    m.hide();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    key("Escape");
    window.removeEventListener("keydown", outer);
    expect(outer).toHaveBeenCalledTimes(1);
  });
});

describe("LanguageTool status bar menu (the calls its published source makes)", () => {
  it("builds the four-item menu with real icons and a disabled-state toggle", () => {
    const m = open((m) =>
      m
        .addItem((i) => i.setTitle("Check current document").setIcon("checkbox-glyph"))
        .addItem((i) => i.setTitle("Disable automatic checking").setIcon("file-text"))
        .addItem((i) =>
          i
            .setTitle("Disable automatic checking for this document")
            .setIcon("uppercase-lowercase-a"),
        )
        .addItem((i) => i.setTitle("Clear suggestions").setIcon("reset").setDisabled(true)),
    );
    expect(titles(m)).toHaveLength(4);
    expect(m.dom.querySelectorAll(".menu-item-icon svg")).toHaveLength(4);
    expect(m.dom.querySelectorAll(".menu-item.is-disabled")).toHaveLength(1);
  });
});
