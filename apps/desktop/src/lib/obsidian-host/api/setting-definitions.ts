// Declarative settings (Obsidian 1.13 `getSettingDefinitions()`): the types of the public API
// and the renderer behind the default `SettingTab.display()`. Rendering goes through the same
// Setting/SettingGroup shims classic `display()` plugins use, so the DOM (and the settings CSS)
// is identical. Values flow through the tab's own `getControlValue` / `setControlValue`.
//
// This module imports ui.ts and ui.ts imports it: that cycle is safe because nothing here is
// used at module-evaluation time (no `extends`, no top-level calls).
import { recordPluginError } from "../error-log";
import { createEl } from "./dom";
import { setIcon } from "./functions";
import {
  ExtraButtonComponent,
  SearchComponent,
  SecretComponent,
  Setting,
  SettingGroup,
  type SettingPage,
} from "./ui";
import type { App } from "./app";

// ---------------------------------------------------------------- public types

type Pred = boolean | (() => boolean);
type Desc = string | DocumentFragment;

export interface SettingControlBase<V, K extends string = string> {
  key: K;
  defaultValue?: V;
  validate?: (value: V) => string | void | Promise<string | void>;
  disabled?: Pred;
}
export type SettingControl<K extends string = string> =
  | (SettingControlBase<boolean, K> & { type: "toggle" })
  | (SettingControlBase<string, K> & { type: "dropdown"; options: Record<string, string> })
  | (SettingControlBase<string, K> & { type: "text"; placeholder?: string })
  | (SettingControlBase<string, K> & { type: "textarea"; placeholder?: string; rows?: number })
  | (SettingControlBase<number, K> & {
      type: "number";
      placeholder?: string;
      min?: number;
      max?: number;
      step?: number | "any";
    })
  | (SettingControlBase<string, K> & {
      type: "file";
      placeholder?: string;
      filter?: (file: any) => boolean;
    })
  | (SettingControlBase<string, K> & {
      type: "folder";
      placeholder?: string;
      filter?: (folder: any) => boolean;
      includeRoot?: boolean;
    })
  | (SettingControlBase<number, K> & {
      type: "slider";
      min: number;
      max: number;
      step: number;
      displayFormat?: (value: number) => string;
    })
  | (SettingControlBase<string, K> & { type: "color" })
  | (SettingControlBase<string, K> & { type: "secret" });

export interface SettingDefinitionBase {
  name: string;
  desc?: Desc;
  aliases?: string[];
  searchable?: Pred;
  visible?: Pred;
}
export type SettingDefinition<K extends string = string> = SettingDefinitionBase & {
  control?: SettingControl<K>;
  action?: (el: HTMLElement, index: number) => void;
  render?: (setting: Setting, group: SettingGroup) => void | (() => void);
  disabled?: Pred;
};
export interface SettingDefinitionAddItem {
  name: string;
  action: (el: HTMLElement) => void;
}
export interface SettingDefinitionGroup<K extends string = string> {
  type: "group" | "list";
  heading?: string;
  cls?: string;
  search?: {
    placeholder?: string;
    match: (def: SettingDefinition, query: string) => boolean;
  };
  extraButtons?: ((component: ExtraButtonComponent) => any)[];
  items?: SettingGroupItem<K>[];
  visible?: Pred;
  // list only
  emptyState?: Desc;
  onReorder?: (oldIndex: number, newIndex: number) => void;
  onDelete?: (index: number) => void;
  addItem?: SettingDefinitionAddItem;
}
export type SettingDefinitionList<K extends string = string> = SettingDefinitionGroup<K> & {
  type: "list";
};
export interface SettingDefinitionPage<K extends string = string> {
  type: "page";
  name: string;
  desc?: Desc;
  displayValue?: string | (() => string);
  status?: "warning" | null | (() => "warning" | null);
  items?: SettingDefinitionItem<K>[];
  page?: () => SettingPage;
  visible?: Pred;
}
export type SettingGroupItem<K extends string = string> =
  | SettingDefinition<K>
  | SettingDefinitionPage<K>;
