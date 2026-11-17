// Adapted from opensidian (GPL-3.0-or-later).
// Host-agnostic views and workspace: View/ItemView/FileView/MarkdownView, WorkspaceLeaf,
// Workspace and the Editor facade. They never touch React or a store: everything the host has
// to render or answer goes through the `WorkspaceBridge` interface.
import { Component, Events, type EditorContext, type EventRef } from "./core";
import { createEl } from "./dom";
import { debounce, setIcon } from "./functions";
import { recordPluginError } from "../error-log";
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
  openFile(path: string, opts: { newLeaf: boolean; activate?: boolean }): Promise<void>;
  /** `Workspace.updateOptions()`: re-apply the registered editor extensions to every editor. */
  reapplyEditorOptions(): void;
  /**
   * The leaf's file-bound view asked to become the markdown editor (`setViewState({type:
   * "markdown"})`, "Open as Markdown"): the tab bound to `leaf` shows `path` as text.
   */
  showLeafAsText?(leaf: WorkspaceLeaf, path: string): Promise<void>;
  /**
   * The note editor of the active tab was asked to become a file view of `type`
   * (`markdownLeaf.setViewState({type, state: {file}})`): the active tab shows `path` through the
   * registered view (a file-bound plugin tab).
   */
  showFileAsView?(path: string, type: string): Promise<void>;
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
  reapplyEditorOptions() {},
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
  private following = false;

  getDisplayText(): string {
    return this.file?.basename ?? "";
  }
  canAcceptExtension(_extension: string): boolean {
    return false;
  }
  getState(): Record<string, unknown> {
    return this.file ? { file: this.file.path } : {};
  }
  /** `state.file` names the vault file to show; the base class loads it (public `FileView` contract). */
  async setState(state: unknown, _result?: unknown): Promise<void> {
    const path = (state as { file?: unknown } | null | undefined)?.file;
    if (typeof path !== "string" || !path) {
      if (this.file) await this.unloadFile();
      if (!this.allowNoFile) return;
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`File "${path}" not found`);
    if (this.file === file) return;
    await this.loadFile(file);
  }
  /** Loads `file` into the view: unloads the previous one, then `onLoadFile`. */
  async loadFile(file: TFile): Promise<void> {
    if (this.file) await this.unloadFile();
    this.file = file;
    this.followFile();
    await this.onLoadFile(file);
    this.leaf.updateHeader();
  }
  /** Unloads the current file (`onUnloadFile` flushes pending saves) and forgets it. */
  async unloadFile(): Promise<void> {
    const file = this.file;
    if (!file) return;
    try {
      await this.onUnloadFile(file);
    } finally {
      this.file = null;
    }
  }
  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}
  async onClose(): Promise<void> {
    await this.unloadFile();
  }
  /** The vault renamed the file (the TFile object is updated in place). */
  async onRename(_file: TFile): Promise<void> {
    this.leaf.updateHeader();
  }
  /** Rename and delete of the shown file, for views that did not register their own. */
  private followFile(): void {
    if (this.following) return;
    this.following = true;
    const vault = this.app.vault;
    // Registered on the view, so they go away with it even if a subclass's `onClose` skips super.
    this.registerEvent(
      vault.on("rename", (f: unknown) => {
        if (f === this.file && this.file) void this.onRename(this.file);
      }),
    );
    this.registerEvent(
      vault.on("delete", (f: unknown) => {
        if (f !== this.file) return;
        // A deleted file must not be written back by the flush on close.
        this.file = null;
        this.leaf.detach();
      }),
    );
  }
}

export class EditableFileView extends FileView {}

/** How long `requestSave` waits before writing, like Obsidian. */
export const TEXT_FILE_SAVE_DELAY_MS = 2000;

/**
 * A file view over a text file. The base class reads the file into `data` and calls
 * `setViewData(data, true)`; edits call `requestSave()` (debounced write of `getViewData()`);
 * unloading saves first; a change made outside the view (another editor, the file watcher) is read
 * back through `setViewData(data, false)`. Writes go through `vault.modify`.
 */
