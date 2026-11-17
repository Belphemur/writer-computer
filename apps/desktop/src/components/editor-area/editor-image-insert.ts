import {
  type EditorState,
  Facet,
  type Extension,
  StateEffect,
  StateField,
  type Range,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import {
  embedLine,
  extensionForMime,
  isGenericClipboardName,
  isImportableImageName,
  MAX_ATTACHMENT_BYTES,
  imageUrlsFromTransfer,
  MAX_ATTACHMENT_MB,
  markdownImage,
  pastedImageName,
  pastedImageStem,
  vaultRelative,
} from "@/lib/attachments";
import { logger } from "@/lib/logger";
import { getFileName, getParentDir } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import { dismissEditorNotice, showEditorNotice, useEditorNoticeStore } from "./editor-notice-store";

/**
 * Inserting images into a note (spec: SPECs/image-insertion-spec.md): paste, drops from the
 * browser (HTML5), Finder (Tauri's OS drop, routed here by `use-os-image-drop`) and a vault
 * image dragged from the sidebar (pointer drag, routed by `use-tree-drag`). Every source ends in
 * `insertImages`: save (one Rust write path) or link, then ONE transaction inserting
 * `![[target]]` per image, so one undo step undoes the whole insertion.
 */

/** Where an image comes from. */
export type ImageSource =
  /** Bytes from the clipboard or a browser drag: saved to the attachment folder. */
  | { kind: "file"; file: File }
  /** A file on disk (Finder drop): copied to the attachment folder by path. */
  | { kind: "path"; path: string }
  /** An image already in the vault (sidebar drag): linked, never copied. */
  | { kind: "vault"; path: string }
  /** An image a browser drag or paste carried only as a link: downloaded in Rust, else linked. */
  | { kind: "url"; url: string };

export interface ImageInsertHost {
  getFilePath: () => string;
  isDisposed: () => boolean;
}

/** Marks an editor view as one images can be inserted into, and who owns it. */
const hostFacet = Facet.define<ImageInsertHost, ImageInsertHost | null>({
  combine: (values) => values[0] ?? null,
});

const SAVING_MESSAGE = "Saving image…";
/** Show the saving notice only when a save takes longer than this. */
const SAVING_DELAY_MS = 200;

// ---- Insertion points that follow the document while an image is saving --------------------

interface Point {
  id: number;
  pos: number;
}
const addPoint = StateEffect.define<Point>();
const removePoint = StateEffect.define<number>();

const pointsField = StateField.define<Point[]>({
  create: () => [],
  update(points, tr) {
    let next = points;
    if (tr.docChanged) {
      next = next.map((p) => ({ id: p.id, pos: tr.changes.mapPos(p.pos, -1) }));
    }
    for (const effect of tr.effects) {
      if (effect.is(addPoint)) next = [...next, effect.value];
      else if (effect.is(removePoint)) next = next.filter((p) => p.id !== effect.value);
    }
    return next;
  },
});

function pointPos(state: EditorState, id: number): number | null {
  return state.field(pointsField).find((p) => p.id === id)?.pos ?? null;
}

// ---- Drop caret for drags that never fire HTML5 events (Finder, sidebar) --------------------

const setDropCaret = StateEffect.define<number | null>();

class DropCaretWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-image-drop-caret";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  eq() {
    return true;
  }
  ignoreEvent() {
    return true;
  }
}

const dropCaretField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDropCaret)) {
        if (effect.value === null) return Decoration.none;
        const range: Range<Decoration> = Decoration.widget({
          widget: new DropCaretWidget(),
          side: 1,
        }).range(effect.value);
        return Decoration.set([range]);
      }
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const dropCaretTheme = EditorView.baseTheme({
  ".cm-image-drop-caret": {
    display: "inline-block",
    width: "0",
    height: "1.2em",
    marginLeft: "-1px",
    marginRight: "-1px",
    borderLeft: "2px solid var(--accent)",
    verticalAlign: "text-bottom",
    pointerEvents: "none",
  },
});

// ---- Saving ----------------------------------------------------------------------------------

function sizeMessage(bytes: number): string {
  return `Image not saved: ${(bytes / (1024 * 1024)).toFixed(1)} MB is over the ${MAX_ATTACHMENT_MB} MB limit`;
}

