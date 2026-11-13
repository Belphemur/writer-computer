// Adapted from opensidian (GPL-3.0-or-later).
// Core of the `obsidian` shim: Events, Component, Notice, Scope/Keymap, the command registry,
// the per-owner registries every plugin-registered thing lives in, and Plugin.
//
// Teardown model (one write path): everything a plugin registers goes into an OwnedRegistry
// keyed by the plugin id, so disabling a plugin is `services.sweep(id)` and nothing else.
import { createEl } from "./dom";
import { setIcon } from "./functions";
import type { App } from "./app";

// ---------------------------------------------------------------- Events

export interface EventRef {
  e: Events;
  name: string;
  fn: (...args: any[]) => unknown;
  ctx?: unknown;
}

export class Events {
  private handlers = new Map<string, Set<EventRef>>();

  on(name: string, callback: (...args: any[]) => unknown, ctx?: unknown): EventRef {
    const ref: EventRef = { e: this, name, fn: callback, ctx };
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(ref);
    return ref;
  }

  off(name: string, callback: (...args: any[]) => unknown): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const ref of set) if (ref.fn === callback) set.delete(ref);
  }

  offref(ref: EventRef): void {
    this.handlers.get(ref.name)?.delete(ref);
  }

  trigger(name: string, ...data: unknown[]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const ref of Array.from(set)) this.tryTrigger(ref, data);
  }

  tryTrigger(ref: EventRef, args: unknown[]): void {
    try {
      ref.fn.apply(ref.ctx, args);
    } catch (e) {
      console.error(`[plugin] event handler "${ref.name}" threw:`, e);
    }
  }
}

// ---------------------------------------------------------------- Component

export class Component {
  private _loaded = false;
  private _children: Component[] = [];
  private _cleanups: (() => unknown)[] = [];

  /** Resolves when onload() has finished. The host awaits this; plugin code uses load(). */
  async loadAsync(): Promise<void> {
    if (this._loaded) return;
    this._loaded = true;
    await this.onload();
    for (const c of Array.from(this._children)) c.load();
  }

  load(): void {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const r = this.onload() as unknown;
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((e) => console.error("[plugin] onload rejected:", e));
      }
    } catch (e) {
      console.error("[plugin] onload threw:", e);
    }
    for (const c of Array.from(this._children)) c.load();
  }

  onload(): void | Promise<void> {}

  unload(): void {
    if (!this._loaded) return;
    this._loaded = false;
    for (const c of this._children.splice(0).reverse()) c.unload();
    for (const fn of this._cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch (e) {
        console.error("[plugin] cleanup threw:", e);
      }
    }
    try {
      this.onunload();
    } catch (e) {
      console.error("[plugin] onunload threw:", e);
    }
  }

  onunload(): void {}

  get isLoaded(): boolean {
    return this._loaded;
  }

  addChild<T extends Component>(child: T): T {
    this._children.push(child);
    if (this._loaded) child.load();
    return child;
  }

  removeChild<T extends Component>(child: T): T {
    const i = this._children.indexOf(child);
    if (i >= 0) this._children.splice(i, 1);
    child.unload();
    return child;
  }

  register(cb: () => unknown): void {
    this._cleanups.push(cb);
  }

  registerEvent(ref: EventRef): void {
    this.register(() => ref.e.offref(ref));
  }

  registerDomEvent(
    el: EventTarget,
    type: string,
    callback: (ev: any) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.addEventListener(type, callback, options);
    this.register(() => el.removeEventListener(type, callback, options));
  }

  registerInterval(id: number): number {
    this.register(() => clearInterval(id));
    return id;
  }
}

// ---------------------------------------------------------------- Notice

const NOTICE_CONTAINER_CLASS = "notice-container";
const liveNotices = new Set<Notice>();

