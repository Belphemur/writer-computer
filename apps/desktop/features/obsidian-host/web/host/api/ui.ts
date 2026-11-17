// Adapted from opensidian (GPL-3.0-or-later).
// UI building blocks plugins render with: Modal, SuggestModal, Setting + components,
// PluginSettingTab, Menu. Plain DOM, no framework; class names follow Obsidian's so a
// plugin's own styles.css applies.
import { Scope, type SettingTabLike } from "./core";
import { createEl } from "./dom";
import { recordPluginError } from "../error-log";
import { isValidSecretId } from "@/lib/secrets-client";
import { prepareFuzzySearch, renderMatches, setIcon, type SearchResult } from "./functions";
import {
  newViewState,
  renderDefinitions,
  teardownView,
  type DefinitionViewState,
  type SettingDefinitionItem,
} from "./setting-definitions";
import type { App } from "./app";
import type { Plugin } from "./core";
import { pointRect, type Rect } from "@/lib/popup-position";
import { anchorOfElement, getPopupLayer, trackPopup, type TrackedPopup } from "@/lib/popup-layer";

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
      void Promise.resolve(this.onOpen()).catch((e) => {
        console.error("[plugin] modal onOpen rejected:", e);
        recordPluginError("(modal)", "modal-open", e);
      });
    } catch (e) {
      console.error("[plugin] modal onOpen threw:", e);
      recordPluginError("(modal)", "modal-open", e);
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
  setTooltip(tooltip: string, _options?: unknown): this {
    this.toggleEl.setAttribute("aria-label", tooltip);
    return this;
  }
  /** Obsidian: performs the click (toggles the value and notifies `onChange`). */
  onClick(): void {
    this.toggleEl.click();
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

const SECRET_NONE = "";
const SECRET_CREATE = "\u0000create";

/**
 * Obsidian's secret picker: the plugin stores only the chosen secret NAME (in its data.json) and
 * reads the value with `app.secretStorage.getSecret(name)`. Lists the names in the one shared
 * store (`listSecrets`, the same store as Settings > Secrets) and offers "Create new secret"
 * (name + password input), which writes through `setSecret`. The value is never shown or returned.
 */
export class SecretComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;
  private formEl: HTMLElement | null = null;
  private value = "";
  private changeCb: ((value: string) => unknown) | null = null;
  private readonly containerEl: HTMLElement;
  constructor(
    public app: App,
    containerEl: HTMLElement,
  ) {
    super();
    this.containerEl = containerEl;
    this.selectEl = createEl("select", { cls: "dropdown", parent: containerEl });
    this.selectEl.addEventListener("change", () => {
      if (this.selectEl.value === SECRET_CREATE) this.openForm();
      else this.choose(this.selectEl.value);
    });
    this.renderOptions();
  }
  setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.selectEl.disabled = disabled;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  setValue(value: string): this {
    this.value = value;
    this.renderOptions();
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.changeCb = cb;
    return this;
  }
  private renderOptions(): void {
    const names = this.app.secretStorage.listSecrets().sort();
    if (this.value && !names.includes(this.value)) names.unshift(this.value);
    this.selectEl.replaceChildren();
    createEl("option", { text: "Select secret…", value: SECRET_NONE, parent: this.selectEl });
    for (const name of names)
      createEl("option", { text: name, value: name, parent: this.selectEl });
    createEl("option", { text: "Create new secret…", value: SECRET_CREATE, parent: this.selectEl });
    this.selectEl.value = this.value;
  }
  private choose(name: string): void {
    this.value = name;
    void this.changeCb?.(name);
  }
  private closeForm(): void {
    this.formEl?.remove();
    this.formEl = null;
    this.selectEl.value = this.value;
  }
  private openForm(): void {
    this.formEl?.remove();
    const form = createEl("div", { cls: "secret-component-form" });
    this.containerEl.appendChild(form);
    this.formEl = form;
    const name = createEl("input", {
      parent: form,
      attr: { type: "text", placeholder: "Secret name (a-z, 0-9, -)" },
    });
    const secret = createEl("input", {
      parent: form,
      attr: { type: "password", placeholder: "Secret value", autocomplete: "off" },
    });
    const error = createEl("div", { cls: "setting-item-description", parent: form });
    const save = createEl("button", { text: "Save", cls: "mod-cta", parent: form });
    const cancel = createEl("button", { text: "Cancel", parent: form });
    save.addEventListener("click", () => {
      if (!isValidSecretId(name.value)) {
        error.textContent = "Use lowercase letters, digits and dashes.";
        return;
      }
      if (!secret.value) {
        error.textContent = "Enter a value.";
        return;
      }
      this.app.secretStorage.setSecret(name.value, secret.value);
      secret.value = "";
      this.value = name.value;
      this.closeForm();
      this.renderOptions();
      void this.changeCb?.(this.value);
    });
    cancel.addEventListener("click", () => this.closeForm());
    name.focus();
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
    this.syncReadout();
    return this;
  }
  private readoutEl: HTMLElement | null = null;
  private syncReadout(): void {
    if (this.readoutEl) this.readoutEl.textContent = String(this.getValue());
  }
  /** Obsidian shows the value in a hover tooltip; Writer shows it as a readout beside the slider
   *  (like its native range settings). Only added when the plugin asks for it. */
  setDynamicTooltip(): this {
    if (!this.readoutEl) {
      this.readoutEl = createEl("span", { cls: "writer-slider-readout" });
      this.sliderEl.after(this.readoutEl);
      this.sliderEl.addEventListener("input", () => this.syncReadout());
    }
    this.syncReadout();
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

export class SettingGroup {
  listEl: HTMLElement;
  headingEl: HTMLElement | null = null;
  constructor(public containerEl: HTMLElement) {
    this.listEl = createEl("div", { cls: "setting-group", parent: containerEl });
  }
  setHeading(text: string | DocumentFragment): this {
    this.headingEl ??= createEl("div", { cls: "setting-group-heading", parent: this.listEl });
    this.headingEl.replaceChildren(text);
    return this;
  }
  addClass(...classes: string[]): this {
    this.listEl.classList.add(...classes);
    return this;
  }
  addSetting(cb: (setting: Setting) => void): this {
    cb(new Setting(this.listEl));
    return this;
  }
  addSearch(cb: (component: any) => unknown): this {
    return this.addSetting((s) => s.addSearch(cb));
  }
  addExtraButton(cb: (component: any) => unknown): this {
    return this.addSetting((s) => s.addExtraButton(cb));
  }
}

export abstract class SettingPage {
  rootEl: HTMLElement = createEl("div", { cls: "setting-page" });
  titlebarEl: HTMLElement = createEl("div", { cls: "setting-page-titlebar", parent: this.rootEl });
  containerEl: HTMLElement = createEl("div", { cls: "setting-page-content", parent: this.rootEl });
  title = "";
  abstract display(): void;
  hide(): void {
    this.containerEl.replaceChildren();
  }
}

/**
 * Obsidian 1.13: a tab either returns declarative `getSettingDefinitions()` (rendered by the app;
 * `display()` is then NOT called) or, when that is empty, implements classic `display()`.
 * `hostDisplay()` is the host's entry point and applies that precedence.
 */
export abstract class SettingTab implements SettingTabLike {
  id = "";
  name = "";
  icon = "";
  containerEl: HTMLElement;
  settingItems: SettingDefinitionItem[] = [];
  view: DefinitionViewState = newViewState();
  private shown = false;
  private declarative = false;
  constructor(public app: App) {
    this.containerEl = createEl("div", { cls: "vertical-tab-content" });
  }
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }
  getControlValue(key: string): unknown {
    return (this.app.vault as { getConfig?: (k: string) => unknown }).getConfig?.(key);
  }
  setControlValue(key: string, value: unknown): void | Promise<void> {
    (this.app.vault as { setConfig?: (k: string, v: unknown) => void }).setConfig?.(key, value);
  }
  /** Stores fresh definitions; re-renders a displayed declarative tab, keeping scroll and focus. */
  update(): void {
    try {
      this.settingItems = this.getSettingDefinitions() ?? [];
    } catch (e) {
      console.error(`[plugin] settings tab ${this.id} getSettingDefinitions threw:`, e);
      return;
    }
    if (this.shown && this.declarative && !this.view.onFactoryPage) this.rerender();
  }
  /** Re-evaluates every `visible` / `disabled` predicate in place (no re-render). */
  refreshDomState(): void {
    for (const r of this.view.refreshers) r();
  }
  /** Host entry: declarative definitions win over a plugin's own display(). */
  hostDisplay(): void {
    this.shown = true;
    this.settingItems = this.getSettingDefinitions() ?? [];
    this.declarative = this.settingItems.length > 0;
    if (this.declarative) this.rerender(false);
    else this.display();
  }
  /** Default display renders the definitions; a plugin's classic override replaces it. */
  display(): void {
    this.shown = true;
    this.settingItems = this.getSettingDefinitions() ?? [];
    this.declarative = this.settingItems.length > 0;
    if (this.declarative) this.rerender(false);
  }
  private navigate = (path: string[]): void => {
    this.view.path = path;
    this.rerender(false);
  };
  private rerender(keep = true): void {
    const scrolls: [HTMLElement, number][] = [];
    if (keep)
      for (let n = this.containerEl.parentElement; n; n = n.parentElement)
        if (n.scrollTop > 0) scrolls.push([n, n.scrollTop]);
    const active = keep ? document.activeElement : null;
    let focus: { key: string; start: number | null; end: number | null; sel: string } | null = null;
    if (active instanceof HTMLElement && this.containerEl.contains(active)) {
      const row = active.closest<HTMLElement>("[data-setting-key],[data-setting-name]");
      if (row) {
        const k = row.dataset.settingKey ?? row.dataset.settingName ?? "";
        const attr =
          row.dataset.settingKey !== undefined ? "data-setting-key" : "data-setting-name";
        const all = Array.from(row.querySelectorAll("input,textarea,select,[tabindex]"));
        const text = active as HTMLInputElement;
        focus = {
          key: `[${attr}="${CSS.escape(k)}"]`,
          start: text.selectionStart ?? null,
          end: text.selectionEnd ?? null,
          sel: String(all.indexOf(active)),
        };
      }
    }
    renderDefinitions(this, this.settingItems, this.navigate);
    this.refreshDomState();
    for (const [n, top] of scrolls) n.scrollTop = top;
    if (focus) {
      const row = this.containerEl.querySelector<HTMLElement>(focus.key);
      const all = row
        ? Array.from(row.querySelectorAll<HTMLElement>("input,textarea,select,[tabindex]"))
        : [];
      const target = all[Number(focus.sel)] ?? row;
      if (target) {
        target.focus();
        if (focus.start !== null && "setSelectionRange" in target) {
          try {
            (target as HTMLInputElement).setSelectionRange(focus.start, focus.end);
          } catch {
            // input types without selection support
          }
        }
      }
    }
  }
  hide(): void {
    this.shown = false;
    teardownView(this.view);
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
  /** Reads `this.plugin.settings`. */
  getControlValue(key: string): unknown {
    return (this.plugin as unknown as { settings?: Record<string, unknown> }).settings?.[key];
  }
  /** Mutates and persists `this.plugin.settings` (data.json). */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const p = this.plugin as unknown as { settings?: Record<string, unknown> };
    p.settings ??= {};
    p.settings[key] = value;
    await this.plugin.saveData(p.settings);
  }
}

// ---------------------------------------------------------------- Menu

export class MenuItem {
  dom: HTMLElement;
  private titleEl: HTMLElement;
  private iconEl: HTMLElement;
  private clickCb: ((evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
  section = "";
  submenu: Menu | null = null;
  constructor(private menu: Menu) {
    this.dom = createEl("div", { cls: "menu-item" });
    this.dom.setAttribute("role", "menuitem");
    this.iconEl = createEl("div", { cls: "menu-item-icon", parent: this.dom });
    this.titleEl = createEl("div", { cls: "menu-item-title", parent: this.dom });
    this.dom.addEventListener("click", (evt) => this.activate(evt));
    this.dom.addEventListener("mouseenter", () => menu.select(this));
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
    this.dom.setAttribute("aria-checked", String(!!checked));
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.dom.classList.toggle("is-disabled", disabled);
    this.dom.setAttribute("aria-disabled", String(disabled));
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
    this.clickCb = cb;
    return this;
  }
  /** Whether the keyboard and pointer can land on this item. */
  get selectable(): boolean {
    return !this.dom.classList.contains("is-disabled") && !this.dom.classList.contains("is-label");
  }
  /** Click or Enter: a submenu item opens its submenu, any other closes the menu and runs `onClick`. */
  activate(evt: MouseEvent | KeyboardEvent): void {
    if (!this.selectable) return;
    if (this.submenu) {
      this.menu.openSubmenu(this);
      return;
    }
    this.menu.hideAll();
    void this.clickCb?.(evt);
  }
}

type MenuEntry = { el: HTMLElement; item?: MenuItem };

/** The section Obsidian puts last, whatever order items were added in. */
const LAST_SECTION = "danger";

/**
 * Obsidian's `Menu`: a popover of `.menu-item` rows in the host popup layer (placement and
 * clamping by `trackPopup`), styled by theme-compat. Arrow keys / Home / End move the selection,
 * Enter and Space activate it, Escape closes (the innermost submenu first), a press outside closes.
 */
export class Menu {
  dom: HTMLElement;
  private entries: MenuEntry[] = [];
  private hideCbs: (() => unknown)[] = [];
  private open = false;
  private tracked: TrackedPopup | null = null;
  private parent: Menu | null = null;
  private child: Menu | null = null;
  private selected: MenuItem | null = null;
  private onDocClick = (evt: MouseEvent): void => {
    if (!this.contains(evt.target as Node)) this.hide();
  };
  private onKeyDown = (evt: KeyboardEvent): void => {
    if (this.child) return; // the innermost open submenu owns the keyboard
    if (this.handleKey(evt)) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  };

  constructor() {
    this.dom = createEl("div", { cls: "menu" });
    this.dom.setAttribute("role", "menu");
  }

  private get items(): MenuItem[] {
    return this.entries.flatMap((e) => (e.item ? [e.item] : []));
  }

  addItem(cb: (item: MenuItem) => unknown): this {
    const item = new MenuItem(this);
    this.entries.push({ el: item.dom, item });
    cb(item);
    this.layout();
    return this;
  }
  addSeparator(): this {
    this.entries.push({ el: createEl("div", { cls: "menu-separator" }) });
    this.layout();
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

  /** Items in the order they were added, or grouped by `setSection` (first-seen order, "danger"
   *  last) with a separator between groups. */
  private layout(): void {
    const items = this.items;
    if (!items.some((i) => i.section)) {
      this.dom.replaceChildren(...this.entries.map((e) => e.el));
      return;
    }
    const order = [...new Set(items.map((i) => i.section))].sort(
      (a, b) => Number(a === LAST_SECTION) - Number(b === LAST_SECTION),
    );
    const els: HTMLElement[] = [];
    for (const section of order) {
      if (els.length) els.push(createEl("div", { cls: "menu-separator" }));
      els.push(...items.filter((i) => i.section === section).map((i) => i.dom));
    }
    this.dom.replaceChildren(...els);
  }

  /** Whether `node` is inside this menu or one of its open submenus. */
  private contains(node: Node): boolean {
    return this.dom.contains(node) || (this.child?.contains(node) ?? false);
  }

  /** @internal Highlights an item (pointer hover and keyboard share one selection). */
  select(item: MenuItem | null): void {
    if (item && !item.selectable) return;
    if (this.child && this.child !== item?.submenu) this.closeChild();
    this.selected?.dom.classList.remove("is-selected");
    this.selected = item;
    item?.dom.classList.add("is-selected");
  }

  private move(delta: number): void {
    const items = this.items.filter((i) => i.selectable);
    if (!items.length) return;
    const at = this.selected ? items.indexOf(this.selected) : -1;
    const next =
      at === -1 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length;
    this.select(items[next]);
    this.selected?.dom.scrollIntoView?.({ block: "nearest" });
  }

  private handleKey(evt: KeyboardEvent): boolean {
    switch (evt.key) {
      case "ArrowDown":
        this.move(1);
        return true;
      case "ArrowUp":
        this.move(-1);
        return true;
      case "Home":
      case "End": {
        const items = this.items.filter((i) => i.selectable);
        this.select((evt.key === "Home" ? items[0] : items[items.length - 1]) ?? null);
        return true;
      }
      case "Enter":
      case " ":
        this.selected?.activate(evt);
        return true;
      case "ArrowRight":
        if (this.selected?.submenu) this.selected.activate(evt);
        return true;
      case "ArrowLeft":
        if (this.parent) this.hide();
        return true;
      case "Escape":
        this.hide();
        return true;
      default:
        return false;
    }
  }

  /** @internal */
  openSubmenu(item: MenuItem): void {
    const sub = item.submenu;
    if (!sub || sub === this.child) return;
    this.closeChild();
    this.select(item);
    sub.parent = this;
    this.child = sub;
    const r = item.dom.getBoundingClientRect();
    sub.showAtPosition({ x: r.right, y: r.top });
    sub.move(1);
  }

  private closeChild(): void {
    const sub = this.child;
    this.child = null;
    sub?.hide();
  }

  showAtPosition(position: { x: number; y: number }): this {
    // Mounted in the host popup layer and kept inside the window: flips above the pointer near the
    // bottom edge, shifts left near the right edge, scrolls internally when taller than the window.
    this.layout();
    this.dom.style.position = "fixed";
    this.dom.style.left = `${position.x}px`;
    this.dom.style.top = `${position.y}px`;
    getPopupLayer().appendChild(this.dom);
    this.tracked?.dispose();
    this.tracked = trackPopup(this.dom, () => pointRect(position.x, position.y), { gap: 0 });
    if (!this.open) document.addEventListener("keydown", this.onKeyDown, true);
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
    this.closeChild();
    if (this.parent?.child === this) this.parent.child = null;
    this.parent = null;
    document.removeEventListener("mousedown", this.onDocClick, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.tracked?.dispose();
    this.tracked = null;
    this.select(null);
    this.dom.remove();
    for (const cb of this.hideCbs) cb();
    return this;
  }
  /** @internal Closes the whole chain, from the root menu down. */
  hideAll(): void {
    (this.parent ?? this).hideRoot();
  }
  private hideRoot(): void {
    if (this.parent) this.parent.hideRoot();
    else this.hide();
  }
  close(): void {
    this.hide();
  }
  static forEvent(evt: MouseEvent): Menu {
    return new Menu().showAtMouseEvent(evt);
  }
}

// ---------------------------------------------------------------- Suggest popups

/** Obsidian's `PopoverSuggest`: a suggestion list in the host popup layer. Subclasses decide the
 *  anchor; placement (flip, clamp, max-height) is the host's. */
export abstract class PopoverSuggest<T> {
  /** Items shown, selection index. */
  protected suggestions: T[] = [];
  protected selectedIndex = 0;
  suggestEl: HTMLElement;
  containerEl: HTMLElement;
  isOpen = false;
  private tracked: TrackedPopup | null = null;
  private onOutside = (evt: MouseEvent): void => {
    if (!this.containerEl.contains(evt.target as Node) && !this.isAnchor(evt.target)) this.close();
  };

  constructor(
    public app: App,
    public scope: Scope = new Scope(),
  ) {
    this.containerEl = createEl("div", { cls: "suggestion-container" });
    this.suggestEl = createEl("div", { cls: "suggestion", parent: this.containerEl });
    this.scope.register([], "ArrowDown", (evt) => {
      evt.preventDefault();
      this.moveSelection(1);
    });
    this.scope.register([], "ArrowUp", (evt) => {
      evt.preventDefault();
      this.moveSelection(-1);
    });
    this.scope.register([], "Enter", (evt) => {
      evt.preventDefault();
      this.chooseSelected(evt);
    });
    this.scope.register([], "Escape", () => this.close());
  }

  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
  /** Where the list hangs off, in viewport coordinates. */
  protected abstract anchorRect(): Rect;
  protected isAnchor(_target: EventTarget | null): boolean {
    return false;
  }

  /** Shows the list (idempotent) and (re)places it. */
  open(): void {
    if (!this.isOpen) {
      this.isOpen = true;
      getPopupLayer().appendChild(this.containerEl);
      this.app.keymap.pushScope(this.scope);
      document.addEventListener("mousedown", this.onOutside, true);
      this.tracked = trackPopup(this.containerEl, () => this.anchorRect());
    } else {
      this.tracked?.update();
    }
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.removeEventListener("mousedown", this.onOutside, true);
    this.app.keymap.popScope(this.scope);
    this.tracked?.dispose();
    this.tracked = null;
    this.containerEl.remove();
  }

  /** Replaces the list contents; the host re-places the popup (its size changed). */
  protected setSuggestionItems(items: T[]): void {
    this.suggestions = items;
    this.selectedIndex = 0;
    this.suggestEl.replaceChildren();
    items.forEach((value, i) => {
      const el = createEl("div", { cls: "suggestion-item", parent: this.suggestEl });
      el.classList.toggle("is-selected", i === 0);
      this.renderSuggestion(value, el);
      el.addEventListener("click", (evt) => this.selectSuggestion(value, evt));
      el.addEventListener("mousemove", () => this.highlight(i));
    });
    this.tracked?.update();
  }

  private highlight(i: number): void {
    this.selectedIndex = i;
    Array.from(this.suggestEl.children).forEach((c, idx) =>
      c.classList.toggle("is-selected", idx === i),
    );
    this.suggestEl.children[i]?.scrollIntoView?.({ block: "nearest" });
  }

  private moveSelection(delta: number): void {
    if (this.suggestions.length === 0) return;
    this.highlight(
      (this.selectedIndex + delta + this.suggestions.length) % this.suggestions.length,
    );
  }

  private chooseSelected(evt: KeyboardEvent): void {
    const value = this.suggestions[this.selectedIndex];
    if (value !== undefined) this.selectSuggestion(value, evt);
  }
}

/** Obsidian's `AbstractInputSuggest`: a dropdown under a text input. */
export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  limit = 100;
  private selectCb: ((value: T, evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
  private querySeq = 0;

  constructor(
    app: App,
    public textInputEl: HTMLInputElement | HTMLDivElement,
  ) {
    super(app);
    textInputEl.addEventListener("input", () => void this.refresh());
    textInputEl.addEventListener("focus", () => void this.refresh());
  }

  abstract getSuggestions(query: string): T[] | Promise<T[]>;

  setValue(value: string): void {
    if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = value;
    else this.textInputEl.textContent = value;
  }
  getValue(): string {
    return this.textInputEl instanceof HTMLInputElement
      ? this.textInputEl.value
      : (this.textInputEl.textContent ?? "");
  }
  onSelect(cb: (value: T, evt: MouseEvent | KeyboardEvent) => unknown): this {
    this.selectCb = cb;
    return this;
  }
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    void this.selectCb?.(value, evt);
    this.close();
  }
  protected anchorRect(): Rect {
    return anchorOfElement(this.textInputEl)();
  }
  protected override isAnchor(target: EventTarget | null): boolean {
    return target instanceof Node && this.textInputEl.contains(target);
  }

  private async refresh(): Promise<void> {
    const seq = ++this.querySeq;
    const found = await this.getSuggestions(this.getValue());
    if (seq !== this.querySeq) return;
    const items = found.slice(0, this.limit);
    if (items.length === 0) {
      this.close();
      return;
    }
    this.setSuggestionItems(items);
    this.open();
  }
}

export interface EditorSuggestTriggerInfo {
  start: { line: number; ch: number };
  end: { line: number; ch: number };
  query: string;
}

/** Obsidian's `EditorSuggest`: an inline autocomplete anchored to the caret. The host owns
 *  placement: `showAt` takes the caret rectangle and the list flips above it near the bottom of the
 *  window (the chat input at the bottom of the side pane is the common case). Trigger wiring from
 *  the editor is not connected yet (see README). */
export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
  limit = 100;
  context: unknown = null;
  private caret: Rect = pointRect(0, 0);

  abstract onTrigger(
    cursor: unknown,
    editor: unknown,
    file: unknown,
  ): EditorSuggestTriggerInfo | null;
  abstract getSuggestions(context: unknown): T[] | Promise<T[]>;

  protected anchorRect(): Rect {
    return this.caret;
  }
  /** Shows `items` under (or above) the caret rectangle. */
  showAt(caret: Rect, items: T[]): void {
    this.caret = caret;
    this.setSuggestionItems(items.slice(0, this.limit));
    this.open();
  }
  setSuggestions(items: T[]): void {
    this.setSuggestionItems(items.slice(0, this.limit));
  }
  /** Moves the anchor while open (the caret advanced). */
  updateCaret(caret: Rect): void {
    this.caret = caret;
    if (this.isOpen) this.open();
  }
}
