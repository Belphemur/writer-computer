// Adapted from opensidian (GPL-3.0-or-later).
// UI building blocks plugins render with: Modal, SuggestModal, Setting + components,
// PluginSettingTab, Menu. Plain DOM, no framework; class names follow Obsidian's so a
// plugin's own styles.css applies.
import { Scope, type SettingTabLike } from "./core";
import { createEl } from "./dom";
import { prepareFuzzySearch, renderMatches, setIcon, type SearchResult } from "./functions";
import type { App } from "./app";
import type { Plugin } from "./core";

// ---------------------------------------------------------------- Modal

export class Modal {
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  scope: Scope;
  shouldRestoreSelection = false;
  private isOpen = false;
  private bg: HTMLElement;
  private onKeydown = (evt: KeyboardEvent): void => {
    this.scope.handleKey(evt);
  };

  constructor(public app: App) {
    this.containerEl = createEl("div", { cls: "modal-container" });
    this.bg = createEl("div", { cls: "modal-bg", parent: this.containerEl });
    this.modalEl = createEl("div", { cls: "modal", parent: this.containerEl });
    createEl("div", { cls: "modal-close-button", parent: this.modalEl }).addEventListener(
      "click",
      () => this.close(),
    );
    this.titleEl = createEl("div", { cls: "modal-title", parent: this.modalEl });
    this.contentEl = createEl("div", { cls: "modal-content", parent: this.modalEl });
    this.scope = new Scope();
    this.scope.register([], "Escape", () => {
      this.close();
    });
    this.bg.addEventListener("click", () => this.close());
  }

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }

  setContent(content: string | DocumentFragment): this {
    this.contentEl.replaceChildren();
    this.contentEl.append(content);
    return this;
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    document.body.appendChild(this.containerEl);
    this.app.modals.add(this);
    this.app.keymap.pushScope(this.scope);
    this.containerEl.addEventListener("keydown", this.onKeydown);
    try {
      void Promise.resolve(this.onOpen()).catch((e) =>
        console.error("[plugin] modal onOpen rejected:", e),
      );
    } catch (e) {
      console.error("[plugin] modal onOpen threw:", e);
    }
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.containerEl.removeEventListener("keydown", this.onKeydown);
    this.app.keymap.popScope(this.scope);
    this.app.modals.delete(this);
    try {
      this.onClose();
    } catch (e) {
      console.error("[plugin] modal onClose threw:", e);
    }
    this.containerEl.remove();
  }

  onOpen(): void | Promise<void> {}
  onClose(): void {}
}

// ---------------------------------------------------------------- SuggestModal

export abstract class SuggestModal<T> extends Modal {
  inputEl: HTMLInputElement;
  resultContainerEl: HTMLElement;
  limit = 100;
  emptyStateText = "No results found.";
  private suggestions: T[] = [];
  private selected = 0;
  private querySeq = 0;
  private instructionsEl: HTMLElement | null = null;

  constructor(app: App) {
    super(app);
    this.modalEl.classList.add("prompt");
    const input = createEl("div", { cls: "prompt-input-container", parent: this.modalEl });
    this.inputEl = createEl("input", {
      cls: "prompt-input",
      parent: input,
      attr: { type: "text" },
    });
    this.resultContainerEl = createEl("div", { cls: "prompt-results", parent: this.modalEl });
    this.contentEl.remove();
    this.titleEl.remove();
    this.inputEl.addEventListener("input", () => void this.refresh());
    this.scope.register([], "ArrowDown", () => this.move(1));
    this.scope.register([], "ArrowUp", () => this.move(-1));
    this.scope.register([], "Enter", (evt) => {
      this.choose(this.selected, evt);
    });
  }

  setPlaceholder(placeholder: string): void {
    this.inputEl.placeholder = placeholder;
  }

  setInstructions(instructions: { command: string; purpose: string }[]): void {
    this.instructionsEl ??= createEl("div", { cls: "prompt-instructions", parent: this.modalEl });
    this.instructionsEl.replaceChildren();
    for (const i of instructions) {
      const row = createEl("div", { cls: "prompt-instruction", parent: this.instructionsEl });
      createEl("span", { cls: "prompt-instruction-command", text: i.command, parent: row });
      createEl("span", { text: i.purpose, parent: row });
    }
  }

  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
  onNoSuggestion(): void {}

  onOpen(): void | Promise<void> {
    this.inputEl.focus();
    return this.refresh();
  }

  async refresh(): Promise<void> {
    const seq = ++this.querySeq;
    const found = await this.getSuggestions(this.inputEl.value);
    if (seq !== this.querySeq) return; // a newer query superseded this one
    this.suggestions = found.slice(0, this.limit);
    this.selected = 0;
    this.render();
  }