export class Notice {
  noticeEl: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(message: string | DocumentFragment, duration = 5000) {
    let container = document.body.querySelector<HTMLElement>(`.${NOTICE_CONTAINER_CLASS}`);
    if (!container)
      container = createEl("div", { cls: NOTICE_CONTAINER_CLASS, parent: document.body });
    this.noticeEl = createEl("div", { cls: "notice", parent: container });
    this.setMessage(message);
    liveNotices.add(this);
    if (duration > 0) this.timer = setTimeout(() => this.hide(), duration);
  }

  setMessage(message: string | DocumentFragment): this {
    this.noticeEl.replaceChildren();
    const msg = createEl("div", { cls: "notice-message" });
    msg.append(message);
    this.noticeEl.appendChild(msg);
    return this;
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.noticeEl.remove();
    liveNotices.delete(this);
  }

  static hideAll(): void {
    for (const n of Array.from(liveNotices)) n.hide();
  }
}

// ---------------------------------------------------------------- Scope / Keymap

export type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";

export interface KeymapEventHandler {
  scope: Scope;
  modifiers: string | null;
  key: string | null;
  func: (evt: KeyboardEvent, ctx: unknown) => unknown;
}

export class Scope {
  handlers: KeymapEventHandler[] = [];
  constructor(public parent?: Scope) {}

  register(
    modifiers: Modifier[] | null,
    key: string | null,
    func: (evt: KeyboardEvent, ctx: unknown) => unknown,
  ): KeymapEventHandler {
    const handler: KeymapEventHandler = {
      scope: this,
      modifiers: modifiers ? modifiers.join(",") : null,
      key,
      func,
    };
    this.handlers.push(handler);
    return handler;
  }

  unregister(handler: KeymapEventHandler): void {
    const i = this.handlers.indexOf(handler);
    if (i >= 0) this.handlers.splice(i, 1);
  }

  /** Returns true when a handler consumed the event. */
  handleKey(evt: KeyboardEvent): boolean {
    for (const h of this.handlers) {
      if (h.key !== null && h.key.toLowerCase() !== evt.key.toLowerCase()) continue;
      if (!Keymap.matchesModifiers(evt, h.modifiers)) continue;
      if (h.func(evt, h) !== false) {
        evt.preventDefault();
        return true;
      }
    }
    return this.parent?.handleKey(evt) ?? false;
  }
}

export class Keymap {
  private scopes: Scope[] = [];
  modifiers = "";

  pushScope(scope: Scope): void {
    this.scopes.push(scope);
  }
  popScope(scope: Scope): void {
    const i = this.scopes.lastIndexOf(scope);
    if (i >= 0) this.scopes.splice(i, 1);
  }
  get activeScope(): Scope | undefined {
    return this.scopes[this.scopes.length - 1];
  }

  static isModifier(evt: Event, modifier: Modifier): boolean {
    const e = evt as KeyboardEvent;
    switch (modifier) {
      case "Mod":
        return e.metaKey || e.ctrlKey;
      case "Ctrl":
        return e.ctrlKey;
      case "Meta":
        return e.metaKey;
      case "Shift":
        return e.shiftKey;
      case "Alt":
        return e.altKey;
    }
  }

  static isModEvent(evt?: Event | null): boolean {
    return !!evt && Keymap.isModifier(evt, "Mod");
  }

  static matchesModifiers(evt: KeyboardEvent, modifiers: string | null): boolean {
    const want = new Set((modifiers ?? "").split(",").filter(Boolean));
    const mod = want.has("Mod");
    const meta = want.has("Meta") || (mod && /Mac/i.test(globalThis.navigator?.platform ?? ""));
    const ctrl = want.has("Ctrl") || (mod && !meta);
    return (
      evt.metaKey === meta &&
      evt.ctrlKey === ctrl &&
      evt.shiftKey === want.has("Shift") &&
      evt.altKey === want.has("Alt")
    );
  }
}

// ---------------------------------------------------------------- OwnedRegistry

/** Keyed registry whose entries belong to an owner (plugin id), removable as a group. */
export class OwnedRegistry<T extends { owner: string }> {
  private items = new Map<string, T>();
  private listeners = new Set<() => void>();

