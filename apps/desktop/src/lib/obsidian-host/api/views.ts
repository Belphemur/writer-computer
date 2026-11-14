// Adapted from opensidian (GPL-3.0-or-later).
// Host-agnostic views and workspace: View/ItemView/FileView/MarkdownView, WorkspaceLeaf,
// Workspace and the Editor facade. They never touch React or a store: everything the host has
// to render or answer goes through the `WorkspaceBridge` interface.
import { Component, Events, type EditorContext, type EventRef } from "./core";
import { createEl } from "./dom";
import { setIcon } from "./functions";
import { TFile } from "./vault";
import type { App } from "./app";
import type { EditorView } from "@codemirror/view";

// ---------------------------------------------------------------- host boundary

export type LeafPlacement = "left" | "right" | "main";

/** Obsidian's `PaneType | boolean` argument of `getLeaf` / `openLinkText`. */
export type NewLeafTarget = boolean | "tab" | "split" | "window";

export interface EditorSelectionRange {
  anchor: number;
  head: number;
}

/** What the host's real editor (CodeMirror) offers, offset-based. */
export interface EditorBackend {
  getValue(): string;
  replaceRange(from: number, to: number, text: string): void;
  getSelections(): EditorSelectionRange[];
  setSelections(ranges: EditorSelectionRange[]): void;
  focus(): void;
  /** The CodeMirror 6 view behind the editor, exposed to plugins as `editor.cm`. */
  cm?: EditorView | null;
}

export interface WorkspaceBridge {
  /** A leaf was created: place `leaf.containerEl` somewhere visible (or keep it hidden). */
  mountLeaf(leaf: WorkspaceLeaf, placement: LeafPlacement): void;
  /** Make the leaf visible/focused (open the sidebar, switch the tab). */
  revealLeaf(leaf: WorkspaceLeaf): void;
  /** The leaf's view, title or icon changed. */
  leafChanged(leaf: WorkspaceLeaf): void;
  /** The leaf was closed: remove its container. */
  detachLeaf(leaf: WorkspaceLeaf): void;
  /** Vault-relative path of the active document, if any. */
  getActiveFilePath(): string | null;
  getActiveEditor(): EditorBackend | null;
  /** The plugin leaf whose tab is the active one in the main area, or null (a document or no tab). */
  getActivePluginLeaf(): WorkspaceLeaf | null;
  openFile(path: string, opts: { newLeaf: boolean }): Promise<void>;
}

/** Bridge that keeps leaves in detached DOM. Used until the host is wired and in tests. */
export const detachedBridge: WorkspaceBridge = {
  mountLeaf() {},
  revealLeaf() {},
  leafChanged() {},
  detachLeaf() {},
  getActiveFilePath: () => null,
  getActiveEditor: () => null,
  getActivePluginLeaf: () => null,
  openFile: () => Promise.reject(new Error("openFile: no workspace bridge is attached")),
};

// ---------------------------------------------------------------- Editor

export interface EditorPosition {
  line: number;
  ch: number;
}
export interface EditorRange {
  from: EditorPosition;
  to: EditorPosition;
}
export interface EditorSelection {
  anchor: EditorPosition;
  head: EditorPosition;
}

export class Editor {
  constructor(private backend: EditorBackend) {}

  /**
   * The CodeMirror 6 view behind this editor. Obsidian exposes it undocumented as `editor.cm`;
   * read live from the backend so an editor kept by a plugin never goes stale.
   */
  get cm(): EditorView | null {
    return this.cmOverride !== undefined ? this.cmOverride : (this.backend.cm ?? null);
  }
  set cm(view: EditorView | null) {
    this.cmOverride = view;
  }
  private cmOverride: EditorView | null | undefined;