export type SettingDefinitionItem<K extends string = string> =
  | SettingDefinition<K>
  | SettingDefinitionGroup<K>
  | SettingDefinitionPage<K>;

// ---------------------------------------------------------------- view state + host contract

/** What the renderer needs from the tab (kept structural so tests can drive it with a stub). */
export interface DefinitionTab {
  app: App;
  id: string;
  containerEl: HTMLElement;
  getControlValue(key: string): unknown;
  setControlValue(key: string, value: unknown): void | Promise<void>;
  refreshDomState(): void;
  update(): void;
  view: DefinitionViewState;
}

export interface DefinitionViewState {
  /** Names of the open sub-pages, outermost first. Re-resolved against fresh definitions. */
  path: string[];
  refreshers: (() => void)[];
  cleanups: (() => void)[];
  activePage: SettingPage | null;
  /** True while an imperative (`page()` factory) sub-page is open: update() must not rebuild it. */
  onFactoryPage: boolean;
  queries: Map<string, string>;
}

export function newViewState(): DefinitionViewState {
  return {
    path: [],
    refreshers: [],
    cleanups: [],
    activePage: null,
    onFactoryPage: false,
    queries: new Map(),
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    console.error("[plugin] setting definition predicate threw:", e);
    return fallback;
  }
}
function pred(p: Pred | undefined, dflt: boolean): boolean {
  if (p === undefined) return dflt;
  return typeof p === "function" ? safe(p, dflt) : p;
}
function cloneDesc(d: Desc): Desc {
  return typeof d === "string" ? d : (d.cloneNode(true) as DocumentFragment);
}
function isGroup(i: SettingDefinitionItem): i is SettingDefinitionGroup {
  return (i as { type?: string }).type === "group" || (i as { type?: string }).type === "list";
}
function isPage(i: SettingDefinitionItem): i is SettingDefinitionPage {
  return (i as { type?: string }).type === "page";
}

/** Runs and clears every cleanup returned by `render` callbacks; hides an imperative sub-page. */
export function teardownView(view: DefinitionViewState): void {
  const cleanups = view.cleanups.splice(0);
  for (const c of cleanups) {
    try {
      c();
    } catch (e) {
      console.error("[plugin] setting render cleanup threw:", e);
    }
  }
  view.refreshers = [];
  if (view.activePage) {
    try {
      view.activePage.hide();
    } catch (e) {
      console.error("[plugin] setting page hide threw:", e);
    }
    view.activePage = null;
  }
  view.onFactoryPage = false;
}

function findPage(items: SettingDefinitionItem[], name: string): SettingDefinitionPage | null {
  for (const it of items) {
    if (isPage(it)) {
      if (it.name === name) return it;
      const inner = it.items ? findPage(it.items, name) : null;
      if (inner) return inner;
    } else if (isGroup(it) && it.items) {
      const inner = findPage(it.items, name);
      if (inner) return inner;
    }
  }
  return null;
}

// ---------------------------------------------------------------- renderer

interface Ctx {
  tab: DefinitionTab;
  groupCounter: number;
  navigate: (path: string[]) => void;
}