  private render(): void {
    const box = this.resultContainerEl;
    box.replaceChildren();
    if (this.suggestions.length === 0) {
      createEl("div", { cls: "prompt-empty", text: this.emptyStateText, parent: box });
      this.onNoSuggestion();
      return;
    }
    this.suggestions.forEach((s, i) => {
      const el = createEl("div", { cls: "suggestion-item", parent: box });
      el.classList.toggle("is-selected", i === this.selected);
      this.renderSuggestion(s, el);
      el.addEventListener("click", (evt) => this.choose(i, evt));
      el.addEventListener("mousemove", () => this.select(i));
    });
  }

  private select(i: number): void {
    this.selected = i;
    Array.from(this.resultContainerEl.children).forEach((c, idx) =>
      c.classList.toggle("is-selected", idx === i),
    );
  }

  private move(delta: number): void {
    if (this.suggestions.length === 0) return;
    this.select((this.selected + delta + this.suggestions.length) % this.suggestions.length);
  }

  private choose(i: number, evt: MouseEvent | KeyboardEvent): void {
    const item = this.suggestions[i];
    if (item === undefined) return;
    this.close();
    this.onChooseSuggestion(item, evt);
  }
}

export interface FuzzyMatch<T> {
  item: T;
  match: SearchResult;
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

  getSuggestions(query: string): FuzzyMatch<T>[] {
    const search = prepareFuzzySearch(query.trim());
    const out: FuzzyMatch<T>[] = [];
    for (const item of this.getItems()) {
      const match = search(this.getItemText(item));
      if (match) out.push({ item, match });
    }
    return out.sort((a, b) => b.match.score - a.match.score);
  }
  renderSuggestion(value: FuzzyMatch<T>, el: HTMLElement): void {
    renderMatches(el, this.getItemText(value.item), value.match.matches);
  }
  onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseItem(item.item, evt);
  }
}

// ---------------------------------------------------------------- components

export class BaseComponent {
  disabled = false;
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  // Obsidian API: Setting components are chainable via `then`.
  // oxlint-disable-next-line unicorn/no-thenable
  then(cb: (component: this) => unknown): this {
    cb(this);
    return this;
  }
}

export abstract class ValueComponent<T> extends BaseComponent {
  abstract getValue(): T;
  abstract setValue(value: T): this;
}

export class TextComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.inputEl = createEl("input", { parent: containerEl, attr: { type: "text" } });
  }
  setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    return this;
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.inputEl.addEventListener("input", () => void cb(this.inputEl.value));
    return this;
  }
  onChanged(): void {}
}

export class SearchComponent extends TextComponent {
  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.inputEl.type = "search";
  }
}

export class TextAreaComponent extends ValueComponent<string> {
  inputEl: HTMLTextAreaElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.inputEl = createEl("textarea", { parent: containerEl });
  }
  setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    return this;
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.inputEl.addEventListener("input", () => void cb(this.inputEl.value));
    return this;
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement;
  private value = false;
  private listeners: ((v: boolean) => unknown)[] = [];
  constructor(containerEl: HTMLElement) {
    super();
    this.toggleEl = createEl("div", { cls: "checkbox-container", parent: containerEl });
    this.toggleEl.setAttribute("role", "switch");
    this.toggleEl.tabIndex = 0;
    this.toggleEl.addEventListener("click", () => {
      if (this.disabled) return;
      this.setValue(!this.value);
      for (const l of this.listeners) void l(this.value);
    });
  }
  getValue(): boolean {
    return this.value;
  }
  setValue(on: boolean): this {
    this.value = on;
    this.toggleEl.classList.toggle("is-enabled", on);
    this.toggleEl.setAttribute("aria-checked", String(on));
    return this;
  }
  onChange(cb: (value: boolean) => unknown): this {
    this.listeners.push(cb);
    return this;
  }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.selectEl = createEl("select", { cls: "dropdown", parent: containerEl });
  }
  setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.selectEl.disabled = disabled;
    return this;
  }
  addOption(value: string, display: string): this {
    createEl("option", { text: display, value, parent: this.selectEl });
    return this;
  }
  addOptions(options: Record<string, string>): this {
    for (const [v, d] of Object.entries(options)) this.addOption(v, d);
    return this;
  }
  getValue(): string {
    return this.selectEl.value;
  }
  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.selectEl.addEventListener("change", () => void cb(this.selectEl.value));
    return this;
  }
}

export class SliderComponent extends ValueComponent<number> {
  sliderEl: HTMLInputElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.sliderEl = createEl("input", {
      cls: "slider",
      parent: containerEl,
      attr: { type: "range" },
    });
  }
  setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.sliderEl.disabled = disabled;
    return this;
  }
  setLimits(min: number | null, max: number | null, step: number | "any"): this {
    if (min !== null) this.sliderEl.min = String(min);
    if (max !== null) this.sliderEl.max = String(max);
    this.sliderEl.step = String(step);
    return this;
  }
  getValue(): number {
    return Number(this.sliderEl.value);
  }
  setValue(value: number): this {
    this.sliderEl.value = String(value);
    return this;
  }
  setDynamicTooltip(): this {
    return this;
  }
  onChange(cb: (value: number) => unknown): this {
    this.sliderEl.addEventListener("input", () => void cb(this.getValue()));
    return this;
  }
}

