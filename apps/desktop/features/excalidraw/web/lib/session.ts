// One open drawing: what a tab keeps between the canvas and the file (ADR 2026-11-18, points 5
// and 9). The canvas reports changes; the session saves them after a quiet moment through the
// codec (one write path), reloads the file when it changes from outside and merges it into the
// canvas by id and version (`reconcile.ts`), revealing what is new with a short draw-in
// (`draw-in.ts`). Plain code over an injected canvas API and injected IO, so all of it is tested
// without Excalidraw.
import { describeError } from "@/lib/logger";
import type { ExcalidrawApi } from "./excalidraw-lib";
import type { Loaded, Saved, Snapshot } from "./drawing-file";
import type { ParsedDrawing, SceneElement } from "./excalidraw-md";
import { planDrawIn, runDrawIn, type DrawInRun } from "./draw-in";
import { baseOf, reconcile, type Base } from "./reconcile";
import { shortenTextIds } from "./excalidraw-md";

export const SAVE_DEBOUNCE_MS = 600;

export interface SessionDeps {
  /** The file's text now. */
  read: () => Promise<string>;
  /** Parse a text and resolve its images. */
  load: (text: string) => Promise<Loaded>;
  save: (baseline: ParsedDrawing, snapshot: Snapshot) => Promise<Saved>;
  /** The canvas applies elements without recording an undo step. */
  neverCapture: unknown;
  reducedMotion: () => boolean;
  /** A save reached the disk. */
  onSaved?: () => void;
  onProblem: (message: string) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
  raf?: (cb: (now: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
}

/** What makes two canvases the same drawing for the file: the live elements by id and version,
 *  the background and the grid. Selection, zoom and scroll are not part of it. */
export function signature(
  elements: readonly SceneElement[],
  appState: Record<string, unknown>,
): string {
  const live = elements
    .filter((e) => e.isDeleted !== true)
    .map((e) => `${e.id}@${e.version ?? 1}.${e.versionNonce ?? 0}`);
  return `${live.join(",")}|${JSON.stringify(appState.viewBackgroundColor ?? "")}|${JSON.stringify(appState.gridSize ?? "")}`;
}

export class DrawingSession {
  private api: ExcalidrawApi | null = null;
  private baseline: ParsedDrawing | null = null;
  private base: Base = new Map();
  private savedSignature = "";
  private latest: Snapshot | null = null;
  private dirty = false;
  private animating: DrawInRun | null = null;
  private saving: Promise<void> | null = null;
  private cancelTimer: (() => void) | null = null;
  private disposed = false;

  constructor(
    readonly path: string,
    private readonly deps: SessionDeps,
  ) {}

  /** First read: the baseline every later save and reload is measured against. */
  async open(): Promise<Loaded> {
    const loaded = await this.deps.load(await this.deps.read());
    this.adopt(loaded.parsed);
    return loaded;
  }

  attach(api: ExcalidrawApi): void {
    this.api = api;
  }

  private adopt(parsed: ParsedDrawing): void {
    this.baseline = parsed;
    this.base = baseOf(shortenTextIds(parsed.scene.elements.filter((e) => e.isDeleted !== true)));
    this.savedSignature = signature(parsed.scene.elements, parsed.scene.appState);
  }

  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  /** The canvas changed (or only its selection or scroll did: the signature tells). */
  handleChange(
    elements: readonly SceneElement[],
    appState: Record<string, unknown>,
    files: Snapshot["files"],
  ): void {
    if (this.disposed || this.animating || !this.baseline) return;
    this.latest = { elements, appState, files };
    const changed = signature(elements, appState) !== this.savedSignature;
    if (changed === this.dirty && !changed) return;
    this.dirty = changed;
    if (changed) this.arm();
  }

  private arm(): void {
    this.cancelTimer?.();
    const schedule =
      this.deps.schedule ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
    this.cancelTimer = schedule(() => {
      this.cancelTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Write the canvas to the file now. Concurrent calls share one write. */
  save(): Promise<void> {
    if (this.saving) return this.saving;
    this.saving = this.write().finally(() => {
      this.saving = null;
      // changes that arrived while writing get their own save
      if (this.dirty && !this.disposed) this.arm();
    });
    return this.saving;
  }

  private async write(): Promise<void> {
    const snapshot = this.latest;
    const baseline = this.baseline;
    if (!this.dirty || !snapshot || !baseline) return;
    try {
      const saved = await this.deps.save(baseline, snapshot);
      const sig = signature(snapshot.elements, snapshot.appState);
      this.baseline = saved.parsed;
      this.base = baseOf(shortenTextIds(snapshot.elements.filter((e) => e.isDeleted !== true)));
      this.savedSignature = sig;
      this.dirty =
        this.latest !== null && signature(this.latest.elements, this.latest.appState) !== sig;
      if (saved.wrote) this.deps.onSaved?.();
    } catch (e) {
      this.deps.onProblem(`Could not save the drawing: ${describeError(e).message}`);
    }
  }

  /** Save what is pending and wait for it. */
  async flush(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.saving) await this.saving;
    if (this.dirty) await this.save();
  }

  /** The file changed on disk from outside: merge it into the canvas. */
  async reload(): Promise<void> {
    const api = this.api;
    if (!api || this.disposed || !this.baseline) return;
    let loaded: Loaded;
    try {
      const text = await this.deps.read();
      if (text === this.baseline.text) return; // our own write, or a change that is already in
      loaded = await this.deps.load(text);
    } catch (e) {
      this.deps.onProblem(`Could not reload the drawing: ${describeError(e).message}`);
      return;
    }
    if (this.disposed) return;
    const merge = reconcile(
      api.getSceneElementsIncludingDeleted(),
      loaded.parsed.scene.elements,
      this.base,
    );
    this.adopt(loaded.parsed);
    const known = api.getFiles();
    const fresh = Object.values(loaded.files).filter((f) => !known[f.id]);
    if (fresh.length > 0) api.addFiles(fresh);
    if (!merge.changed) return;

    this.animating?.finish();
    const show = (els: readonly SceneElement[]) =>
      api.updateScene({ elements: els, captureUpdate: this.deps.neverCapture });
    let settled = false;
    const settle = () => {
      settled = true;
      this.animating = null;
      // The canvas now holds the merge. It differs from the file only where the user's own
      // unsaved edits won, and then it is saved.
      const elements = api.getSceneElementsIncludingDeleted();
      this.handleChange(elements, api.getAppState(), api.getFiles());
    };
    const run = runDrawIn(
      merge.elements,
      planDrawIn(merge.added, this.deps.reducedMotion()),
      { show, raf: this.deps.raf, caf: this.deps.caf, now: this.deps.now },
      settle,
    );
    // with nothing to animate it has already settled
    if (!settled) this.animating = run;
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.animating?.finish();
    // a tab closed with edits pending still saves them
    const pending = this.dirty && this.latest && this.baseline ? this.write() : null;
    this.disposed = true;
    void pending;
  }
}