/** Renders `defs` (or the open sub-page of them) into `tab.containerEl`, replacing its content. */
export function renderDefinitions(
  tab: DefinitionTab,
  defs: SettingDefinitionItem[],
  navigate: (path: string[]) => void,
): void {
  const view = tab.view;
  teardownView(view);
  const root = tab.containerEl;
  root.replaceChildren();

  let items = defs;
  const pages: SettingDefinitionPage[] = [];
  for (const name of view.path) {
    const p = findPage(items, name);
    if (!p || !pred(p.visible, true)) break;
    pages.push(p);
    items = p.items ?? [];
  }
  view.path.length = pages.length; // a page that vanished (or hid itself) pops the stack
  const ctx: Ctx = { tab, groupCounter: 0, navigate };
  const current = pages[pages.length - 1];

  if (!current) {
    renderItems(ctx, items, root);
    return;
  }
  const pageEl = createEl("div", { cls: "setting-page", parent: root });
  const titlebar = createEl("div", { cls: "setting-page-titlebar", parent: pageEl });
  const content = createEl("div", { cls: "setting-page-content", parent: pageEl });
  buildTitlebar(ctx, titlebar, current.name);
  if (current.items === undefined && current.page) {
    view.onFactoryPage = true;
    const page = current.page();
    view.activePage = page;
    // The page owns its titlebar/containerEl; ours stands in for its titlebar content.
    pageEl.replaceWith(page.rootEl);
    page.display();
    buildTitlebar(ctx, page.titlebarEl, page.title || current.name);
    return;
  }
  renderItems(ctx, items, content);
}

function buildTitlebar(ctx: Ctx, bar: HTMLElement, title: string): void {
  bar.replaceChildren();
  const back = createEl("div", {
    cls: ["clickable-icon", "setting-page-back"],
    parent: bar,
    attr: { "aria-label": "Back", role: "button", tabindex: "0" },
  });
  setIcon(back, "chevron-left");
  const goBack = () => ctx.navigate(ctx.tab.view.path.slice(0, -1));
  back.addEventListener("click", goBack);
  back.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") goBack();
  });
  createEl("div", { cls: "setting-page-title", text: title, parent: bar });
}

function renderItems(ctx: Ctx, items: SettingDefinitionItem[], parent: HTMLElement): void {
  let run: SettingGroupItem[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const group = new SettingGroup(parent);
    run.forEach((it, i) => renderLeaf(ctx, group, it, i, null, () => true));
    run = [];
  };
  for (const it of items) {
    if (isGroup(it)) {
      flush();
      renderGroup(ctx, it, parent);
    } else run.push(it as SettingGroupItem);
  }
  flush();
}

function renderGroup(ctx: Ctx, def: SettingDefinitionGroup, parent: HTMLElement): void {
  const view = ctx.tab.view;
  const key = `${view.path.join(">")}|${ctx.groupCounter++}`;
  const group = new SettingGroup(parent);
  group.addClass(def.type === "list" ? "setting-list" : "setting-group-definition");
  if (def.cls) group.addClass(...def.cls.split(/\s+/).filter(Boolean));
  if (def.heading) group.setHeading(def.heading);

  let query = view.queries.get(key) ?? "";
  const hasActions = !!(def.search || def.extraButtons?.length || def.addItem);
  if (hasActions) {
    if (!def.heading) group.setHeading("");
    const actions = createEl("div", { cls: "setting-group-actions", parent: group.headingEl! });
    if (def.search) {
      const search = new SearchComponent(actions);
      search.inputEl.classList.add("setting-group-search");
      if (def.search.placeholder) search.setPlaceholder(def.search.placeholder);
      search.setValue(query);
      search.onChange((v) => {
        query = v;
        view.queries.set(key, v);
        ctx.tab.refreshDomState();
      });
    }
    for (const cb of def.extraButtons ?? []) {
      const btn = new ExtraButtonComponent(actions);
      safe(() => cb(btn), undefined);
    }
    if (def.addItem) {
      const add = def.addItem;
      const btn = new ExtraButtonComponent(actions);
      btn.setIcon("plus").setTooltip(add.name);
      btn.extraSettingsEl.classList.add("setting-list-add");
      btn.onClick(() => add.action(btn.extraSettingsEl));
    }
  }

  const children = def.items ?? [];
  const filterFor = (child: SettingGroupItem) => (): boolean => {
    if (!def.search || !query) return true;
    if (isPage(child as SettingDefinitionItem)) return true;
    const d = child as SettingDefinition;
    if (d.searchable !== undefined && !pred(d.searchable, true)) return true;
    return safe(() => def.search!.match(d, query), true);
  };
  children.forEach((child, i) => renderLeaf(ctx, group, child, i, def, filterFor(child)));

  if (def.type === "list" && children.length === 0 && def.emptyState !== undefined) {
    const empty = createEl("div", { cls: "setting-list-empty", parent: group.listEl });
    empty.append(cloneDesc(def.emptyState));
  }
  const applyGroup = () => {
    group.listEl.style.display = pred(def.visible, true) ? "" : "none";
  };
  view.refreshers.push(applyGroup);
  applyGroup();
}

