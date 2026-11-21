// A change a sync wrote into a note that is open in an editor (spec `SPECs/git-sync-spec.md`
// "Cadence" > Sync). Rust announces the files before it writes them (`git:applying`); the editor
// store's watcher path asks `claim` (core's `external-changes` registry) instead of reloading, and
// the change is applied only after the same typing idle as lint's fixes (`TYPING_IDLE_MS`), as ONE
// editor transaction: one undo step (`userEvent: "git.sync"`), the caret and the selection mapped
// through it, never a reload under the user's hands. Text typed since the file was last saved is
// merged with the remote's by the engine's merge (`git_merge_text`); only the properties and the
// body that differ are touched.
import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { serializeDocument } from "@/lib/frontmatter";
import { parseOpenedFile } from "@/lib/open-file-parse";
import { isTypingIdle } from "@/lib/typing-idle";

/** The user event of the apply transaction: tests and other extensions can tell it apart. */
export const APPLY_EVENT = "git.sync";

/** How long a path stays claimed after Rust announced it (the watcher may report it late and twice). */
export const CLAIM_TTL_MS = 60_000;
/** How often the pending notes are checked for the typing idle. */
export const TICK_MS = 500;

interface OpenNote {
  frontmatter: string | null;
  content: string;
  diskContent: string;
  isDirty: boolean;
}

/** What the apply needs from the editor store and Rust; the real ones are in `index.ts`. */
export interface ApplyDeps {
  getOpenFile(path: string): OpenNote | null | undefined;
  readFile(path: string): Promise<string>;
  mergeText(path: string, base: string, mine: string, theirs: string): Promise<string | null>;
  findView(path: string): EditorView | null;
  updateFrontmatter(path: string, frontmatter: string | null): void;
  updateContent(path: string, content: string): void;
  markSaved(path: string, diskContent: string, hasNewerChanges: boolean): void;
  cancelSave(path: string): void;
}

/** The smallest single replacement that turns `from` into `to`, `null` when they are equal. */
export function minimalChange(
  from: string,
  to: string,
): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from[start] === to[start]) start++;
  let endFrom = from.length;
  let endTo = to.length;
  while (endFrom > start && endTo > start && from[endFrom - 1] === to[endTo - 1]) {
    endFrom--;
    endTo--;
  }
  return { from: start, to: endFrom, insert: to.slice(start, endTo) };
}

export type Outcome = "applied" | "kept" | "none";

/** Takes the version of `path` now on disk into its open editor. */
export async function applyRemoteChange(path: string, deps: ApplyDeps): Promise<Outcome> {
  if (!deps.getOpenFile(path)) return "none";
  const theirs = await deps.readFile(path);
  const file = deps.getOpenFile(path);
  if (!file || theirs === file.diskContent) return "none";
  const mine = serializeDocument(file.frontmatter, file.content);
  let next = theirs;
  if (file.isDirty && mine !== file.diskContent) {
    const merged = await deps.mergeText(path, file.diskContent, mine, theirs);
    const again = deps.getOpenFile(path);
    if (!again || serializeDocument(again.frontmatter, again.content) !== mine) return "none";
    if (merged === null) {
      // the two sides overlap: what the user has stays (their next save wins, the merge view of a
      // later phase settles it); the editor now knows the disk holds the remote's version
      deps.markSaved(path, theirs, true);
      return "kept";
    }
    next = merged;
  }
  const parsed = parseOpenedFile(path, next);
  if (parsed.frontmatter !== file.frontmatter) deps.updateFrontmatter(path, parsed.frontmatter);
  const view = deps.findView(path);
  const body = parsed.body ?? "";
  if (view) {
    const change = minimalChange(view.state.doc.toString(), body);
    if (change) {
      view.dispatch({
        changes: change,
        userEvent: APPLY_EVENT,
        annotations: isolateHistory.of("full"),
      });
    }
  } else if (body !== file.content) {
    deps.updateContent(path, body);
  }
  deps.markSaved(path, theirs, next !== theirs);
  if (next === theirs) deps.cancelSave(path);
  return "applied";
}

export interface Applier {
  /** Rust is about to write these vault-relative files. */
  announce(relativePaths: readonly string[]): void;
  /** The watcher's claim: true while the path was announced and the change is held for the idle. */
  claim(path: string, kind: string): boolean;
  /** One pass of the idle check (the ticker's job; a test calls it). */
  tick(): void;
  /** Notes waiting for the user to stop typing. */
  pending(): string[];
}

export interface ApplierOptions {
  root: () => string | null;
  deps: ApplyDeps;
  /** Starts `tick` on an interval, returns the stop function (`ctx.setInterval`). */
  every: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  onError?: (e: unknown) => void;
}

export function createApplier(opts: ApplierOptions): Applier {
  const now = opts.now ?? Date.now;
  const claimed = new Map<string, number>();
  const waiting = new Set<string>();
  const busy = new Set<string>();
  let stop: (() => void) | null = null;

  const absolute = (rel: string) => {
    const root = opts.root();
    return root ? `${root.replace(/\/+$/, "")}/${rel}` : null;
  };

  const tick = () => {
    for (const path of waiting) {
      if (busy.has(path) || !isTypingIdle(path, now())) continue;
      waiting.delete(path);
      busy.add(path);
      applyRemoteChange(path, opts.deps)
        .catch((e) => opts.onError?.(e))
        .finally(() => busy.delete(path));
    }
    if (waiting.size === 0 && busy.size === 0 && stop) {
      stop();
      stop = null;
    }
  };

  return {
    announce(paths) {
      const until = now() + CLAIM_TTL_MS;
      for (const rel of paths) {
        const abs = absolute(rel);
        if (abs) claimed.set(abs, until);
      }
    },
    claim(path) {
      const until = claimed.get(path);
      if (until === undefined) return false;
      if (until < now()) {
        claimed.delete(path);
        return false;
      }
      waiting.add(path);
      stop ??= opts.every(tick, TICK_MS);
      return true;
    },
    tick,
    pending: () => [...waiting],
  };
}
