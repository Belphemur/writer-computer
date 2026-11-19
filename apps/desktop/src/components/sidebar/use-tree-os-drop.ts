import { useEffect, useRef, type RefObject } from "react";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { registerOsDropTarget } from "@/lib/os-drop";
import * as tauri from "@/lib/tauri";
import type { DropOutcome } from "@/lib/tauri";
import { getFileName } from "@/lib/paths";
import type { DirEntry } from "@/types/fs";
import type { MoveOutcome } from "./use-move-entry";
import { folderAtPoint } from "./tree-move";

/** What dropping Finder items on the tree needs from the app, injected so it is testable. */
export type TreeDropDeps = {
  rootPath: string;
  dropImport: (destDir: string, sources: string[]) => Promise<DropOutcome[]>;
  moveEntry: (entry: DirEntry, destDir: string) => Promise<MoveOutcome>;
  refreshDirectory: (path: string) => Promise<unknown> | void;
  select: (paths: string[]) => void;
  notify: (message: string) => void;
};

const joinVault = (root: string, rel: string) => `${root}/${rel}`;

/** A tree entry for a vault path the tree may not have loaded (a move needs only its name, path
 *  and kind). */
const entryOf = (path: string, isDir: boolean): DirEntry => ({
  name: getFileName(path),
  path,
  is_dir: isDir,
  is_markdown: /\.md$/i.test(path),
  modified_at: 0,
  created_at: 0,
  title: null,
});

/**
 * Finder items dropped on the folder `destDir` of the tree (spec `SPECs/os-drop-spec.md`): items
 * from outside the vault are copied in by Rust (folders recursively, secret names skipped, the
 * shared caps), items already in the vault are moved there through the one move path (links
 * rewritten, never copied). The new items end up selected; refusals are notices.
 */
export async function importDropped(
  destDir: string,
  paths: readonly string[],
  deps: TreeDropDeps,
): Promise<void> {
  const { rootPath, dropImport, moveEntry, refreshDirectory, select, notify } = deps;
  let outcomes: DropOutcome[];
  try {
    outcomes = await dropImport(destDir, [...paths]);
  } catch (e) {
    notify(`Not added: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const selected: string[] = [];
  const notices: string[] = [];
  let skipped = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "copied") {
      selected.push(joinVault(rootPath, outcome.path));
      skipped += outcome.skipped;
    } else if (outcome.kind === "inVault") {
      const entry = entryOf(joinVault(rootPath, outcome.path), outcome.isDir);
      const moved = await moveEntry(entry, destDir);
      if (moved.status === "moved") selected.push(moved.newPath);
      else if (moved.status === "skipped") selected.push(entry.path);
      else if (moved.status === "exists") notices.push(`${entry.name} already exists there`);
      else notices.push(`${entry.name} could not be moved`);
    } else {
      notices.push(
        outcome.message.startsWith(outcome.name)
          ? outcome.message
          : `${outcome.name}: ${outcome.message}`,
      );
    }
  }
  if (skipped > 0) notices.push(`Skipped ${skipped} secret-looking file${skipped > 1 ? "s" : ""}`);
  await refreshDirectory(destDir);
  if (selected.length > 0) select(selected);
  if (notices.length > 0) notify(`Not added: ${notices.join("; ")}`);
}

type Args = {
  containerRef: RefObject<HTMLDivElement | null>;
  rootPath: string;
  entryByPath: Map<string, DirEntry>;
  moveEntry: TreeDropDeps["moveEntry"];
  refreshDirectory: TreeDropDeps["refreshDirectory"];
  select: TreeDropDeps["select"];
  /** The folder row to highlight while a Finder drag is over the tree (null: none). */
  setHighlightDir: (dir: string | null) => void;
};

/** Registers the file tree as an OS drop target: the folder row under the pointer is highlighted,
 *  a drop imports into it (a file row means its folder, empty space the vault root). */
export function useTreeOsDrop(args: Args): void {
  const latest = useRef(args);
  latest.current = args;
  useEffect(
    () =>
      registerOsDropTarget({
        contains: ({ x, y }) => {
          const r = latest.current.containerRef.current?.getBoundingClientRect();
          return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        },
        hover: (point, paths) => {
          const a = latest.current;
          const container = a.containerRef.current;
          a.setHighlightDir(
            point && paths.length > 0 && container
              ? folderAtPoint(container, a.entryByPath, a.rootPath, point.x, point.y)
              : null,
          );
        },
        drop: (point, paths) => {
          const a = latest.current;
          const container = a.containerRef.current;
          a.setHighlightDir(null);
          const dest = container
            ? folderAtPoint(container, a.entryByPath, a.rootPath, point.x, point.y)
            : null;
          if (dest === null) return;
          void importDropped(dest, paths, {
            rootPath: a.rootPath,
            dropImport: tauri.dropImport,
            moveEntry: a.moveEntry,
            refreshDirectory: a.refreshDirectory,
            select: a.select,
            notify: showEditorNotice,
          });
        },
      }),
    [],
  );
}