function renderLeaf(
  ctx: Ctx,
  group: SettingGroup,
  item: SettingGroupItem,
  index: number,
  list: SettingDefinitionGroup | null,
  filterOk: () => boolean,
): void {
  if (isPage(item as SettingDefinitionItem)) {
    renderPageEntry(ctx, group, item as SettingDefinitionPage, filterOk);
    return;
  }
  renderDefinition(ctx, group, item as SettingDefinition, index, list, filterOk);
}

function renderPageEntry(
  ctx: Ctx,
  group: SettingGroup,
  def: SettingDefinitionPage,
  filterOk: () => boolean,
): void {
  group.addSetting((s) => {
    s.setName(def.name);
    if (def.desc !== undefined) s.setDesc(cloneDesc(def.desc));
    s.setClass("mod-page");
    s.setClass("mod-clickable");
    const el = s.settingEl;
    el.tabIndex = 0;
    const value = createEl("span", { cls: "setting-page-value", parent: s.controlEl });
    const status = createEl("span", { cls: "setting-page-status", parent: s.controlEl });
    const chevron = createEl("span", { cls: "setting-page-chevron", parent: s.controlEl });
    setIcon(chevron, "chevron-right");
    const open = () => ctx.navigate([...ctx.tab.view.path, def.name]);
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      open();
    });
    el.addEventListener("keydown", (e) => {
      if (e.target === el && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        open();
      }
    });
    const apply = () => {
      el.style.display = pred(def.visible, true) && filterOk() ? "" : "none";
      const dv =
        typeof def.displayValue === "function" ? safe(def.displayValue, "") : def.displayValue;
      value.textContent = dv ?? "";
      const st = typeof def.status === "function" ? safe(def.status, null) : (def.status ?? null);
      status.replaceChildren();
      el.classList.toggle("mod-warning", st === "warning");
      if (st === "warning") setIcon(status, "alert-triangle");
    };
    ctx.tab.view.refreshers.push(apply);
    apply();
  });
}

function renderDefinition(
  ctx: Ctx,
  group: SettingGroup,
  def: SettingDefinition,
  index: number,
  list: SettingDefinitionGroup | null,
  filterOk: () => boolean,
): void {
  const tab = ctx.tab;
  group.addSetting((s) => {
    s.setName(def.name);
    if (def.desc !== undefined) s.setDesc(cloneDesc(def.desc));
    const el = s.settingEl;
    if (def.control) el.dataset.settingKey = def.control.key;
    else el.dataset.settingName = def.name;
    let controlDisabled: Pred | undefined = def.control?.disabled ?? def.disabled;

    if (def.control) bindControl(ctx, s, def.control);
    else if (def.action) {
      const action = def.action;
      s.setClass("mod-clickable");
      el.tabIndex = 0;
      const run = (target: HTMLElement) => {
        if (el.classList.contains("is-disabled")) return;
        safe(() => action(target, index), undefined);
      };
      el.addEventListener("click", (e) => {
        const t = e.target as HTMLElement;
        if (t.closest("a, .extra-setting-button, button, input, select, textarea")) return;
        run(el);
      });
      el.addEventListener("keydown", (e) => {
        if (e.target === el && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          run(el);
        }
      });
    } else if (def.render) {
      const cleanup = safe(() => def.render!(s, group), undefined);
      if (typeof cleanup === "function") tab.view.cleanups.push(cleanup);
      controlDisabled = undefined; // the callback owns the controls
    }

    if (list?.onDelete) {
      const onDelete = list.onDelete;
      const del = new ExtraButtonComponent(s.controlEl);
      del.setIcon("trash").setTooltip("Delete");
      del.extraSettingsEl.classList.add("setting-list-delete");
      del.onClick(() => onDelete(index));
      el.addEventListener("keydown", (e) => {
        if (e.target === el && (e.key === "Delete" || e.key === "Backspace")) {
          e.preventDefault();
          onDelete(index);
        }
      });
    }
    if (list?.onReorder) attachReorder(el, group, index, list.onReorder);

    const apply = () => {
      el.style.display = pred(def.visible, true) && filterOk() ? "" : "none";
      if (controlDisabled !== undefined) s.setDisabled(pred(controlDisabled, false));
    };
    tab.view.refreshers.push(apply);
    apply();
  });
}