/** A refusal the user should read as is (thrown before or by the save). */
class Refusal extends Error {}

/** The name a blob is saved under: its own name when it has one, else Obsidian's pasted name. */
function nameForFile(file: File): string {
  if (!isGenericClipboardName(file.name) && isImportableImageName(file.name)) return file.name;
  const ext =
    extensionForMime(file.type) ??
    (isImportableImageName(file.name) ? file.name.split(".").pop() : null);
  if (!ext)
    throw new Refusal(`Not saved: "${file.name || "pasted item"}" is not a supported image type`);
  return pastedImageName(ext.toLowerCase());
}

/** The vault-relative (or note-relative when standalone) path of the image a source resolves to. */
async function resolveSource(
  source: Exclude<ImageSource, { kind: "url" }>,
  notePath: string,
  root: string | null,
): Promise<string> {
  if (source.kind === "vault") return root ? vaultRelative(source.path, root) : source.path;
  if (source.kind === "path") {
    if (!isImportableImageName(getFileName(source.path))) {
      throw new Refusal(`Not saved: "${getFileName(source.path)}" is not a supported image type`);
    }
    return (await tauri.importAttachmentFile(notePath, source.path)).relative_path;
  }
  const name = nameForFile(source.file);
  if (source.file.size > MAX_ATTACHMENT_BYTES) throw new Refusal(sizeMessage(source.file.size));
  const bytes = new Uint8Array(await source.file.arrayBuffer());
  return (await tauri.saveAttachment(notePath, name, bytes)).relative_path;
}

/** The line to insert for one source: a wikilink embed of the saved or linked file; for a URL
 *  source that cannot be downloaded, a plain `![](url)` and a notice saying why. */
async function lineFor(
  source: ImageSource,
  notePath: string,
  root: string | null,
  noteDirRel: string | null,
): Promise<string> {
  if (source.kind !== "url") {
    return embedLine(await resolveSource(source, notePath, root), noteDirRel);
  }
  try {
    const saved = await tauri.importAttachmentUrl(notePath, source.url, pastedImageStem());
    return embedLine(saved.relative_path, noteDirRel);
  } catch (error) {
    // The address is never logged.
    logger.warn("app", "image download failed");
    const reason = typeof error === "string" ? error : "Image not downloaded: something went wrong";
    showEditorNotice(`${reason}. Inserted a link to the address instead.`);
    return markdownImage(new URL(source.url).href);
  }
}

function reportFailure(error: unknown) {
  if (error instanceof Refusal) {
    showEditorNotice(error.message);
    return;
  }
  // Rust refusals (type, size) are plain strings already written for the user.
  const message = typeof error === "string" ? error : "something went wrong";
  logger.warn("app", "image attachment failed");
  showEditorNotice(
    message.startsWith("Image not saved") || message.startsWith("Not saved")
      ? message
      : `Image not saved: ${message}`,
  );
}

let nextPointId = 1;

/**
 * Save or link `sources` and insert one `![[target]]` per image, one per line, at `pos` (default
 * the caret), as a single undo step. The insertion point follows edits made while saving. A
 * source that fails is reported and skipped; the rest still insert.
 */
export async function insertImages(
  view: EditorView,
  sources: readonly ImageSource[],
  pos?: number,
): Promise<void> {
  const host = view.state.facet(hostFacet);
  if (!host || sources.length === 0) return;
  const notePath = host.getFilePath();
  const root = getWorkspaceRoot();
  const noteDirRel = root ? vaultRelative(getParentDir(notePath), root) : null;

  const id = nextPointId++;
  view.dispatch({
    effects: [
      addPoint.of({ id, pos: pos ?? view.state.selection.main.head }),
      setDropCaret.of(null),
    ],
  });
  const timer = window.setTimeout(() => showEditorNotice(SAVING_MESSAGE), SAVING_DELAY_MS);
  const lines: string[] = [];
  try {
    for (const source of sources) {
      try {
        lines.push(await lineFor(source, notePath, root, noteDirRel));
      } catch (error) {
        reportFailure(error);
      }
    }
  } finally {
    window.clearTimeout(timer);
    if (useEditorNoticeStore.getState().message === SAVING_MESSAGE) dismissEditorNotice();
  }
  if (host.isDisposed()) return;

  const at = pointPos(view.state, id);
  view.dispatch({ effects: removePoint.of(id) });
  if (at === null || lines.length === 0) return;
  const insert = lines.join("\n");
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    scrollIntoView: true,
    userEvent: "input.drop",
  });
}