export class TextFileView extends EditableFileView {
  data = "";
  /** The text last read from or written to the file; a modify event with this text is our own. */
  lastSavedData: string | null = null;
  requestSave: () => void;
  private followingContent = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    // Resolved at construction through the prototype, so a subclass's `save` is the debounced one.
    const save = debounce(() => {
      this.save().catch((e) => {
        console.error("[plugin] text file view save failed:", e);
        recordPluginError("(view)", "view-save", e);
      });
    }, TEXT_FILE_SAVE_DELAY_MS);
    this.requestSave = () => void save();
    this.cancelRequestedSave = () => save.cancel();
  }
  /** Drops a pending `requestSave` (the save that runs now covers it). */
  private cancelRequestedSave: () => void;

  getViewData(): string {
    return this.data;
  }
  setViewData(data: string, _clear: boolean): void {
    this.data = data;
  }
  clear(): void {
    this.data = "";
  }

  async save(clear = false): Promise<void> {
    this.cancelRequestedSave();
    // Serialized: two saves never write at once, the later one sees the earlier one's result.
    const run = this.saving.catch(() => undefined).then(() => this.writeIfChanged());
    this.saving = run;
    await run;
    if (clear) this.clear();
  }
  private async writeIfChanged(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const data = this.getViewData();
    if (data === this.lastSavedData) return;
    const previous = this.lastSavedData;
    // Set first: the vault's modify event for this very write must read as our own.
    this.lastSavedData = data;
    try {
      await this.app.vault.modify(file, data);
      this.data = data;
    } catch (e) {
      this.lastSavedData = previous;
      throw e;
    }
  }

  async onLoadFile(file: TFile): Promise<void> {
    const data = await this.app.vault.read(file);
    // The file may have changed view while the read was pending.
    if (this.file !== file) return;
    this.data = data;
    this.lastSavedData = data;
    this.setViewData(data, true);
    this.followContent();
  }
  async onUnloadFile(_file: TFile): Promise<void> {
    await this.save();
    this.clear();
  }

  /** Reads back a change made outside the view (the file watcher reports it as a modify). */
  private followContent(): void {
    if (this.followingContent) return;
    this.followingContent = true;
    this.registerEvent(
      this.app.vault.on("modify", (f: unknown) => {
        if (f !== this.file) return;
        void this.reloadFromDisk();
      }),
    );
  }
  private async reloadFromDisk(): Promise<void> {
    const file = this.file;
    if (!file) return;
    await this.saving.catch(() => undefined);
    let data: string;
    try {
      data = await this.app.vault.read(file);
    } catch (e) {
      console.error("[plugin] text file view reload failed:", e);
      return;
    }
    if (this.file !== file || data === this.lastSavedData) return;
    this.lastSavedData = data;
    this.data = data;
    this.setViewData(data, false);
  }
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
  /** Writer's editor owns the note's saving; the facade never writes the file itself. */
  async save(): Promise<void> {}
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

/**
 * The one leaf `resolveFileView` hands to the (possibly plugin-patched) `setViewState` to learn
 * which view type a file would open in, without opening anything: while `probe` is set, a call on
 * `probe.leaf` records the requested type and returns.
 */
