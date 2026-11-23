import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { detectPlatform, type Platform } from "@/lib/platform";

/**
 * Files dragged from the OS (Finder): the one subscription to Tauri's drag-drop events and the
 * one place that turns their position into a CSS point and picks the target under it (spec
 * `SPECs/os-drop-spec.md`). While the window's drag-drop is on, the webview gets no HTML5 events
 * for such files, so every drop target registers here instead of listening itself: the open note
 * (core), the sidebar tree (core) and the agent composer (a feature, through this registry).
 *
 * The position: Tauri types it as physical pixels, but only Windows reports them. macOS (wry's
 * `draggingLocation`, view points) and Linux (GTK widget coordinates) report CSS pixels already, so
 * dividing by `devicePixelRatio` there halves the point on a Retina screen and every hit test
 * misses what is under the pointer (the broken composer drop). Linux's GTK reports widget
 * coordinates, which WebKitGTK scales with the screen (the widget is in logical pixels, whatever the
 * integer or fractional scale), so they are CSS pixels too; that is the one claim only a real
 * session checks (spec `SPECs/os-drop-spec.md` "Verify on Linux").
 */
export type DropPoint = { x: number; y: number };

export type OsDropTarget = {
  /** Does the target take a drop at this CSS point? */
  contains(point: DropPoint): boolean;
  /** The drag is over the target (`point`), or left it (`null`): the highlight. */
  hover(point: DropPoint | null, paths: readonly string[]): void;
  /** Absolute paths released over the target. */
  drop(point: DropPoint, paths: readonly string[]): void;
};

const targets = new Set<OsDropTarget>();

/** Registers a mounted target; returns the unregister function. */
export function registerOsDropTarget(target: OsDropTarget): () => void {
  targets.add(target);
  return () => void targets.delete(target);
}

/** The unit of the position Tauri reports, per platform: the one table the conversion reads. */
const POSITION_UNIT = {
  macos: "css",
  windows: "physical",
  linux: "css",
} as const satisfies Record<Platform, "css" | "physical">;

/** A Tauri drop position as a CSS point. */
export function dropPoint(
  position: { x: number; y: number },
  platform: Platform = detectPlatform(),
  pixelRatio?: number,
): DropPoint {
  const scale =
    POSITION_UNIT[platform] === "physical" ? pixelRatio || window.devicePixelRatio || 1 : 1;
  return { x: position.x / scale, y: position.y / scale };
}

const targetAt = (point: DropPoint): OsDropTarget | null => {
  for (const target of targets) if (target.contains(point)) return target;
  return null;
};

/** The handler of Tauri's drag-drop events; it remembers across a gesture which target was last
 *  hovered, so a target is told when the drag leaves it. */
export function createOsDropHandler(platform?: Platform, pixelRatio?: () => number) {
  let paths: readonly string[] = [];
  let hovered: OsDropTarget | null = null;
  const clear = () => {
    hovered?.hover(null, []);
    hovered = null;
  };
  return (event: DragDropEvent) => {
    if (event.type === "leave") {
      paths = [];
      clear();
      return;
    }
    if (event.type === "enter") paths = event.paths;
    const point = dropPoint(event.position, platform, pixelRatio?.());
    const target = targetAt(point);
    if (event.type !== "drop") {
      if (target !== hovered) clear();
      hovered = target;
      target?.hover(point, paths);
      return;
    }
    clear();
    const dropped = event.paths.length > 0 ? event.paths : paths;
    paths = [];
    if (dropped.length > 0) target?.drop(point, dropped);
  };
}

/** Mount once (the editor area): subscribes to Tauri's OS drag-drop and dispatches to the targets. */
export function useOsDrop(): void {
  useEffect(() => {
    const handle = createOsDropHandler();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // `getCurrentWebview()` throws without a webview; inside a promise that is the same ignored
    // rejection as a failed listen.
    Promise.resolve()
      .then(() => getCurrentWebview())
      .then((webview) => webview.onDragDropEvent((event) => handle(event.payload)))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // No webview (tests, the browser playground): nothing to route.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