// ---- Entry points ----------------------------------------------------------------------------

/** The image files among `files` (what a paste or an HTML5 drop carries). */
export function imageFilesOf(files: Iterable<File>): ImageSource[] {
  const sources: ImageSource[] = [];
  for (const file of files) {
    if (extensionForMime(file.type) !== null || isImportableImageName(file.name)) {
      sources.push({ kind: "file", file });
    }
  }
  return sources;
}

/** Every image a paste or drag carries: files, image items, else links to remote images. */
export function imageSourcesOfTransfer(data: DataTransfer): ImageSource[] {
  const fromFiles = imageFilesOf(Array.from(data.files));
  if (fromFiles.length > 0) return fromFiles;
  const fromItems: File[] = [];
  for (const item of data.items) {
    const file = item.kind === "file" && item.type.startsWith("image/") ? item.getAsFile() : null;
    if (file) fromItems.push(file);
  }
  const fromItemFiles = imageFilesOf(fromItems);
  if (fromItemFiles.length > 0) return fromItemFiles;
  return imageUrlsFromTransfer(data.getData("text/html"), data.getData("text/uri-list")).map(
    (url): ImageSource => ({ kind: "url", url }),
  );
}

/** The image files among tree entries, as link-only sources (a sidebar drag copies nothing). */
export function vaultImageSources(
  entries: readonly { path: string; is_dir: boolean }[],
): ImageSource[] {
  return entries
    .filter((entry) => !entry.is_dir && isImportableImageName(getFileName(entry.path)))
    .map((entry) => ({ kind: "vault", path: entry.path }));
}

function dropPosition(view: EditorView, x: number, y: number): number {
  return view.posAtCoords({ x, y }, false);
}

const htmlDropHandlers = EditorView.domEventHandlers({
  drop(event, view) {
    const sources = event.dataTransfer ? imageSourcesOfTransfer(event.dataTransfer) : [];
    if (sources.length === 0) return false;
    event.preventDefault();
    void insertImages(view, sources, dropPosition(view, event.clientX, event.clientY));
    return true;
  },
});

/** Makes an editor view an image-insert target: HTML5 drops (browser), the insertion-point
 *  tracking and the drop caret used by the Finder and sidebar drags. */
export function imageInsertExtension(
  getFilePath: () => string,
  isDisposed: () => boolean,
): Extension {
  return [
    hostFacet.of({ getFilePath, isDisposed }),
    pointsField,
    dropCaretField,
    dropCaretTheme,
    htmlDropHandlers,
  ];
}

/** The insert-target editor under a screen point, if any. */
function targetViewAt(x: number, y: number): EditorView | null {
  const dom = document.elementFromPoint(x, y)?.closest<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  return view?.state.facet(hostFacet) ? view : null;
}

let previewed: EditorView | null = null;

/** Show the drop caret in the editor under the pointer (and nowhere else). */
export function previewImageDropAt(x: number, y: number): void {
  const view = targetViewAt(x, y);
  if (previewed && previewed !== view) previewed.dispatch({ effects: setDropCaret.of(null) });
  previewed = view;
  view?.dispatch({ effects: setDropCaret.of(dropPosition(view, x, y)) });
}

export function clearImageDropPreview(): void {
  previewed?.dispatch({ effects: setDropCaret.of(null) });
  previewed = null;
}

/** Insert `sources` at a screen point. False when no insert-target editor is there. */
export function dropImagesAt(x: number, y: number, sources: readonly ImageSource[]): boolean {
  const view = targetViewAt(x, y);
  clearImageDropPreview();
  if (!view) return false;
  void insertImages(view, sources, dropPosition(view, x, y));
  return true;
}

/** Whether an insert-target editor is under a screen point. */
export function isOverImageTarget(x: number, y: number): boolean {
  return targetViewAt(x, y) !== null;
}