  constructor(private dispose?: (item: T) => void) {}

  add(key: string, item: T): () => void {
    this.remove(key);
    this.items.set(key, item);
    this.emit();
    return () => {
      if (this.items.get(key) === item) this.remove(key);
    };
  }

  remove(key: string): boolean {
    const item = this.items.get(key);
    if (!item) return false;
    this.items.delete(key);
    this.dispose?.(item);
    this.emit();
    return true;
  }

  removeOwner(owner: string): number {
    let n = 0;
    for (const [key, item] of Array.from(this.items)) {
      if (item.owner !== owner) continue;
      this.items.delete(key);
      this.dispose?.(item);
      n++;
    }
    if (n > 0) this.emit();
    return n;
  }

  get(key: string): T | undefined {
    return this.items.get(key);
  }
  has(key: string): boolean {
    return this.items.has(key);
  }
  list(): T[] {
    return [...this.items.values()];
  }
  get size(): number {
    return this.items.size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of Array.from(this.listeners)) l();
  }
}

// ---------------------------------------------------------------- Commands

export interface Hotkey {
  modifiers: Modifier[];
  key: string;
}

export interface Command {
  id: string;
  name: string;
  icon?: string;
  mobileOnly?: boolean;
  repeatable?: boolean;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: any, ctx: any) => unknown;
  editorCheckCallback?: (checking: boolean, editor: any, ctx: any) => boolean | void;
  hotkeys?: Hotkey[];
}

export interface RegisteredCommand {
  id: string;
  name: string;
  icon?: string;
  hotkeys: Hotkey[];
  owner: string;
  /** Whether the command can run right now (checkCallback(true) / an active editor). */
  isAvailable(): boolean;
  run(): void;
}

export interface EditorContext {
  editor: unknown;
  view: unknown;
}

export class CommandRegistry extends OwnedRegistry<RegisteredCommand> {
  private editorProvider: () => EditorContext | null = () => null;

  setEditorProvider(fn: () => EditorContext | null): void {
    this.editorProvider = fn;
  }

  /**
   * Obsidian prefixes the id with `<pluginId>:` and the name with `<plugin name>: `. The public
   * docs only say the returned command has "its ID and name prefixed" (exact format UNCONFIRMED);
   * we follow opensidian (ui/plugins/api-core.js addCmd): prefix unless already prefixed, so a
   * plugin passing an already-prefixed id/name (or re-adding the returned command) is idempotent.
   */
  addForPlugin(owner: string, ownerName: string, cmd: Command): Command {
    const id = cmd.id.startsWith(`${owner}:`) ? cmd.id : `${owner}:${cmd.id}`;
    const name = cmd.name.startsWith(`${ownerName}: `) ? cmd.name : `${ownerName}: ${cmd.name}`;
    const full: Command = { ...cmd, id, name };
    const safe = <R>(label: string, fn: () => R, fallback: R): R => {
      try {
        return fn();
      } catch (e) {
        console.error(`[plugin] command ${id} ${label}:`, e);
        return fallback;
      }
    };
    const ed = (): EditorContext | null => this.editorProvider();
    let isAvailable: () => boolean = () => true;
    let run: () => void;
    if (full.editorCheckCallback) {
      const cb = full.editorCheckCallback;
      isAvailable = () => {
        const x = ed();
        return !!x && !!safe("check", () => cb(true, x.editor, x.view), false);
      };
      run = () => {
        const x = ed();
        if (x) safe("run", () => cb(false, x.editor, x.view), undefined);
      };
    } else if (full.editorCallback) {
      const cb = full.editorCallback;
      isAvailable = () => ed() !== null;
      run = () => {
        const x = ed();
        if (x) safe("run", () => cb(x.editor, x.view), undefined);
      };
    } else if (full.checkCallback) {
      const cb = full.checkCallback;
      isAvailable = () => !!safe("check", () => cb(true), false);
      run = () => void safe("run", () => cb(false), undefined);
    } else {
      const cb = full.callback;
      run = () => void (cb && safe("run", cb, undefined));
    }
    this.add(id, {
      id,
      name,
      icon: full.icon,
      hotkeys: full.hotkeys ?? [],
      owner,
      isAvailable,
      run,
    });
    return full;
  }