let probe: { leaf: WorkspaceLeaf; type: string | null } | null = null;

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
  /**
   * The Writer tab this leaf is the body of, for a main-area leaf showing a file view (a plugin's
   * `registerExtensions` view, or a note turned into one): closing the tab detaches the leaf, and
   * the leaf asking for `markdown` turns the tab into the text editor.
   */
  tabId: string | null = null;
  /** Set when the plugin that registered the view was disabled, so the tab falls back to text. */
  ownerRemoved = false;
  private opening: Promise<void> = Promise.resolve();
  private closedViews = new WeakSet<View>();

  constructor(
    public app: App,
    public placement: LeafPlacement,
  ) {
    super();
    this.view = new EmptyView(this);
    this.view.containerEl.setAttribute("data-type", "empty");
    this.containerEl.appendChild(this.view.containerEl);
  }

  getViewState(): ViewState {
    return { type: this.view.getViewType(), state: this.view.getState() };
  }

  /** Replaces the leaf's view with the registered view for `viewState.type` and opens it. */
  setViewState(viewState: ViewState, eState?: unknown): Promise<void> {
    if (probe && probe.leaf === this) {
      probe.type = viewState.type;
      return Promise.resolve();
    }
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
      const ws = this.app.workspace;
      if (this.tabId !== null && ws.bridge.showLeafAsText) {
        // A file view turning into the note editor ("Open as Markdown"): the view is unloaded
        // first (its pending save lands before the editor reads the file), then the tab shows text.
        await this.closeView();
        this.view = new EmptyView(this);
        this.containerEl.replaceChildren(this.view.containerEl);
        await ws.bridge.showLeafAsText(this, file);
        return;
      }
      await ws.openFileInLeaf(this, file);
      return;
    }
    if (viewState.type === "empty") {
      // Obsidian's built-in empty view: plugins reset a leaf through it before showing another view.
      await this.closeView();
      this.view = new EmptyView(this);
      this.view.containerEl.setAttribute("data-type", "empty");
      this.containerEl.replaceChildren(this.view.containerEl);
      this.app.workspace.bridge.leafChanged(this);
      return;
    }
    const entry = this.app.workspace.viewCreator(viewState.type);
    if (!entry) throw new Error(`Unknown view type "${viewState.type}"`);
    const target = viewState.state?.file;
    if (typeof target === "string" && target && this.app.workspace.isEditorLeaf(this)) {
      // The note editor of the active tab turning into a file view: the tab shows the file through
      // the registered view (this leaf stays the editor's facade).
      const ws = this.app.workspace;
      if (ws.bridge.showFileAsView) {
        await ws.bridge.showFileAsView(target, viewState.type);
        return;
      }
    }
    const next = entry.creator(this) as View;
    // Plugin stylesheets key on the view type (`.workspace-leaf-content[data-type="..."]`).
    next.containerEl.setAttribute("data-type", next.getViewType());
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
    if (this.closedViews.has(v)) return; // closed by an earlier step (e.g. "Open as Markdown")
    this.closedViews.add(v);
    try {
      await v.onClose();
      // A view whose onClose skipped `super.onClose()` still flushes and releases its file.
      if (v instanceof FileView && v.file) await v.unloadFile();
    } catch (e) {
      console.error("[plugin] view onClose threw:", e);
      recordPluginError("(view)", "view-close", e);
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
  async openFile(file: TFile, openState?: { active?: boolean }): Promise<void> {
    await this.app.workspace.openFileInLeaf(this, file.path, openState?.active !== false);
  }
  /** Leaf identity of Obsidian's tab header (no tab strip of Obsidian's exists here). */
  tabHeaderEl = createEl("div", { cls: "workspace-tab-header" });
  tabHeaderInnerTitleEl = createEl("div", { cls: "workspace-tab-header-inner-title" });
  tabHeaderInnerIconEl = createEl("div", { cls: "workspace-tab-header-inner-icon" });
  /** Whether the leaf's view is on screen: a main-area view when its tab is active. */
  isVisible(): boolean {
    return !this.detached && (this.tabId === null || this.app.workspace.activeLeaf === this);
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

export interface ViewRegistry {
  /** Extension (lower case, no dot) -> view type of every `registerExtensions` call. */
  readonly typeByExtension: Record<string, string>;
  getTypeByExtension(extension: string): string | undefined;
  isExtensionRegistered(extension: string): boolean;
}

/** The registry over the plugins' recorded `fileExtensions` registrations (gone with the plugin). */
export function createViewRegistry(
  registrations: () => readonly { kind: string; key: string; value: unknown }[],
): ViewRegistry {
  const registry: ViewRegistry = {
    get typeByExtension() {
      const out: Record<string, string> = {};
      for (const r of registrations())
        if (r.kind === "fileExtensions") out[r.key.toLowerCase()] = String(r.value);
      return out;
    },
    getTypeByExtension: (extension) => registry.typeByExtension[extension.toLowerCase()],
    isExtensionRegistered: (extension) => registry.getTypeByExtension(extension) !== undefined,
  };
  return registry;
}

export type ViewCreator = (leaf: WorkspaceLeaf) => View;

/** The method as shipped, to tell whether a plugin patched `WorkspaceLeaf.prototype.setViewState`. */
let ORIGINAL_SET_VIEW_STATE: WorkspaceLeaf["setViewState"];

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
  /** The workspace root element; Writer's real layout is React, so this stays detached. */
  get containerEl(): HTMLElement {
    return (this.rootEl ??= createEl("div", { cls: "workspace" }));
  }
  private rootEl: HTMLElement | null = null;
  leftSplit = makeSplit();
  rightSplit = makeSplit();
  /** The main editor area. */
  rootSplit = makeSplit();
  leftRibbon = { hiddenItems: {} as Record<string, boolean>, items: [] as unknown[] };
  rightRibbon = { hiddenItems: {} as Record<string, boolean>, items: [] as unknown[] };
  private registry = new Map<string, { owner: string; creator: ViewCreator }>();
  private leaves = new Set<WorkspaceLeaf>();
  private readyCallbacks: (() => unknown)[] = [];
  /** The one leaf standing for the host's markdown editor; its view follows the active note. */
  private markdownLeaf: WorkspaceLeaf | null = null;
  private syncSeq = 0;
  private probeLeaf: WorkspaceLeaf | null = null;
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
      if (types.has(leaf.view.getViewType())) {
        leaf.ownerRemoved = true;
        leaf.detach();
      }
  }

  /**
   * Closes the views of `owner`'s types and waits for them: a view flushes its pending save in
   * `onClose`, which needs its plugin still loaded, so this runs BEFORE the plugin unloads.
   * Bounded, so a view that hangs cannot stall disabling its plugin.
   */
  async closeViewsOf(owner: string, timeoutMs = 5000): Promise<void> {
    const types = new Set<string>();
    for (const [type, e] of this.registry) if (e.owner === owner) types.add(type);
    const closing = [...this.leaves].filter((l) => types.has(l.view.getViewType()));
    for (const leaf of closing) {
      leaf.ownerRemoved = true;
      leaf.detach();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.all(closing.map((l) => l.settled())), timeout]);
    clearTimeout(timer);
  }

  // -- file views (`registerExtensions`, notes a plugin shows in its own view)

  /**
   * The view type that opens `path`, or null when the text editor does. A registered extension
   * (`registerExtensions(["excalidraw"], "excalidraw")`) opens in its view. A note (`.md`) asks the
   * plugins: they redirect a note by patching `WorkspaceLeaf.prototype.setViewState` (Excalidraw
   * turns a `markdown` request for a drawing note into its own view), so a probe leaf makes the
   * same request and reads which type the (patched) call would open, without opening anything.
   * Synchronous, so the page-kind registry can route a path.
   */
  resolveFileView(path: string): string | null {
    const dot = path.lastIndexOf(".");
    const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
    if (ext !== "md") {
      const type = this.app.viewRegistry.getTypeByExtension(ext);
      return type && this.registry.has(type) ? type : null;
    }
    if (WorkspaceLeaf.prototype.setViewState === ORIGINAL_SET_VIEW_STATE) return null;
    if (!this.app.vault.getFileByPath(path)) return null;
    const leaf = this.probeLeaf ?? (this.probeLeaf = new WorkspaceLeaf(this.app, "main"));
    leaf.id = "probe-leaf";
    probe = { leaf, type: null };
    try {
      // The patched method is what a plugin made of it; a throw means "not mine".
      void leaf.setViewState({ type: "markdown", state: { file: path } }).catch(() => undefined);
      const type = probe.type;
      return type && type !== "markdown" && this.registry.has(type) ? type : null;
    } catch {
      return null;
    } finally {
      probe = null;
    }
  }

  /**
   * Opens `path` in a new main-area leaf bound to the Writer tab `tabId`, through the registered
   * view `type` (the body of a file-bound plugin tab). Rejects with the view's error.
   */
  async openFileView(path: string, type: string, tabId: string): Promise<WorkspaceLeaf> {
    const leaf = this.newLeaf("main");
    leaf.tabId = tabId;
    try {
      await leaf.setViewState({ type, state: { file: path } });
    } catch (e) {
      leaf.detach();
      throw e;
    }
    return leaf;
  }

  /** Is `leaf` the facade of the note editor of the active tab? */
  isEditorLeaf(leaf: WorkspaceLeaf): boolean {
    return leaf === this.markdownLeaf;
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
      // The active tab shows a file view: that leaf is the one a plugin means by "the current one".
      const active = this.activeLeaf;
      if (active && active.tabId !== null && !active.detached) return active;
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
  /** A leaf for a new view: Writer has no pinning, so any fresh main-area leaf is "unpinned". */
  getUnpinnedLeaf(): WorkspaceLeaf {
    return this.getLeaf(true);
  }
  getLeafById(id: string): WorkspaceLeaf | null {
    return this.allLeaves().find((l) => l.id === id) ?? null;
  }
  getGroupLeaves(_group: string): WorkspaceLeaf[] {
    return [];
  }
  iterateRootLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void {
    for (const l of this.allLeaves()) if (l.placement === "main") cb(l);
  }
  /** Writer has no persisted layout tree: an empty layout, and saving it is a no-op. */
  getLayout(): Record<string, unknown> {
    return {};
  }
  requestSaveLayout(): void {}
  async changeLayout(_workspace: unknown): Promise<void> {}
  splitActiveLeaf(_direction?: "vertical" | "horizontal"): WorkspaceLeaf {
    return this.getLeaf("split");
  }
  createLeafBySplit(_leaf: WorkspaceLeaf, _direction?: "vertical" | "horizontal"): WorkspaceLeaf {
    return this.getLeaf("split");
  }
  createLeafInParent(_parent: unknown, _index?: number): WorkspaceLeaf {
    return this.getLeaf("tab");
  }
  duplicateLeaf(leaf: WorkspaceLeaf): Promise<WorkspaceLeaf> {
    return Promise.resolve(leaf);
  }
  openPopoutLeaf(): WorkspaceLeaf {
    return this.getLeaf("window");
  }
  moveLeafToPopout(leaf: WorkspaceLeaf): WorkspaceLeaf {
    return leaf;
  }
  /** The side-dock leaf for `type`: the existing one, or a new right-pane leaf showing it. */
  async ensureSideLeaf(
    type: string,
    _side: "left" | "right",
    options?: { active?: boolean; reveal?: boolean; split?: boolean; state?: unknown },
  ): Promise<WorkspaceLeaf> {
    let leaf = this.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = this.getRightLeaf(false);
      await leaf.setViewState({ type, active: options?.active, state: options?.state } as never);
    }
    if (options?.reveal !== false) await this.revealLeaf(leaf);
    return leaf;
  }
  handleLinkContextMenu(_menu: unknown, _linktext: string, _sourcePath: string): void {}
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
  async openFileInLeaf(leaf: WorkspaceLeaf, path: string, activate = true): Promise<void> {
    const reuse = (leaf === this.markdownLeaf && !leaf.pendingNewTab) || leaf.tabId !== null;
    await this.bridge.openFile(path, { newLeaf: !reuse, ...(activate ? {} : { activate: false }) });
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
    // A file view (a drawing) in the active tab is the active leaf: there is no note editor then.
    if (this.bridge.getActivePluginLeaf()) return null;
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

  /** The active leaf's view when it shows a file (a note editor or a plugin's file view). */
  getActiveFileView(): FileView | null {
    const v = this.activeLeaf?.view;
    if (v instanceof FileView) return v;
    return this.currentMarkdownView();
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
   * Opens the note a link points at in the main editor: a new tab (in the background when `openState.active` is false) when `newLeaf` is truthy
   * (`true`, `"tab"`, `"split"`, `"window"`), the current tab otherwise. A link to a missing note
   * rejects (Obsidian would create it); a `#heading` suffix is ignored.
   */
  async openLinkText(
    linktext: string,
    sourcePath: string,
    newLeaf?: NewLeafTarget,
    openState?: { active?: boolean },
  ): Promise<void> {
    const hash = linktext.indexOf("#");
    const path = hash < 0 ? linktext : linktext.slice(0, hash);
    const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    if (!file) throw new Error(`Cannot open "${linktext}": no such note`);
    await this.bridge.openFile(file.path, {
      newLeaf: !!newLeaf,
      ...(openState?.active === false ? { activate: false } : {}),
    });
  }

  getLastOpenFiles(): string[] {
    return [];
  }

  // -- layout

  /**
   * Public `Workspace.updateOptions()` ("update the internal settings of the editors"; Dataview
   * calls it after changing its editor-affecting settings). Writer has no per-editor option
   * model beyond the plugin extension compartment, so this re-applies it to every editor.
   */
  updateOptions(): void {
    this.bridge.reapplyEditorOptions();
  }

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

ORIGINAL_SET_VIEW_STATE = WorkspaceLeaf.prototype.setViewState;