export class ColorComponent extends ValueComponent<string> {
  colorPickerEl: HTMLInputElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.colorPickerEl = createEl("input", { parent: containerEl, attr: { type: "color" } });
  }
  getValue(): string {
    return this.colorPickerEl.value;
  }
  setValue(value: string): this {
    this.colorPickerEl.value = value;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.colorPickerEl.addEventListener("input", () => void cb(this.colorPickerEl.value));
    return this;
  }
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.buttonEl = createEl("button", { parent: containerEl });
  }
  setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.buttonEl.disabled = disabled;
    return this;
  }
  setButtonText(name: string): this {
    this.buttonEl.textContent = name;
    return this;
  }
  setIcon(icon: string): this {
    setIcon(this.buttonEl, icon);
    return this;
  }
  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  removeCta(): this {
    this.buttonEl.classList.remove("mod-cta");
    return this;
  }
  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  setClass(cls: string): this {
    this.buttonEl.classList.add(cls);
    return this;
  }
  setTooltip(tooltip: string): this {
    this.buttonEl.setAttribute("aria-label", tooltip);
    return this;
  }
  onClick(cb: (evt: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", (evt) => void cb(evt));
    return this;
  }
}

export class ExtraButtonComponent extends BaseComponent {
  extraSettingsEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.extraSettingsEl = createEl("div", {
      cls: ["clickable-icon", "extra-setting-button"],
      parent: containerEl,
    });
  }
  setIcon(icon: string): this {
    setIcon(this.extraSettingsEl, icon);
    return this;
  }
  setTooltip(tooltip: string): this {
    this.extraSettingsEl.setAttribute("aria-label", tooltip);
    return this;
  }
  onClick(cb: () => unknown): this {
    this.extraSettingsEl.addEventListener("click", () => void cb());
    return this;
  }
}

// ---------------------------------------------------------------- Setting

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  components: BaseComponent[] = [];

  constructor(containerEl: HTMLElement) {
    this.settingEl = createEl("div", { cls: "setting-item", parent: containerEl });
    this.infoEl = createEl("div", { cls: "setting-item-info", parent: this.settingEl });
    this.nameEl = createEl("div", { cls: "setting-item-name", parent: this.infoEl });
    this.descEl = createEl("div", { cls: "setting-item-description", parent: this.infoEl });
    this.controlEl = createEl("div", { cls: "setting-item-control", parent: this.settingEl });
  }

  setName(name: string | DocumentFragment): this {
    this.nameEl.replaceChildren();
    this.nameEl.append(name);
    return this;
  }
  setDesc(desc: string | DocumentFragment): this {
    this.descEl.replaceChildren();
    this.descEl.append(desc);
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }
  setTooltip(tooltip: string): this {
    this.settingEl.setAttribute("aria-label", tooltip);
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.settingEl.classList.toggle("is-disabled", disabled);
    for (const c of this.components) c.setDisabled(disabled);
    return this;
  }
  clear(): this {
    this.controlEl.replaceChildren();
    this.components = [];
    return this;
  }
  // Obsidian API: `Setting.then` is part of the public surface.
  // oxlint-disable-next-line unicorn/no-thenable
  then(cb: (setting: this) => unknown): this {
    cb(this);
    return this;
  }

  private add<C extends BaseComponent>(c: C, cb: (c: C) => unknown): this {
    this.components.push(c);
    cb(c);
    return this;
  }
  addText(cb: (c: TextComponent) => unknown): this {
    return this.add(new TextComponent(this.controlEl), cb);
  }
  addSearch(cb: (c: SearchComponent) => unknown): this {
    return this.add(new SearchComponent(this.controlEl), cb);
  }
  addTextArea(cb: (c: TextAreaComponent) => unknown): this {
    return this.add(new TextAreaComponent(this.controlEl), cb);
  }
  addToggle(cb: (c: ToggleComponent) => unknown): this {
    return this.add(new ToggleComponent(this.controlEl), cb);
  }
  addDropdown(cb: (c: DropdownComponent) => unknown): this {
    return this.add(new DropdownComponent(this.controlEl), cb);
  }
  addSlider(cb: (c: SliderComponent) => unknown): this {
    return this.add(new SliderComponent(this.controlEl), cb);
  }
  addColorPicker(cb: (c: ColorComponent) => unknown): this {
    return this.add(new ColorComponent(this.controlEl), cb);
  }
  addButton(cb: (c: ButtonComponent) => unknown): this {
    return this.add(new ButtonComponent(this.controlEl), cb);
  }
  addExtraButton(cb: (c: ExtraButtonComponent) => unknown): this {
    return this.add(new ExtraButtonComponent(this.controlEl), cb);
  }
  addComponent<C extends BaseComponent>(cb: (el: HTMLElement) => C): this {
    this.components.push(cb(this.controlEl));
    return this;
  }
}