  /** Runs the command when it exists and is available. Returns whether it ran. */
  execute(id: string): boolean {
    const c = this.get(id);
    if (!c || !c.isAvailable()) return false;
    c.run();
    return true;
  }
}

// ---------------------------------------------------------------- Host services

export interface RibbonItem {
  owner: string;
  icon: string;
  title: string;
  el: HTMLElement;
}
export interface StatusBarItem {
  owner: string;
  el: HTMLElement;
}
export interface SettingTabLike {
  id: string;
  name: string;
  containerEl: HTMLElement;
  display(): void;
  hide(): void;
}
export interface SettingTabEntry {
  owner: string;
  tab: SettingTabLike;
}

export type RegistrationKind =
  | "editorExtension"
  | "fileExtensions"
  | "postProcessor"
  | "codeBlockProcessor"
  | "protocolHandler"
  | "hoverLinkSource"
  | "editorSuggest"
  | "cliHandler";

/** Things the host cannot act on yet are recorded so it can later, and swept on disable. */
export interface Registration {
  owner: string;
  kind: RegistrationKind;
  key: string;
  value: unknown;
}

export interface PluginDataStore {
  read(pluginId: string): Promise<unknown>;
  write(pluginId: string, data: unknown): Promise<void>;
}

export interface HostServices {
  commands: CommandRegistry;
  ribbon: OwnedRegistry<RibbonItem>;
  statusBar: OwnedRegistry<StatusBarItem>;
  settingTabs: OwnedRegistry<SettingTabEntry>;
  registrations: OwnedRegistry<Registration>;
  data: PluginDataStore;
  /** Extra per-owner cleanup (workspace views, open modals, ...). */
  addSweeper(fn: (owner: string) => void): void;
  /** Removes everything `owner` registered. Idempotent. */
  sweep(owner: string): void;
}

export function createHostServices(data: PluginDataStore): HostServices {
  const sweepers = new Set<(owner: string) => void>();
  const commands = new CommandRegistry();
  const ribbon = new OwnedRegistry<RibbonItem>((i) => i.el.remove());
  const statusBar = new OwnedRegistry<StatusBarItem>((i) => i.el.remove());
  const settingTabs = new OwnedRegistry<SettingTabEntry>((e) => {
    try {
      e.tab.hide();
    } catch (err) {
      console.error("[plugin] setting tab hide threw:", err);
    }
  });
  const registrations = new OwnedRegistry<Registration>();
  return {
    commands,
    ribbon,
    statusBar,
    settingTabs,
    registrations,
    data,
    addSweeper: (fn) => void sweepers.add(fn),
    sweep(owner) {
      commands.removeOwner(owner);
      ribbon.removeOwner(owner);
      statusBar.removeOwner(owner);
      settingTabs.removeOwner(owner);
      registrations.removeOwner(owner);
      for (const fn of sweepers) {
        try {
          fn(owner);
        } catch (e) {
          console.error("[plugin] sweep threw:", e);
        }
      }
    },
  };
}

// ---------------------------------------------------------------- Plugin

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
  dir?: string;
}

let registrationSeq = 0;

export class Plugin extends Component {
  constructor(
    public app: App,
    public manifest: PluginManifest,
  ) {
    super();
  }

  private get services(): HostServices {
    return this.app.services;
  }

  addCommand(command: Command): Command {
    return this.services.commands.addForPlugin(this.manifest.id, this.manifest.name, command);
  }

