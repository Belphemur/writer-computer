// Markdown processors plugins register (`registerMarkdownCodeBlockProcessor`,
// `registerMarkdownPostProcessor`, Dataview's priority variants) and the machinery that runs them:
// the processor context (`MarkdownPostProcessorContext`), a mount (one rendered block with its
// own `Component` lifetime) and a small pool that keeps unmounted blocks alive for a moment so
// scrolling or entering/leaving edit mode does not re-run an expensive query.
//
// The editor (features/obsidian-host/web/plugin-markdown-decorations.ts) and the HTML renderer
// (api/markdown-render.ts) are the two consumers; both read the registry through the one
// `MarkdownProcessorHost` the PluginHost installs, so nothing here depends on a particular app.
import { logger } from "@/lib/logger";
import { parseFrontmatter } from "@/lib/frontmatter";
import { parse as yamlParse } from "yaml";
import { Component, type HostServices } from "./api/core";
import { recordPluginError } from "./error-log";

export type CodeBlockHandler = (source: string, el: HTMLElement, ctx: unknown) => unknown;
export type PostProcessorFn = (el: HTMLElement, ctx: unknown) => unknown;

export interface CodeBlockProcessor {
  owner: string;
  language: string;
  fn: CodeBlockHandler;
}
export interface PostProcessor {
  owner: string;
  fn: PostProcessorFn;
}

export interface MarkdownProcessorHost {
  services: HostServices;
  app: unknown;
  /** Vault-relative path of an absolute note path, or null outside the vault. */
  toVaultPath(absPath: string): string | null;
  /** Cached frontmatter of a vault note (for `ctx.frontmatter`). */
  getFrontmatter(vaultPath: string): Record<string, unknown> | undefined;
}

let host: MarkdownProcessorHost | null = null;
let unwatch: (() => void) | null = null;
let signature = "";
const listeners = new Set<() => void>();

/** What the registry currently holds, as a string that changes when a processor appears/goes. */
function currentSignature(): string {
  if (!host) return "";
  const parts: string[] = [];
  for (const r of host.services.registrations.list()) {
    if (r.kind === "codeBlockProcessor" || r.kind === "postProcessor")
      parts.push(`${r.owner}|${r.kind}|${r.key}|${fnId((r.value as { fn: unknown }).fn)}`);
  }
  return parts.join("\n");
}

const ids = new WeakMap<object, number>();
let idSeq = 0;
function fnId(fn: unknown): number {
  if (typeof fn !== "function") return 0;
  let id = ids.get(fn);
  if (id === undefined) ids.set(fn, (id = ++idSeq));
  return id;
}

/** Installed by the PluginHost (and cleared with `null` on shutdown). */
export function setMarkdownProcessorHost(next: MarkdownProcessorHost | null): void {
  unwatch?.();
  unwatch = null;
  host = next;
  signature = currentSignature();
  if (next) {
    unwatch = next.services.registrations.subscribe(() => {
      const now = currentSignature();
      if (now === signature) return;
      signature = now;
      registryChanged();
    });
  }
  registryChanged();
}

export function getMarkdownProcessorHost(): MarkdownProcessorHost | null {
  return host;
}

/** Called after the registered processors changed (plugin enabled/disabled, host swapped). */
export function subscribeMarkdownProcessors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function registryChanged(): void {
  inlineClaims.clear();
  pool.disposeWhere((m) => !isRegistered(m.fn));
  for (const l of Array.from(listeners)) {
    try {
      l();
    } catch (e) {
      console.error("[plugin] markdown processor listener threw:", e);
    }
  }
}

// ---------------------------------------------------------------- lookups

/** Registered handlers carry `sortOrder` as a property (Dataview sets it after registering). */
function orderOf(fn: unknown, fallback: number | undefined): number {
  const own = (fn as { sortOrder?: unknown } | null)?.sortOrder;
  return typeof own === "number" ? own : (fallback ?? 0);
}

/** The info string's language: its first word (` ```dataviewjs title="x" ` -> `dataviewjs`). */
export function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0] ?? "";
}

/** The processor that renders a fenced block of `language`; the lowest sort order wins. */
export function findCodeBlockProcessor(language: string): CodeBlockProcessor | null {
  if (!host || !language) return null;
  const lower = language.toLowerCase();
  let best: { p: CodeBlockProcessor; order: number } | null = null;
  for (const r of host.services.registrations.list()) {
    if (r.kind !== "codeBlockProcessor") continue;
    if (r.key !== language && r.key.toLowerCase() !== lower) continue;
    const value = r.value as { fn: CodeBlockHandler; sortOrder?: number };
    if (typeof value.fn !== "function") continue;
    const order = orderOf(value.fn, value.sortOrder);
    if (!best || order < best.order)
      best = { p: { owner: r.owner, language: r.key, fn: value.fn }, order };
  }
  return best?.p ?? null;
}

/** True while `fn` is still a registered processor (a disabled plugin's block is dropped). */
export function isRegistered(fn: unknown): boolean {
  if (!host) return false;
  for (const r of host.services.registrations.list()) {
    if (r.kind !== "codeBlockProcessor" && r.kind !== "postProcessor") continue;
    if ((r.value as { fn: unknown }).fn === fn) return true;
  }
  return false;
}