  getDoc(): this {
    return this;
  }
  getValue(): string {
    return this.backend.getValue();
  }
  setValue(text: string): void {
    this.backend.replaceRange(0, this.getValue().length, text);
  }
  lineCount(): number {
    return this.getValue().split("\n").length;
  }
  lastLine(): number {
    return this.lineCount() - 1;
  }
  getLine(line: number): string {
    return this.getValue().split("\n")[line] ?? "";
  }
  setLine(line: number, text: string): void {
    const from = this.posToOffset({ line, ch: 0 });
    this.backend.replaceRange(from, from + this.getLine(line).length, text);
  }

  posToOffset(pos: EditorPosition): number {
    const lines = this.getValue().split("\n");
    const line = Math.min(Math.max(pos.line, 0), lines.length - 1);
    let off = 0;
    for (let i = 0; i < line; i++) off += lines[i].length + 1;
    return off + Math.min(Math.max(pos.ch, 0), lines[line].length);
  }
  offsetToPos(offset: number): EditorPosition {
    const text = this.getValue();
    const o = Math.min(Math.max(offset, 0), text.length);
    const before = text.slice(0, o);
    const line = before.split("\n").length - 1;
    return { line, ch: o - (before.lastIndexOf("\n") + 1) };
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    return this.getValue().slice(this.posToOffset(from), this.posToOffset(to));
  }
  replaceRange(text: string, from: EditorPosition, to?: EditorPosition): void {
    const a = this.posToOffset(from);
    this.backend.replaceRange(a, to ? this.posToOffset(to) : a, text);
  }

  getSelection(): string {
    const doc = this.getValue();
    return this.backend
      .getSelections()
      .map((r) => doc.slice(Math.min(r.anchor, r.head), Math.max(r.anchor, r.head)))
      .join("\n");
  }
  somethingSelected(): boolean {
    return this.backend.getSelections().some((r) => r.anchor !== r.head);
  }
  replaceSelection(text: string): void {
    const sels = [...this.backend.getSelections()].sort(
      (a, b) => Math.max(b.anchor, b.head) - Math.max(a.anchor, a.head),
    );
    for (const r of sels)
      this.backend.replaceRange(Math.min(r.anchor, r.head), Math.max(r.anchor, r.head), text);
  }
  getCursor(which: "from" | "to" | "head" | "anchor" = "head"): EditorPosition {
    const r = this.backend.getSelections()[0] ?? { anchor: 0, head: 0 };
    const off =
      which === "anchor"
        ? r.anchor
        : which === "from"
          ? Math.min(r.anchor, r.head)
          : which === "to"
            ? Math.max(r.anchor, r.head)
            : r.head;
    return this.offsetToPos(off);
  }
  listSelections(): EditorSelection[] {
    return this.backend
      .getSelections()
      .map((r) => ({ anchor: this.offsetToPos(r.anchor), head: this.offsetToPos(r.head) }));
  }
  setCursor(pos: EditorPosition | number, ch?: number): void {
    const p = typeof pos === "number" ? { line: pos, ch: ch ?? 0 } : pos;
    const o = this.posToOffset(p);
    this.backend.setSelections([{ anchor: o, head: o }]);
  }
  setSelection(anchor: EditorPosition, head?: EditorPosition): void {
    this.backend.setSelections([
      { anchor: this.posToOffset(anchor), head: this.posToOffset(head ?? anchor) },
    ]);
  }
  setSelections(ranges: EditorSelection[]): void {
    this.backend.setSelections(
      ranges.map((r) => ({
        anchor: this.posToOffset(r.anchor),
        head: this.posToOffset(r.head ?? r.anchor),
      })),
    );
  }
  focus(): void {
    this.backend.focus();
  }
  blur(): void {}
  hasFocus(): boolean {
    return true;
  }
  refresh(): void {}
  scrollIntoView(): void {}
}

// ---------------------------------------------------------------- Views

