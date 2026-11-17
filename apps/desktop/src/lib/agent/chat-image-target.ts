/**
 * The one place a drop that is not a text drop learns whether the agent composer is under the
 * pointer. The composer registers itself while mounted; the sidebar's pointer drag (vault images)
 * and the OS drop listener (Finder files) ask it by screen position. A drop elsewhere is not
 * handled here (the editor's own image drop is separate).
 */
import type { ChatImageSource } from "./chat-images";

export type ChatImageTarget = {
  /** Is the screen point (CSS pixels) over the composer? */
  contains(x: number, y: number): boolean;
  attach(sources: readonly ChatImageSource[]): void;
};

let target: ChatImageTarget | null = null;

/** Registers the mounted composer; returns the unregister function. */
export function registerChatImageTarget(t: ChatImageTarget): () => void {
  target = t;
  return () => {
    if (target === t) target = null;
  };
}

export const isOverChatComposer = (x: number, y: number): boolean =>
  target?.contains(x, y) ?? false;

/** Attaches `sources` when the composer is under the point; false when it is not. */
export function dropOnChatComposer(
  x: number,
  y: number,
  sources: readonly ChatImageSource[],
): boolean {
  if (!target?.contains(x, y)) return false;
  target.attach(sources);
  return true;
}