export function hasPostProcessors(): boolean {
  if (!host) return false;
  return host.services.registrations.list().some((r) => r.kind === "postProcessor");
}

/** Post processors in run order (sort order, then registration order). */
export function listPostProcessors(): PostProcessor[] {
  if (!host) return [];
  const rows: { p: PostProcessor; order: number; i: number }[] = [];
  let i = 0;
  for (const r of host.services.registrations.list()) {
    if (r.kind !== "postProcessor") continue;
    const value = r.value as { fn: PostProcessorFn; sortOrder?: number };
    if (typeof value.fn !== "function") continue;
    rows.push({
      p: { owner: r.owner, fn: value.fn },
      order: orderOf(value.fn, value.sortOrder),
      i: i++,
    });
  }
  rows.sort((a, b) => a.order - b.order || a.i - b.i);
  return rows.map((r) => r.p);
}

// ---------------------------------------------------------------- context

export interface SectionInfo {
  text: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * `MarkdownPostProcessorContext`. It is a `Component` so `addChild`, `register`, `registerEvent`
 * and `registerInterval` behave (Dataview passes the context where a component is expected);
 * unloading it unloads every child the processor attached.
 */
export class ProcessorContext extends Component {
  docId: string;
  frontmatter: Record<string, unknown> | undefined;
  /** Where `getSectionInfo` looks: set by whoever knows the document (the editor widget). */
  sectionResolver: ((el: HTMLElement) => SectionInfo | null) | null = null;

  constructor(
    public sourcePath: string,
    public containerEl: HTMLElement,
  ) {
    super();
    this.docId = sourcePath;
    this.frontmatter = host?.getFrontmatter(sourcePath);
  }

  /** How many children processors attached: a processor that added one acted on this content. */
  attached = 0;

  override addChild<T extends Component>(child: T): T {
    this.attached++;
    return super.addChild(child);
  }

