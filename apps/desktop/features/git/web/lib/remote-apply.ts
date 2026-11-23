// A change a sync wrote into a note that is open in an editor (spec `SPECs/git-sync-spec.md`
// "Cadence" > Sync). Rust announces the files before it writes them (`git:applying`, `done:
// false`): from then on the note's saves are HELD (`holdSaves`), so no autosave overwrites what the
// sync writes before the editor took it in. Once Rust is done (`done: true`, the files it wrote)
// the written notes wait for the same typing idle as lint's fixes (`TYPING_IDLE_MS`) and the change
// is applied as ONE editor transaction: one undo step (`userEvent: "git.sync"`), the caret and the
// selection mapped through it, never a reload under the user's hands; the others are released at
// once. The watcher's path asks `claim` (core's `external-changes` registry) instead of reloading.
// Text typed since the file was last saved is merged with the remote's by the engine's merge
// (`git_merge_text`); when the two overlap, the conflict is recorded in Rust with the buffer
// written as the user's version (`git_conflict_record`), so the note bar shows and no automatic
// commit takes the user's text over the other device's. The hold is released after the apply.
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
  /** Holds the note's saves until the returned release is called (`lib/save.ts`). */
  holdSaves(path: string): () => void;
  /** Waits for a save of the note already in flight. */
  waitForSave(path: string): Promise<void>;
  /** Records an overlap with the buffer as a conflict, `mine` written as the user's version. */
  recordConflict(path: string, base: string, mine: string): Promise<void>;
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

/** `retry`: the user typed while the merge ran; the apply goes again at the next idle. */
export type Outcome = "applied" | "kept" | "none" | "retry";

/** Takes the version of `path` now on disk into its open editor. */
export async function applyRemoteChange(path: string, deps: ApplyDeps): Promise<Outcome> {
  if (!deps.getOpenFile(path)) return "none";
  // a save that started before the hold lands first: the disk read below is the last word
  await deps.waitForSave(path);
  const theirs = await deps.readFile(path);
  const file = deps.getOpenFile(path);
  if (!file || theirs === file.diskContent) return "none";
  const mine = serializeDocument(file.frontmatter, file.content);
  let next = theirs;
  if (file.isDirty && mine !== file.diskContent) {
    const merged = await deps.mergeText(path, file.diskContent, mine, theirs);
    const again = deps.getOpenFile(path);
    if (!again) return "none";
    if (serializeDocument(again.frontmatter, again.content) !== mine) return "retry";
    if (merged === null) {
      // the two sides overlap: what the user has stays, recorded as a conflict (Rust writes the
      // buffer as the user's version), so nothing commits it over the other device's
      await deps.recordConflict(path, file.diskContent, mine);
      const latest = deps.getOpenFile(path);
      const now = latest ? serializeDocument(latest.frontmatter, latest.content) : mine;
      deps.markSaved(path, mine, now !== mine);
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
  /** Rust is about to write these vault-relative files: their saves are held. */
  announce(relativePaths: readonly string[]): void;
  /** Rust is done and wrote these: they are applied at the idle, the other announced ones freed. */
  done(relativePaths: readonly string[]): void;
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
  const held = new Map<string, () => void>();
  const waiting = new Set<string>();
  const busy = new Set<string>();
  let stop: (() => void) | null = null;

  const absolute = (rel: string) => {
    const root = opts.root();
    return root ? `${root.replace(/\/+$/, "")}/${rel}` : null;
  };

  const release = (path: string) => {
    held.get(path)?.();
    held.delete(path);
  };

  const start = () => {
    stop ??= opts.every(tick, TICK_MS);
  };

  const tick = () => {
    for (const path of waiting) {
      if (busy.has(path) || !isTypingIdle(path, now())) continue;
      waiting.delete(path);
      busy.add(path);
      applyRemoteChange(path, opts.deps)
        .then((outcome) => {
          if (outcome === "retry") waiting.add(path);
        })
        .catch((e) => opts.onError?.(e))
        .finally(() => {
          busy.delete(path);
          if (!waiting.has(path)) release(path);
        });
    }
    // a hold whose claim ran out (Rust never said it was done) is freed
    for (const path of held.keys()) {
      const until = claimed.get(path);
      if (!waiting.has(path) && !busy.has(path) && (until === undefined || until < now())) {
        release(path);
      }
    }
    if (waiting.size === 0 && busy.size === 0 && held.size === 0 && stop) {
      stop();
      stop = null;
    }
  };

  return {
    announce(paths) {
      const until = now() + CLAIM_TTL_MS;
      for (const rel of paths) {
        const abs = absolute(rel);
        if (!abs) continue;
        claimed.set(abs, until);
        if (!held.has(abs)) held.set(abs, opts.deps.holdSaves(abs));
      }
      if (paths.length > 0) start();
    },
    done(paths) {
      const written = new Set(paths.map(absolute).filter((p): p is string => p !== null));
      for (const abs of held.keys()) {
        if (written.has(abs)) {
          waiting.add(abs);
        } else if (!waiting.has(abs) && !busy.has(abs)) {
          claimed.delete(abs);
          release(abs);
        }
      }
      for (const abs of written) if (claimed.has(abs)) waiting.add(abs);
      if (waiting.size > 0) start();
    },
    claim(path) {
      const until = claimed.get(path);
      if (until === undefined) return false;
      if (until < now()) {
        claimed.delete(path);
        return false;
      }
      waiting.add(path);
      start();
      return true;
    },
    tick,
    pending: () => [...waiting],
  };
}