export class View extends Component {
  app: App;
  containerEl: HTMLElement;
  icon = "document";
  navigation = true;

  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.app = leaf.app;
    this.containerEl = createEl("div", { cls: "workspace-leaf-content" });
  }

  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return this.icon;
  }
  getState(): Record<string, unknown> {
    return {};
  }
  setState(_state: unknown, _result?: unknown): Promise<void> {
    return Promise.resolve();
  }
  getEphemeralState(): Record<string, unknown> {
    return {};
  }
  setEphemeralState(_state: unknown): void {}
  onOpen(): Promise<void> {
    return Promise.resolve();
  }
  onClose(): Promise<void> {
    return Promise.resolve();
  }
  onResize(): void {}
  onPaneMenu(_menu: unknown, _source: string): void {}
  focus(): void {}
}

export class ItemView extends View {
  contentEl: HTMLElement;
  private headerEl: HTMLElement;
  private actionsEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.headerEl = createEl("div", { cls: "view-header", parent: this.containerEl });
    this.actionsEl = createEl("div", { cls: "view-actions", parent: this.headerEl });
    // Plugins index `containerEl.children[1]` for the content element, so the order is fixed.
    this.contentEl = createEl("div", { cls: "view-content", parent: this.containerEl });
  }

  addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = createEl("a", {
      cls: ["view-action", "clickable-icon"],
      title,
      parent: this.actionsEl,
    });
    el.setAttribute("aria-label", title);
    setIcon(el, icon);
    el.addEventListener("click", callback);
    return el;
  }
}

export class FileView extends ItemView {
  file: TFile | null = null;
  allowNoFile = false;
  getDisplayText(): string {
    return this.file?.basename ?? "";
  }
  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}
}

export class EditableFileView extends FileView {}

export class TextFileView extends EditableFileView {
  data = "";
  getViewData(): string {
    return this.data;
  }
  setViewData(data: string, _clear: boolean): void {
    this.data = data;
  }
  clear(): void {
    this.data = "";
  }
  requestSave(): void {}
}

/** Facade over the host's active markdown editor; not a view the host mounts. */
export class MarkdownView extends TextFileView {
  editor: Editor;

  constructor(leaf: WorkspaceLeaf, backend?: EditorBackend, file?: TFile | null) {
    super(leaf);
    this.editor = new Editor(backend ?? NO_EDITOR);
    this.file = file ?? null;
  }
  getViewType(): string {
    return "markdown";
  }
  getState(): Record<string, unknown> {
    return this.file ? { file: this.file.path, mode: "source" } : {};
  }
  getMode(): "source" | "preview" {
    return "source";
  }
  getViewData(): string {
    return this.editor.getValue();
  }
  setViewData(data: string): void {
    this.editor.setValue(data);
  }
  getIcon(): string {
    return "document";
  }
}

const NO_EDITOR: EditorBackend = {
  getValue: () => "",
  replaceRange() {
    throw new Error("No active editor");
  },
  getSelections: () => [],
  setSelections() {},
  focus() {},
};

// ---------------------------------------------------------------- Leaves

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
  pinned?: boolean;
}

class EmptyView extends ItemView {
  getViewType(): string {
    return "empty";
  }
  getDisplayText(): string {
    return "New tab";
  }
}

let leafSeq = 0;

export class WorkspaceLeaf extends Component {
  id = `leaf-${++leafSeq}`;
  containerEl = createEl("div", { cls: "workspace-leaf" });
  view: View;
  detached = false;
  /** Obsidian parity: the host never defers loading a view. */
  isDeferred = false;
  /**
   * True for a leaf created by `getLeaf(true | "tab" | ...)` that has not shown anything yet: the
   * first document opened through it becomes a new editor tab instead of replacing the current one.
   */
  pendingNewTab = false;
  private opening: Promise<void> = Promise.resolve();

  constructor(
    public app: App,
    public placement: LeafPlacement,
  ) {
    super();
    this.view = new EmptyView(this);
    this.containerEl.appendChild(this.view.containerEl);
  }

  getViewState(): ViewState {
    return { type: this.view.getViewType(), state: this.view.getState() };
  }

