/**
 * The one place a drop that is not a text drop learns whether the agent composer is under the
 * pointer. The composer registers itself while mounted; the OS drop listener (Finder files) asks it
 * by screen position here, the sidebar's pointer drag (vault images) through core's
 * `lib/vault-drop-target.ts`. A drop elsewhere is not
 * handled here (the editor's own image drop is separate).
 */
import { registerVaultDropTarget } from "@/lib/vault-drop-target";
import type { ChatFileSource } from "./chat-files";

export type ChatImageTarget = {
  /** Is the screen point (CSS pixels) over the composer? */
  contains(x: number, y: number): boolean;
  attach(sources: readonly ChatFileSource[]): void;
};

let target: ChatImageTarget | null = null;

/** Registers the mounted composer (here, for the OS drop, and in core's `vault-drop-target` for
 *  the sidebar's pointer drag); returns the unregister function. */
export function registerChatImageTarget(t: ChatImageTarget): () => void {
  target = t;
  const unregisterVault = registerVaultDropTarget({
    contains: t.contains,
    attachVaultFiles: (paths) => t.attach(paths.map((path) => ({ kind: "vault" as const, path }))),
  });
  return () => {
    if (target === t) target = null;
    unregisterVault();
  };
}

export const isOverChatComposer = (x: number, y: number): boolean =>
  target?.contains(x, y) ?? false;

/** Attaches `sources` when the composer is under the point; false when it is not. */
export function dropOnChatComposer(
  x: number,
  y: number,
  sources: readonly ChatFileSource[],
): boolean {
  if (!target?.contains(x, y)) return false;
  target.attach(sources);
  return true;
}
