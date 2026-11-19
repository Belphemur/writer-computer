// Merging what is on disk into what the canvas holds (ADR 2026-11-18, point 9): an open drawing
// reloads when its file changes (an agent's `excalidraw:add`, sync), and the merge is by element
// id and `version`, Excalidraw's own rule for two copies of one scene: the higher `version`
// wins, a tie goes to the lower `versionNonce`. So the user's selection and view are untouched
// (nothing is replaced wholesale), and an element the user changed since the last save beats an
// older copy from disk.
//
// A third fact makes deletions right: `base`, the id and version of every element at the last
// save. An element the canvas has and the file no longer has was deleted from outside, unless the
// user changed it since that save; an element the canvas has and the base never had is the user's
// unsaved addition and stays.
//
// Pure, so it is tested without a canvas.
import { shortenTextIds, type SceneElement } from "./excalidraw-md";

export type Base = ReadonlyMap<string, number>;

export interface Merge {
  elements: SceneElement[];
  /** Ids on disk that the canvas did not have: what the draw-in animation reveals. */
  added: Set<string>;
  /** Did anything differ from the canvas? */
  changed: boolean;
}

export const baseOf = (elements: readonly SceneElement[]): Base =>
  new Map(elements.map((e) => [e.id, e.version ?? 1]));

/** Does the local copy beat the remote one? Excalidraw's `shouldDiscardRemoteElement`. */
function localWins(local: SceneElement, remote: SceneElement): boolean {
  const lv = local.version ?? 1;
  const rv = remote.version ?? 1;
  return rv < lv || (rv === lv && (remote.versionNonce ?? 0) > (local.versionNonce ?? 0));
}

/** `local` includes deleted elements (the canvas keeps them for undo); `remote` is the file. Both
 *  sides are put through the same text-id shortening first, so a long id the canvas still has
 *  and the short one the file was saved with are the same element. */
export function reconcile(
  localElements: readonly SceneElement[],
  remoteElements: readonly SceneElement[],
  base: Base,
): Merge {
  const local = shortenTextIds(localElements);
  const remote = shortenTextIds(remoteElements);
  const localById = new Map(local.map((e) => [e.id, e]));
  const remoteIds = new Set(remote.map((e) => e.id));
  const added = new Set<string>();
  const out: SceneElement[] = [];
  let changed = false;

  for (const r of remote) {
    const l = localById.get(r.id);
    if (!l) {
      out.push(r);
      added.add(r.id);
      changed = true;
    } else if (localWins(l, r)) {
      out.push(l);
    } else {
      out.push(r);
      if (r !== l && (r.version !== l.version || r.versionNonce !== l.versionNonce)) {
        changed = true;
      }
    }
  }
  // what only the canvas has, in canvas order
  for (const l of local) {
    if (remoteIds.has(l.id)) continue;
    const saved = base.get(l.id);
    const deletedFromOutside = saved !== undefined && (l.version ?? 1) <= saved;
    if (deletedFromOutside) {
      if (l.isDeleted !== true) changed = true;
      out.push({ ...l, isDeleted: true, version: (l.version ?? 1) + 1 });
    } else {
      out.push(l);
    }
  }
  return { elements: out, added, changed };
}