  /** Replaces the leaf's view with the registered view for `viewState.type` and opens it. */
  setViewState(viewState: ViewState, eState?: unknown): Promise<void> {
    // Serialized so two quick setViewState calls cannot interleave open/close.
    const run = this.opening.catch(() => undefined).then(() => this.openView(viewState, eState));
    this.opening = run;
    return run;
  }

  private async openView(viewState: ViewState, eState?: unknown): Promise<void> {
    if (this.detached) throw new Error("Cannot open a view in a detached leaf");
    if (viewState.type === "markdown") {
      // The main editor is the host's, not a registered view: `setViewState({type: "markdown"})`
      // (Obsidian's way of turning a leaf into a note) opens the note in that editor.
      const file = viewState.state?.file;
      if (typeof file !== "string" || !file)
        throw new Error('setViewState({type: "markdown"}) needs state.file');
      await this.app.workspace.openFileInLeaf(this, file);
      return;
    }
    const entry = this.app.workspace.viewCreator(viewState.type);
    if (!entry) throw new Error(`Unknown view type "${viewState.type}"`);
    const next = entry.creator(this) as View;
    await this.closeView();
    this.view = next;
    this.containerEl.replaceChildren(next.containerEl);
    next.load();
    try {
      await next.setState(viewState.state ?? {}, eState);
      await next.onOpen();
    } catch (e) {
      await this.closeView();
      this.view = new EmptyView(this);
      this.containerEl.replaceChildren(this.view.containerEl);
      throw e;
    }
    this.app.workspace.bridge.leafChanged(this);
    if (viewState.active) await this.app.workspace.revealLeaf(this);
  }

  private async closeView(): Promise<void> {
    const v = this.view;
    try {
      await v.onClose();
    } catch (e) {
      console.error("[plugin] view onClose threw:", e);
    }
    v.unload();
  }

  async open(view: View): Promise<View> {
    await this.closeView();
    this.view = view;
    this.containerEl.replaceChildren(view.containerEl);
    view.load();
    await view.onOpen();
    this.app.workspace.bridge.leafChanged(this);
    return view;
  }

  /**
   * Opens a note in Writer's main editor. The editor-area leaf (`getLeaf()` without a new-tab
   * request) reuses the current tab; any other leaf opens a new tab. The note's scroll/line
   * (`openState.eState`) is not applied.
   */
  async openFile(file: TFile, _openState?: unknown): Promise<void> {
    await this.app.workspace.openFileInLeaf(this, file.path);
  }

  /** The workspace split this leaf lives in (Obsidian's `leaf.getRoot()`). */
  getRoot(): SplitLike {
    const ws = this.app.workspace;
    return this.placement === "left"
      ? ws.leftSplit
      : this.placement === "right"
        ? ws.rightSplit
        : ws.rootSplit;
  }

  /** Obsidian parity: leaves are never deferred here. */
  async loadIfDeferred(): Promise<void> {}

  getDisplayText(): string {
    return this.view.getDisplayText();
  }
  getIcon(): string {
    return this.view.getIcon();
  }
  /** Re-reads the view's title and icon (Obsidian's `leaf.updateHeader()`). */
  updateHeader(): void {
    this.app.workspace.bridge.leafChanged(this);
  }
  setPinned(_pinned: boolean): void {}
  setGroup(_group: string): void {}
  onResize(): void {
    this.view.onResize();
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.opening = this.opening
      .catch(() => undefined)
      .then(async () => {
        await this.closeView();
        this.containerEl.remove();
      });
    this.app.workspace.removeLeaf(this);
  }

  /** Resolves when the leaf has finished (re)opening or closing its view. */
  settled(): Promise<void> {
    return this.opening.catch(() => undefined);
  }
}

// ---------------------------------------------------------------- Workspace

export type ViewCreator = (leaf: WorkspaceLeaf) => View;

export interface SplitLike {
  collapsed: boolean;
  collapse(): void;
  expand(): void;
  toggle(): void;
}

function makeSplit(): SplitLike {
  const s: SplitLike = {
    collapsed: false,
    collapse: () => void (s.collapsed = true),
    expand: () => void (s.collapsed = false),
    toggle: () => void (s.collapsed = !s.collapsed),
  };
  return s;
}

