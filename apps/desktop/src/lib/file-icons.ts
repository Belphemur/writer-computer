// The icon of a file or folder (spec `SPECs/icons-spec.md`): the one core place every surface asks.
// The sidebar tree, the tabs, the note title, links and the inline shortcodes all call
// `useFileIcon(path)` (or `useLinkIcon` for a link's target); nothing else holds or looks up an
// icon. The data comes from the built-in feature `icons`, which resolves it in Rust (Writer's
// `.writer/icons.json` over Iconize's read-only data) and is the only writer of this store
// (`setFileIcons`, cleared when the feature goes off), so with the feature off every hook answers
// `undefined` and core draws what it always drew. Core imports no feature.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { getRelativePath } from "@/lib/paths";
import { parseWikiLink } from "@/lib/wiki-links";
import * as tauri from "@/lib/tauri";
import { useWorkspaceStore } from "@/stores/workspace-store";

/** An icon as drawn: `icon` is `emoji:<emoji>` or `icon:<Hugeicons name>`. */
export interface FileIconEntry {
  icon: string;
  /** `#rrggbb`. */
  color?: string;
}

interface FileIconState {
  /** Vault-relative path (forward slashes) to its icon: files and folders. */
  icons: ReadonlyMap<string, FileIconEntry>;
  set: (icons: ReadonlyMap<string, FileIconEntry>) => void;
}

export const useFileIconStore = create<FileIconState>((set) => ({
  icons: new Map(),
  set: (icons) => set({ icons }),
}));

/** The feature's one write: replace every icon. */
export function setFileIcons(rows: readonly (FileIconEntry & { path: string })[]): void {
  useFileIconStore
    .getState()
    .set(
      new Map(
        rows.map(({ path, icon, color }): [string, FileIconEntry] => [
          path,
          color ? { icon, color } : { icon },
        ]),
      ),
    );
}

/** Forget every icon (the feature went off, or the workspace closed). */
export function clearFileIcons(): void {
  useFileIconStore.getState().set(new Map());
}

const relativeTo = (path: string, root: string | null) =>
  root ? getRelativePath(path, root) : path.replace(/\\/g, "/");

/** The icon of a file or folder (an absolute path or a vault-relative one), or `undefined`. */
export function useFileIcon(path: string | null | undefined): FileIconEntry | undefined {
  const root = useWorkspaceStore((s) => s.root);
  return useFileIconStore((s) => (path ? s.icons.get(relativeTo(path, root)) : undefined));
}

/** [`useFileIcon`] outside React. */
export function fileIconOf(path: string | null | undefined): FileIconEntry | undefined {
  return path
    ? useFileIconStore.getState().icons.get(relativeTo(path, getWorkspaceRoot()))
    : undefined;
}

const RESOLVE_TTL_MS = 5_000;
const resolved = new Map<string, { at: number; path: Promise<string | null> }>();

/** The absolute path a link target (`Note`, `Folder/Note#Heading|Alias`) written in `sourcePath`
 *  points to, by the vault resolver (file name, never title); `null` for none (or a link to a
 *  heading of the same note). Cached for a few seconds, so many links cost one call each. */
export function resolveLinkPath(
  target: string,
  sourcePath: string | null | undefined,
): Promise<string | null> {
  const name = parseWikiLink(target).path;
  if (!name) return Promise.resolve(null);
  const key = `${sourcePath ?? ""}\0${name}`;
  const hit = resolved.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.path;
  const path = tauri.resolveWikiLinkTarget(name, sourcePath ?? null).catch(() => null);
  resolved.set(key, { at: Date.now(), path });
  return path;
}

const hasIcons = () => useFileIconStore.getState().icons.size > 0;

/** The icon of the note a link points to. No lookup at all while no icon exists. */
export function useLinkIcon(
  target: string | null | undefined,
  sourcePath?: string | null,
): FileIconEntry | undefined {
  const any = useFileIconStore((s) => s.icons.size > 0);
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    if (!any || !target) {
      setPath(null);
      return;
    }
    let live = true;
    void resolveLinkPath(target, sourcePath).then((p) => live && setPath(p));
    return () => {
      live = false;
    };
  }, [any, target, sourcePath]);
  return useFileIcon(path);
}

/** [`useLinkIcon`] for a DOM element (a CodeMirror widget): calls `draw` with the icon now and
 *  whenever the icons change, until the returned function is called. */
export function watchLinkIcon(
  target: string,
  sourcePath: string | null | undefined,
  draw: (entry: FileIconEntry | undefined) => void,
): () => void {
  let live = true;
  const update = () => {
    if (!hasIcons()) return draw(undefined);
    void resolveLinkPath(target, sourcePath).then((p) => live && draw(fileIconOf(p)));
  };
  const unsubscribe = useFileIconStore.subscribe(update);
  update();
  return () => {
    live = false;
    unsubscribe();
  };
}

/** Test seam. */
export function resetFileIconsForTests(): void {
  clearFileIcons();
  resolved.clear();
}