// ---------------------------------------------------------------- setting tabs

export abstract class SettingTab implements SettingTabLike {
  id = "";
  name = "";
  containerEl: HTMLElement;
  constructor(public app: App) {
    this.containerEl = createEl("div", { cls: "vertical-tab-content" });
  }
  abstract display(): void;
  hide(): void {
    this.containerEl.replaceChildren();
  }
}

export class PluginSettingTab extends SettingTab {
  constructor(
    app: App,
    public plugin: Plugin,
  ) {
    super(app);
    this.id = plugin.manifest.id;
    this.name = plugin.manifest.name;
  }
  display(): void {}
}

// ---------------------------------------------------------------- Menu

export class MenuItem {
  dom: HTMLElement;
  private titleEl: HTMLElement;
  private iconEl: HTMLElement;
  section = "";
  submenu: Menu | null = null;
  constructor(private menu: Menu) {
    this.dom = createEl("div", { cls: "menu-item" });
    this.iconEl = createEl("div", { cls: "menu-item-icon", parent: this.dom });
    this.titleEl = createEl("div", { cls: "menu-item-title", parent: this.dom });
  }
  setTitle(title: string | DocumentFragment): this {
    this.titleEl.replaceChildren();
    this.titleEl.append(title);
    return this;
  }
  setIcon(icon: string | null): this {
    if (icon) setIcon(this.iconEl, icon);
    else this.iconEl.replaceChildren();
    return this;
  }
  setChecked(checked: boolean | null): this {
    this.dom.classList.toggle("is-checked", !!checked);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.dom.classList.toggle("is-disabled", disabled);
    return this;
  }
  setIsLabel(isLabel: boolean): this {
    this.dom.classList.toggle("is-label", isLabel);
    return this;
  }
  setWarning(warning: boolean): this {
    this.dom.classList.toggle("is-warning", warning);
    return this;
  }
  setSection(section: string): this {
    this.section = section;
    return this;
  }
  /** Returns the submenu to fill (Obsidian's behaviour); it is also readable as `item.submenu`. */
  setSubmenu(): Menu {
    this.submenu ??= new Menu();
    this.dom.classList.add("has-submenu");
    return this.submenu;
  }
  onClick(cb: (evt: MouseEvent | KeyboardEvent) => unknown): this {
    this.dom.addEventListener("click", (evt) => {
      if (this.dom.classList.contains("is-disabled")) return;
      this.menu.hide();
      void cb(evt);
    });
    return this;
  }
}

export class Menu {
  dom: HTMLElement;
  private items: MenuItem[] = [];
  private hideCbs: (() => unknown)[] = [];
  private open = false;
  private onDocClick = (evt: MouseEvent): void => {
    if (!this.dom.contains(evt.target as Node)) this.hide();
  };

  constructor() {
    this.dom = createEl("div", { cls: "menu" });
  }

  addItem(cb: (item: MenuItem) => unknown): this {
    const item = new MenuItem(this);
    this.items.push(item);
    this.dom.appendChild(item.dom);
    cb(item);
    return this;
  }
  addSeparator(): this {
    createEl("div", { cls: "menu-separator", parent: this.dom });
    return this;
  }
  setNoIcon(): this {
    this.dom.classList.add("no-icon");
    return this;
  }
  setUseNativeMenu(): this {
    return this;
  }
  onHide(cb: () => unknown): void {
    this.hideCbs.push(cb);
  }

  showAtPosition(position: { x: number; y: number }): this {
    this.dom.style.position = "fixed";
    this.dom.style.left = `${position.x}px`;
    this.dom.style.top = `${position.y}px`;
    document.body.appendChild(this.dom);
    this.open = true;
    // Defer so the click that opened the menu does not immediately close it.
    setTimeout(() => {
      if (this.open) document.addEventListener("mousedown", this.onDocClick, true);
    }, 0);
    return this;
  }
  showAtMouseEvent(evt: MouseEvent): this {
    return this.showAtPosition({ x: evt.clientX, y: evt.clientY });
  }
  hide(): this {
    if (!this.open) return this;
    this.open = false;
    document.removeEventListener("mousedown", this.onDocClick, true);
    this.dom.remove();
    for (const cb of this.hideCbs) cb();
    return this;
  }
  close(): void {
    this.hide();
  }
  static forEvent(evt: MouseEvent): Menu {
    return new Menu().showAtMouseEvent(evt);
  }
}