export class Workspace extends Events {
  layoutReady = false;
  activeLeaf: WorkspaceLeaf | null = null;
  leftSplit = makeSplit();
  rightSplit = makeSplit();
  /** The main editor area. */
  rootSplit = makeSplit();
  private registry = new Map<string, { owner: string; creator: ViewCreator }>();
  private leaves = new Set<WorkspaceLeaf>();
  private readyCallbacks: (() => unknown)[] = [];
  /** The one leaf standing for the host's markdown editor; its view follows the active note. */
  private markdownLeaf: WorkspaceLeaf | null = null;
  private syncSeq = 0;
  private emitted: { path: string | null; leaf: WorkspaceLeaf | null } | null = null;

  constructor(
    public app: App,
    public bridge: WorkspaceBridge,
  ) {
    super();
  }

  // -- views

  registerViewFor(owner: string, type: string, creator: ViewCreator): void {
    if (this.registry.has(type))
      throw new Error(`Attempting to register an existing view type "${type}"`);
    this.registry.set(type, { owner, creator });
  }

  /** Public Obsidian name; unowned registration. */
  registerView(type: string, creator: ViewCreator): void {
    this.registerViewFor("", type, creator);
  }

  unregisterView(type: string): void {
    this.registry.delete(type);
  }

  viewCreator(type: string): { owner: string; creator: ViewCreator } | undefined {
    return this.registry.get(type);
  }

  /** Teardown for a plugin: unregisters its view types and detaches leaves showing them. */
  removeOwner(owner: string): void {
    const types = new Set<string>();
    for (const [type, e] of Array.from(this.registry)) {
      if (e.owner !== owner) continue;
      types.add(type);
      this.registry.delete(type);
    }
    for (const leaf of Array.from(this.leaves))
      if (types.has(leaf.view.getViewType())) leaf.detach();
  }

  // -- leaves