let dragIndex: number | null = null;
function attachReorder(
  row: HTMLElement,
  group: SettingGroup,
  index: number,
  onReorder: (from: number, to: number) => void,
): void {
  const handle = createEl("span", { cls: "setting-list-drag-handle" });
  setIcon(handle, "grip-vertical");
  row.prepend(handle);
  handle.draggable = true;
  handle.addEventListener("dragstart", (e) => {
    dragIndex = index;
    e.dataTransfer?.setData("text/plain", String(index));
    row.classList.add("is-dragging");
  });
  handle.addEventListener("dragend", () => {
    dragIndex = null;
    row.classList.remove("is-dragging");
    group.listEl
      .querySelectorAll(".is-drop-target")
      .forEach((n) => n.classList.remove("is-drop-target"));
  });
  row.addEventListener("dragover", (e) => {
    if (dragIndex === null) return;
    e.preventDefault();
    row.classList.add("is-drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
  row.addEventListener("drop", (e) => {
    if (dragIndex === null) return;
    e.preventDefault();
    row.classList.remove("is-drop-target");
    const from = dragIndex;
    dragIndex = null;
    if (from !== index) safe(() => onReorder(from, index), undefined);
  });
}

function setError(s: Setting, message: string | void): void {
  s.settingEl.querySelector(".setting-item-error")?.remove();
  s.settingEl.classList.toggle("has-error", !!message);
  if (message) createEl("div", { cls: "setting-item-error", text: message, parent: s.infoEl });
}

function bindControl(ctx: Ctx, s: Setting, c: SettingControl): void {
  const tab = ctx.tab;
  const read = (): unknown => {
    const v = safe(() => tab.getControlValue(c.key), undefined);
    return v === undefined || v === null ? c.defaultValue : v;
  };
  let seq = 0;
  const validate = async (value: unknown): Promise<string | void> => {
    if (!c.validate) return;
    try {
      return await (c.validate as (v: unknown) => string | void | Promise<string | void>)(value);
    } catch (e) {
      console.error("[plugin] setting validate threw:", e);
    }
  };
  const commit = async (value: unknown): Promise<void> => {
    const mine = ++seq;
    const msg = await validate(value);
    if (mine !== seq) return;
    setError(s, msg);
    if (msg) return;
    try {
      await tab.setControlValue(c.key, value);
    } catch (e) {
      console.error(`[plugin] setControlValue(${c.key}) threw:`, e);
      recordPluginError(tab.id, "settings-tab", e);
    }
    tab.refreshDomState();
  };
  const seeded = read();
  // The stored value may already be invalid: show the message, never rewrite the value.
  void validate(seeded).then((m) => {
    if (m) setError(s, m);
  });

  switch (c.type) {
    case "toggle":
      s.addToggle((t) => t.setValue(seeded === true).onChange((v) => void commit(v)));
      break;
    case "dropdown":
      s.addDropdown((d) =>
        d
          .addOptions(c.options)
          .setValue(seeded === undefined || seeded === null ? "" : String(seeded))
          .onChange((v) => void commit(v)),
      );
      break;
    case "text":
      s.addText((t) => {
        t.setValue(seeded == null ? "" : String(seeded)).onChange((v) => void commit(v));
        if (c.placeholder) t.setPlaceholder(c.placeholder);
      });
      break;
    case "textarea":
      s.addTextArea((t) => {
        t.setValue(seeded == null ? "" : String(seeded)).onChange((v) => void commit(v));
        if (c.placeholder) t.setPlaceholder(c.placeholder);
        if (c.rows) t.inputEl.rows = c.rows;
      });
      break;
    case "number":
      s.addText((t) => {
        const input = t.inputEl;
        input.type = "number";
        if (c.min !== undefined) input.min = String(c.min);
        if (c.max !== undefined) input.max = String(c.max);
        if (c.step !== undefined) input.step = String(c.step);
        if (c.placeholder) t.setPlaceholder(c.placeholder);
        t.setValue(seeded == null ? "" : String(seeded));
        t.onChange((raw) => {
          const n = raw.trim() === "" ? NaN : Number(raw);
          void commit(Number.isFinite(n) ? n : (c.defaultValue ?? 0));
        });
      });
      break;
    case "file":
    case "folder":
      s.addText((t) => {
        t.setValue(seeded == null ? "" : String(seeded)).onChange((v) => void commit(v));
        if (c.placeholder) t.setPlaceholder(c.placeholder);
        attachPathSuggestions(tab.app, t.inputEl, c);
      });
      break;
    case "slider":
      s.addSlider((sl) => {
        sl.setLimits(c.min, c.max, c.step);
        const n = typeof seeded === "number" ? seeded : Number(seeded ?? c.min);
        sl.setValue(Number.isFinite(n) ? n : c.min);
        const fmt = (v: number) =>
          c.displayFormat ? safe(() => c.displayFormat!(v), "") : String(v);
        const readout = createEl("span", { cls: "writer-slider-readout" });
        sl.sliderEl.after(readout);
        const sync = () => {
          const text = fmt(sl.getValue());
          readout.textContent = text;
          readout.style.display = text === "" ? "none" : "";
        };
        sync();
        sl.onChange((v) => {
          sync();
          void commit(v);
        });
      });
      break;
    case "color":
      s.addColorPicker((col) =>
        col
          .setValue(typeof seeded === "string" ? seeded : "#000000")
          .onChange((v) => void commit(v)),
      );
      break;
    case "secret":
      s.addComponent((el) => {
        const sec = new SecretComponent(tab.app, el);
        sec.setValue(seeded == null ? "" : String(seeded));
        sec.onChange((v) => void commit(v));
        return sec;
      });
      break;
  }
}

/** File/folder controls: a text input with a native `<datalist>` of matching vault paths. */
function attachPathSuggestions(
  app: App,
  input: HTMLInputElement,
  c: Extract<SettingControl, { type: "file" | "folder" }>,
): void {
  const id = `setting-paths-${Math.random().toString(36).slice(2, 9)}`;
  const list = createEl("datalist", { attr: { id }, parent: input.parentElement ?? undefined });
  input.setAttribute("list", id);
  const fill = () => {
    list.replaceChildren();
    const vault = app.vault as any;
    let paths: string[] = [];
    safe(() => {
      if (c.type === "file") {
        const files: any[] = vault.getFiles?.() ?? [];
        paths = files.filter((f) => !c.filter || c.filter(f)).map((f) => f.path);
      } else {
        const folders: any[] = vault.getAllFolders?.(!!c.includeRoot) ?? [];
        paths = folders
          .filter((f) => (c.includeRoot || f.path !== "/") && (!c.filter || c.filter(f)))
          .map((f) => f.path);
      }
    }, undefined);
    for (const p of paths.slice(0, 500)) createEl("option", { attr: { value: p }, parent: list });
  };
  input.addEventListener("focus", fill);
}
