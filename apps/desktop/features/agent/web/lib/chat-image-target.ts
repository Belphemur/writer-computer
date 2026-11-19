/**
 * The one place the agent composer takes a drop that is not a text drop. The composer registers
 * itself while mounted, and it is reached two ways: Finder files through the OS drop dispatcher
 * (`lib/os-drop`, which owns the coordinates and the hit test), and the sidebar's pointer drag
 * (vault files and folders) through core's `lib/vault-drop-target.ts`. Both end in `attach`.
 */
import { registerOsDropTarget } from "@/lib/os-drop";
import { registerVaultDropTarget } from "@/lib/vault-drop-target";
import type { ChatFileSource } from "./chat-files";

export type ChatImageTarget = {
  /** Is the screen point (CSS pixels) over the composer? */
  contains(x: number, y: number): boolean;
  attach(sources: readonly ChatFileSource[]): void;
  /** A Finder drag with files is over the composer (the drop highlight). */
  setOver(over: boolean): void;
};

/** Registers the mounted composer as an OS drop target and a vault drop target; returns the
 *  unregister function. */
export function registerChatImageTarget(t: ChatImageTarget): () => void {
  const offVault = registerVaultDropTarget({
    contains: t.contains,
    attachVaultFiles: (entries) =>
      t.attach(entries.map((e) => ({ kind: "vault" as const, path: e.path, isDir: e.isDir }))),
  });
  const offOs = registerOsDropTarget({
    contains: ({ x, y }) => t.contains(x, y),
    hover: (point, paths) => t.setOver(point !== null && paths.length > 0),
    drop: (_point, paths) => {
      t.setOver(false);
      t.attach(paths.map((path) => ({ kind: "path" as const, path })));
    },
  });
  return () => {
    offVault();
    offOs();
  };
}