  private newLeaf(placement: LeafPlacement, pendingNewTab = false): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this.app, placement);
    leaf.pendingNewTab = pendingNewTab;
    leaf.load();
    this.leaves.add(leaf);
    this.bridge.mountLeaf(leaf, placement);
    this.trigger("layout-change");
    return leaf;
  }

  removeLeaf(leaf: WorkspaceLeaf): void {
    this.leaves.delete(leaf);
    if (this.activeLeaf === leaf) this.activeLeaf = null;
    this.bridge.detachLeaf(leaf);
    leaf.unload();
    this.trigger("layout-change");
  }

  /**
   * `getLeaf()` / `getLeaf(false)` is the leaf of the note being edited (reused by `openFile`);
   * `true`, `"tab"`, `"split"` and `"window"` return a fresh leaf in the main area that becomes a
   * new editor tab (Writer has no splits or extra windows, so split/window are tabs too).
   */
  getLeaf(newLeaf?: NewLeafTarget, _direction?: "vertical" | "horizontal"): WorkspaceLeaf {
    if (!newLeaf) {
      const md = this.markdownLeafForActive();
      if (md) return md;
    }
    return this.newLeaf("main", true);
  }
  getLeftLeaf(_shouldSplit?: boolean): WorkspaceLeaf {
    return this.newLeaf("left");
  }
  getRightLeaf(_shouldSplit?: boolean): WorkspaceLeaf {
    return this.newLeaf("right");
  }
  getMostRecentLeaf(): WorkspaceLeaf | null {
    if (this.activeLeaf?.placement === "main") return this.activeLeaf;
    const md = this.markdownLeafForActive();
    if (md) return md;
    let last: WorkspaceLeaf | null = null;
    for (const l of this.leaves) if (l.placement === "main") last = l;
    return last;
  }
  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.allLeaves().filter((l) => l.view.getViewType() === type);
  }
  detachLeavesOfType(type: string): void {
    for (const l of this.getLeavesOfType(type)) if (l !== this.markdownLeaf) l.detach();
  }
  iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void {
    for (const l of this.allLeaves()) cb(l);
  }

  /** Registered leaves plus the editor leaf while a note is open. */
  private allLeaves(): WorkspaceLeaf[] {
    const md = this.markdownLeafForActive();
    return md ? [...this.leaves, md] : Array.from(this.leaves);
  }

  /**
   * Opens `path` in Writer's main editor on behalf of `leaf`: the editor leaf reuses the current
   * tab, any other leaf opens a new tab. A leaf that showed nothing is dropped afterwards (the
   * note lives in the editor, not in the empty leaf).
   */
  async openFileInLeaf(leaf: WorkspaceLeaf, path: string): Promise<void> {
    const reuse = leaf === this.markdownLeaf && !leaf.pendingNewTab;
    await this.bridge.openFile(path, { newLeaf: !reuse });
    leaf.pendingNewTab = false;
    if (leaf !== this.markdownLeaf && leaf.view instanceof EmptyView) leaf.detach();
  }

  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.bridge.revealLeaf(leaf);
    this.setActiveLeaf(leaf);
  }

  setActiveLeaf(leaf: WorkspaceLeaf, _params?: { focus?: boolean }): void {
    if (this.activeLeaf === leaf) return;
    this.activeLeaf = leaf;
    this.emitted = { path: this.emitted?.path ?? null, leaf };
    this.trigger("active-leaf-change", leaf);
  }

  // -- active file / editor

  getActiveFile(): TFile | null {
    const path = this.bridge.getActiveFilePath();
    return path ? this.app.vault.getFileByPath(path) : null;
  }

  /** An editor that always talks to whichever CodeMirror view is active right now. */
  private liveEditorBackend(): EditorBackend {
    const live = () => this.bridge.getActiveEditor() ?? NO_EDITOR;
    return {
      getValue: () => live().getValue(),
      replaceRange: (from, to, text) => live().replaceRange(from, to, text),
      getSelections: () => live().getSelections(),
      setSelections: (r) => live().setSelections(r),
      focus: () => live().focus(),
      get cm() {
        return live().cm ?? null;
      },
    };
  }

  /** The editor leaf, with its view showing `file`. Null when no note is active. */
  private markdownLeafFor(file: TFile | null): WorkspaceLeaf | null {
    if (!file) return null;
    this.markdownLeaf ??= new WorkspaceLeaf(this.app, "main");
    const leaf = this.markdownLeaf;
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || view.file !== file) {
      const next = new MarkdownView(leaf, this.liveEditorBackend(), file);
      leaf.view = next;
      leaf.containerEl.replaceChildren(next.containerEl);
    }
    return leaf;
  }

  private markdownLeafForActive(): WorkspaceLeaf | null {
    return this.markdownLeafFor(this.getActiveFile());
  }

  private currentMarkdownView(): MarkdownView | null {
    if (!this.bridge.getActiveEditor()) return null;
    const leaf = this.markdownLeafForActive();
    return leaf && leaf.view instanceof MarkdownView ? leaf.view : null;
  }

  /**
   * Called by the host whenever Writer's active document or tab may have changed (the one place
   * that turns navigation into plugin events). Emits at most once per real change:
   * `file-open(file | null)` when the active note changes, `active-leaf-change(leaf | null)` and
   * `layout-change` when the active note or the active plugin tab changes. Safe to call often.
   */
  async syncActiveDocument(): Promise<void> {
    const seq = ++this.syncSeq;
    const path = this.bridge.getActiveFilePath();
    // A note created through Writer may not be in the vault index yet (watcher events are async).
    if (path) await this.app.vault.ensureIndexed(path);
    if (seq !== this.syncSeq) return;
    const file = path ? this.app.vault.getFileByPath(path) : null;
    const pluginLeaf = this.bridge.getActivePluginLeaf();
    const leaf = pluginLeaf ?? this.markdownLeafFor(file);
    const prev = this.emitted;
    this.emitted = { path: file?.path ?? null, leaf };
    if (prev && prev.path === this.emitted.path && prev.leaf === leaf) return;
    this.activeLeaf = leaf;
    if (!prev || prev.path !== this.emitted.path) this.trigger("file-open", file);
    this.trigger("active-leaf-change", leaf);
    this.trigger("layout-change");
  }

  getActiveViewOfType<T extends View>(type: abstract new (...args: any[]) => T): T | null {
    const leafView = this.activeLeaf?.view;
    if (leafView && leafView instanceof type && !(leafView instanceof EmptyView))
      return leafView as T;
    const md = this.currentMarkdownView();
    return md && md instanceof type ? (md as unknown as T) : null;
  }

  /** The editor context commands with editorCallback receive. */
  getEditorContext(): EditorContext | null {
    const md = this.currentMarkdownView();
    return md ? { editor: md.editor, view: md } : null;
  }

  get activeEditor(): { editor: Editor; file: TFile | null } | null {
    const md = this.currentMarkdownView();
    return md ? { editor: md.editor, file: md.file } : null;
  }

  /**
   * Opens the note a link points at in the main editor: a new tab when `newLeaf` is truthy
   * (`true`, `"tab"`, `"split"`, `"window"`), the current tab otherwise. A link to a missing note
   * rejects (Obsidian would create it); a `#heading` suffix is ignored.
   */
  async openLinkText(
    linktext: string,
    sourcePath: string,
    newLeaf?: NewLeafTarget,
    _openState?: unknown,
  ): Promise<void> {
    const hash = linktext.indexOf("#");
    const path = hash < 0 ? linktext : linktext.slice(0, hash);
    const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    if (!file) throw new Error(`Cannot open "${linktext}": no such note`);
    await this.bridge.openFile(file.path, { newLeaf: !!newLeaf });
  }

  getLastOpenFiles(): string[] {
    return [];
  }

  // -- layout

  onLayoutReady(callback: () => unknown): void {
    if (this.layoutReady) {
      this.runReady(callback);
      return;
    }
    this.readyCallbacks.push(callback);
  }

  /** Called by the host once the workspace UI exists. */
  markLayoutReady(): void {
    if (this.layoutReady) return;
    // Obsidian fires `create` for every pre-existing file during initialization, i.e. before layout
    // is ready: listeners registered in onload see them, listeners registered inside
    // onLayoutReady do not.
    this.app.vault.replayInitialCreates();
    this.layoutReady = true;
    const cbs = this.readyCallbacks.splice(0);
    for (const cb of cbs) this.runReady(cb);
    this.trigger("layout-ready");
    // Announce the note that is open right now (later changes come from the host's navigation hook).
    this.syncActiveDocument().catch((e) =>
      console.error("[plugin] initial active-document sync failed:", e),
    );
  }

  private runReady(cb: () => unknown): void {
    try {
      const r = cb();
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<unknown>).catch((e) =>
          console.error("[plugin] onLayoutReady callback rejected:", e),
        );
      }
    } catch (e) {
      console.error("[plugin] onLayoutReady callback threw:", e);
    }
  }

  // Obsidian event names, typed for host callers.
  on(name: "file-open", cb: (file: TFile | null) => unknown, ctx?: unknown): EventRef;
  on(
    name: "active-leaf-change",
    cb: (leaf: WorkspaceLeaf | null) => unknown,
    ctx?: unknown,
  ): EventRef;
  on(
    name: "layout-change" | "layout-ready" | "css-change" | "resize" | "quit",
    cb: () => unknown,
    ctx?: unknown,
  ): EventRef;
  on(
    name: "editor-change",
    cb: (editor: Editor, info: unknown) => unknown,
    ctx?: unknown,
  ): EventRef;
  on(name: string, cb: (...args: any[]) => unknown, ctx?: unknown): EventRef;
  on(name: string, cb: (...args: any[]) => unknown, ctx?: unknown): EventRef {
    return super.on(name, cb, ctx);
  }
}