  removeCommand(commandId: string): void {
    const id = commandId.startsWith(`${this.manifest.id}:`)
      ? commandId
      : `${this.manifest.id}:${commandId}`;
    this.services.commands.remove(id);
  }

  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = createEl("div", { cls: ["side-dock-ribbon-action", "clickable-icon"], title });
    el.setAttribute("aria-label", title);
    el.dataset.plugin = this.manifest.id;
    setIcon(el, icon);
    el.addEventListener("click", (evt) => {
      try {
        void callback(evt);
      } catch (e) {
        console.error(`[plugin] ${this.manifest.id} ribbon callback:`, e);
      }
    });
    this.services.ribbon.add(`${this.manifest.id}:${icon}:${title}`, {
      owner: this.manifest.id,
      icon,
      title,
      el,
    });
    return el;
  }

  addStatusBarItem(): HTMLElement {
    const el = createEl("div", {
      cls: ["status-bar-item", `plugin-${this.manifest.id.replace(/[^A-Za-z0-9_-]/g, "")}`],
    });
    el.dataset.plugin = this.manifest.id;
    this.services.statusBar.add(`${this.manifest.id}:${registrationSeq++}`, {
      owner: this.manifest.id,
      el,
    });
    return el;
  }

  addSettingTab(tab: SettingTabLike): void {
    tab.id = tab.id || this.manifest.id;
    tab.name = tab.name || this.manifest.name;
    this.services.settingTabs.add(`${this.manifest.id}:${tab.id}`, {
      owner: this.manifest.id,
      tab,
    });
  }

  registerView(type: string, viewCreator: (leaf: any) => any): void {
    this.app.workspace.registerViewFor(this.manifest.id, type, viewCreator);
  }

  private record(kind: RegistrationKind, key: string, value: unknown): void {
    this.services.registrations.add(`${this.manifest.id}:${kind}:${key}`, {
      owner: this.manifest.id,
      kind,
      key,
      value,
    });
  }

  registerExtensions(extensions: string[], viewType: string): void {
    for (const ext of extensions) this.record("fileExtensions", ext, viewType);
  }
  registerEditorExtension(extension: unknown): void {
    this.record("editorExtension", String(registrationSeq++), extension);
  }
  registerMarkdownPostProcessor<T>(postProcessor: T, sortOrder?: number): T {
    this.record("postProcessor", String(registrationSeq++), { fn: postProcessor, sortOrder });
    return postProcessor;
  }
  registerMarkdownCodeBlockProcessor<T>(language: string, handler: T, sortOrder?: number): T {
    this.record("codeBlockProcessor", language, { fn: handler, sortOrder });
    return handler;
  }
  registerObsidianProtocolHandler(
    action: string,
    handler: (params: Record<string, string>) => unknown,
  ): void {
    this.record("protocolHandler", action, handler);
  }
  registerHoverLinkSource(id: string, info: unknown): void {
    this.record("hoverLinkSource", id, info);
  }
  registerEditorSuggest(suggest: unknown): void {
    this.record("editorSuggest", String(registrationSeq++), suggest);
  }
  registerCliHandler(command: string, ...rest: unknown[]): void {
    this.record("cliHandler", command, rest);
  }
  /** Bases views are not supported; Obsidian documents `false` as the "not registered" result. */
  registerBasesView(_viewId: string, _registration: unknown): boolean {
    return false;
  }

  private dataQueue: Promise<void> = Promise.resolve();

  /** Parsed contents of the plugin's data.json, or null when absent. */
  async loadData(): Promise<any> {
    // Wait for in-flight writes so a read after saveData() sees it.
    await this.dataQueue.catch(() => undefined);
    return this.services.data.read(this.manifest.id);
  }

  /** Writes are serialized per plugin so the last saveData() call always wins. */
  saveData(data: unknown): Promise<void> {
    const write = this.dataQueue
      .catch(() => undefined)
      .then(() => this.services.data.write(this.manifest.id, data));
    this.dataQueue = write;
    return write;
  }

  onExternalSettingsChange?(): unknown;
  onUserEnable(): void {}
}