  getSectionInfo(el: HTMLElement): SectionInfo | null {
    try {
      return this.sectionResolver?.(el) ?? null;
    } catch (e) {
      console.error("[plugin] getSectionInfo threw:", e);
      return null;
    }
  }
}

// ---------------------------------------------------------------- mounts

export interface Mount {
  /** The element handed to the processor; append it to the document. */
  el: HTMLElement;
  ctx: ProcessorContext;
  /** The registered function behind it (identity decides whether the mount is still valid). */
  fn: unknown;
  /** Settles when the processor finished (never rejects). */
  ready: Promise<void>;
  dispose(): void;
}

const errorBox = (doc: Document, owner: string, what: string, e: unknown): HTMLElement => {
  const box = doc.createElement("div");
  box.className = "writer-plugin-block-error";
  box.setAttribute("role", "alert");
  const title = doc.createElement("strong");
  title.textContent = `${owner}: ${what} failed`;
  const message = doc.createElement("pre");
  message.textContent = e instanceof Error ? e.message : String(e);
  box.append(title, message);
  return box;
};

/** Runs a code block processor into a fresh element. Errors become an inline box. */
export function mountCodeBlock(
  proc: CodeBlockProcessor,
  source: string,
  sourcePath: string,
  resolver: ProcessorContext["sectionResolver"],
): Mount {
  const el = document.createElement("div");
  el.className = `block-language-${proc.language.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const ctx = new ProcessorContext(sourcePath, el);
  ctx.sectionResolver = resolver;
  ctx.load();
  const fail = (e: unknown): void => {
    console.error(`[plugin] ${proc.owner} code block "${proc.language}" failed:`, e);
    recordPluginError(proc.owner, `codeblock:${proc.language}`, e);
    el.replaceChildren(errorBox(document, proc.owner, `code block "${proc.language}"`, e));
  };
  let disposed = false;
  const ready = (async () => {
    try {
      await proc.fn(source, el, ctx);
    } catch (e) {
      if (!disposed) fail(e);
    }
  })();
  return {
    el,
    ctx,
    fn: proc.fn,
    ready,
    dispose() {
      disposed = true;
      try {
        ctx.unload();
      } catch (e) {
        console.error("[plugin] code block unload threw:", e);
      }
      el.replaceChildren();
    },
  };
}

/** Runs every post processor over `el` in order; one failing does not stop the rest. */
export async function runPostProcessors(
  el: HTMLElement,
  ctx: ProcessorContext,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  for (const pp of listPostProcessors()) {
    if (!isCurrent()) return;
    try {
      await pp.fn(el, ctx);
    } catch (e) {
      console.error(`[plugin] ${pp.owner} post processor failed:`, e);
      recordPluginError(pp.owner, "post-processor", e);
    }
  }
}

// ---------------------------------------------------------------- pool

const POOL_TTL_MS = 60_000;
const POOL_MAX = 40;

class MountPool {
  private parked = new Map<string, { mount: Mount; timer: ReturnType<typeof setTimeout> }>();

  /** Takes a parked mount out of the pool (it is the caller's until released again). */
  acquire(key: string): Mount | null {
    const hit = this.parked.get(key);
    if (!hit) return null;
    clearTimeout(hit.timer);
    this.parked.delete(key);
    if (!isRegistered(hit.mount.fn)) {
      hit.mount.dispose();
      return null;
    }
    return hit.mount;
  }

  release(key: string, mount: Mount): void {
    if (!isRegistered(mount.fn) || this.parked.has(key)) {
      mount.dispose();
      return;
    }
    const timer = setTimeout(() => {
      if (this.parked.get(key)?.mount === mount) this.parked.delete(key);
      mount.dispose();
    }, POOL_TTL_MS);
    this.parked.set(key, { mount, timer });
    while (this.parked.size > POOL_MAX) {
      const oldest = this.parked.keys().next().value as string;
      this.evict(oldest);
    }
  }

  private evict(key: string): void {
    const hit = this.parked.get(key);
    if (!hit) return;
    clearTimeout(hit.timer);
    this.parked.delete(key);
    hit.mount.dispose();
  }

  disposeWhere(pred: (m: Mount) => boolean): void {
    for (const [key, { mount }] of Array.from(this.parked)) if (pred(mount)) this.evict(key);
  }

  clear(): void {
    for (const key of Array.from(this.parked.keys())) this.evict(key);
  }

  get size(): number {
    return this.parked.size;
  }
}

export const pool = new MountPool();

// ---------------------------------------------------------------- inline queries

const inlineClaims = new Map<string, boolean>();
const inlinePending = new Set<string>();
const INLINE_CLAIMS_MAX = 2000;

export const inlineKey = (sourcePath: string, text: string): string => `${sourcePath}\0${text}`;

/** `true`/`false` once probed, `undefined` while unknown. */
export function inlineClaim(key: string): boolean | undefined {
  return inlineClaims.get(key);
}

/** Renders `` `text` `` the way reading view would: `<p><code>text</code></p>` through every post processor. */
export function mountInline(
  text: string,
  sourcePath: string,
): { mount: Mount; claimed: Promise<boolean> } {
  const p = document.createElement("p");
  const code = document.createElement("code");
  code.textContent = text;
  p.append(code);
  const el = document.createElement("span");
  el.className = "writer-plugin-inline markdown-rendered";
  el.append(p);
  const ctx = new ProcessorContext(sourcePath, el);
  ctx.load();
  let disposed = false;
  const ready = runPostProcessors(p, ctx, () => !disposed);
  // A processor that replaced or changed the code, or attached a child, claimed it (Dataview's
  // inline query renders asynchronously and swaps the code in afterwards).
  const claimed = ready.then(
    () =>
      ctx.attached > 0 || !p.contains(code) || code.textContent !== text || code.className !== "",
  );
  const mount: Mount = {
    el,
    ctx,
    fn: listPostProcessors()[0]?.fn ?? null,
    ready,
    dispose() {
      disposed = true;
      try {
        ctx.unload();
      } catch (e) {
        console.error("[plugin] inline unload threw:", e);
      }
      el.replaceChildren();
    },
  };
  return { mount, claimed };
}

/**
 * Probes whether any post processor turns `` `text` `` into something else (a Dataview inline
 * query does, ordinary code does not). The rendered result of a claimed probe is parked in the
 * pool under the same key, so the widget that follows does not run the query a second time.
 */
export function probeInline(
  sourcePath: string,
  text: string,
  done: (claimed: boolean) => void,
): void {
  const key = inlineKey(sourcePath, text);
  if (inlineClaims.has(key) || inlinePending.has(key)) return;
  inlinePending.add(key);
  const { mount, claimed } = mountInline(text, sourcePath);
  const generationSignature = signature;
  void claimed
    .then((yes) => {
      inlinePending.delete(key);
      if (generationSignature !== signature) {
        mount.dispose();
        return; // the registry changed while probing; the next scan probes again
      }
      if (inlineClaims.size >= INLINE_CLAIMS_MAX) inlineClaims.clear();
      inlineClaims.set(key, yes);
      if (yes) pool.release(`inline\0${key}`, mount);
      else mount.dispose();
      done(yes);
    })
    .catch((e) => {
      inlinePending.delete(key);
      inlineClaims.set(key, false);
      mount.dispose();
      logger.warn("plugin", "inline probe failed", { phase: "inline-probe", stack: String(e) });
    });
}

// ---------------------------------------------------------------- helpers

/** Frontmatter of a note's text (for contexts built without a metadata cache). */
export function frontmatterOf(raw: string): Record<string, unknown> | undefined {
  const parsed = parseFrontmatter(raw);
  if (parsed.frontmatter === null) return undefined;
  try {
    const fm = yamlParse(parsed.frontmatter, { logLevel: "error" });
    return fm && typeof fm === "object" && !Array.isArray(fm)
      ? (fm as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Test hook: drops every cache. */
export function resetMarkdownProcessorCaches(): void {
  inlineClaims.clear();
  inlinePending.clear();
  pool.clear();
}
