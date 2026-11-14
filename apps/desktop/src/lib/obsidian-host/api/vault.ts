// Adapted from opensidian (GPL-3.0-or-later).
// The vault model: TAbstractFile/TFile/TFolder, DataAdapter/FileSystemAdapter, Vault and
// MetadataCache. Everything talks to an injectable `VaultIo` (vault-relative paths), so the
// model is testable without Tauri; `vault-io-tauri.ts` implements it on the app's commands.
import { parse as yamlParse } from "yaml";
import { parseFrontmatter } from "@/lib/frontmatter";
import { parseWikiLink } from "@/lib/wiki-links";
import { Events, type EventRef } from "./core";
import { normalizePath, parseFrontMatterTags } from "./functions";

// ---------------------------------------------------------------- IO boundary

export interface VaultEntry {
  name: string;
  /** Vault-relative, forward slashes, no leading slash. */
  path: string;
  isDir: boolean;
  /** Milliseconds since epoch. */
  mtime: number;
  ctime: number;
  size: number;
}

export interface VaultStat {
  type: "file" | "folder";
  ctime: number;
  mtime: number;
  size: number;
}

/** All paths are vault-relative ("" is the vault root). */
export interface VaultIo {
  /** Absolute filesystem path of the vault root (FileSystemAdapter.getBasePath). */
  readonly basePath: string;
  readonly name: string;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  list(dir: string): Promise<VaultEntry[]>;
  stat(path: string): Promise<VaultStat | null>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  writeBinary?(path: string, data: ArrayBuffer): Promise<void>;
}

const unsupported = (what: string): never => {
  throw new Error(`${what} is not supported by this vault backend yet`);
};

// ---------------------------------------------------------------- model

export class TAbstractFile {
  parent: TFolder | null = null;
  constructor(
    public vault: Vault,
    public path: string,
  ) {}
  get name(): string {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }
}

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export class TFile extends TAbstractFile {
  stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
  get extension(): string {
    const n = this.name;
    const i = n.lastIndexOf(".");
    return i <= 0 ? "" : n.slice(i + 1);
  }
  get basename(): string {
    const n = this.name;
    const i = n.lastIndexOf(".");
    return i <= 0 ? n : n.slice(0, i);
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === "/";
  }
  get name(): string {
    return this.isRoot() ? "" : super.name;
  }
}

// ---------------------------------------------------------------- adapters

export class DataAdapter {
  constructor(protected io: VaultIo) {}

  private p(path: string): string {
    const n = normalizePath(path);
    return n === "/" ? "" : n;
  }

  getName(): string {
    return this.io.name;
  }
  async exists(path: string): Promise<boolean> {
    return (await this.io.stat(this.p(path))) !== null;
  }
  async stat(path: string): Promise<VaultStat | null> {
    return this.io.stat(this.p(path));
  }
  read(path: string): Promise<string> {
    return this.io.readText(this.p(path));
  }
  async write(path: string, data: string): Promise<void> {
    await this.ensureParent(this.p(path));
    await this.io.writeText(this.p(path), data);
  }
  async append(path: string, data: string): Promise<void> {
    const p = this.p(path);
    const existing = (await this.io.stat(p)) ? await this.io.readText(p) : "";
    await this.write(p, existing + data);
  }
  async process(path: string, fn: (data: string) => string): Promise<string> {
    const next = fn(await this.read(path));
    await this.write(path, next);
    return next;
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.io.readBinary ? this.io.readBinary(this.p(path)) : unsupported("readBinary");
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    return this.io.writeBinary
      ? this.io.writeBinary(this.p(path), data)
      : unsupported("writeBinary");
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const entries = await this.io.list(this.p(path));
    return {
      files: entries.filter((e) => !e.isDir).map((e) => e.path),
      folders: entries.filter((e) => e.isDir).map((e) => e.path),
    };
  }
  async mkdir(path: string): Promise<void> {
    await this.io.mkdir(this.p(path));
  }
  async remove(path: string): Promise<void> {
    await this.io.remove(this.p(path));
  }
  async rmdir(path: string, _recursive: boolean): Promise<void> {
    await this.io.remove(this.p(path));
  }
  async trashSystem(path: string): Promise<boolean> {
    await this.remove(path);
    return true;
  }
  async trashLocal(path: string): Promise<void> {
    await this.remove(path);
  }
  async rename(from: string, to: string): Promise<void> {
    await this.ensureParent(this.p(to));
    await this.io.rename(this.p(from), this.p(to));
  }
  async copy(from: string, to: string): Promise<void> {
    await this.write(to, await this.read(from));
  }
  getResourcePath(path: string): string {
    return `writer-vault://localhost/${encodeURI(this.p(path))}`;
  }

  private async ensureParent(path: string): Promise<void> {
    const i = path.lastIndexOf("/");
    if (i <= 0) return;
    const dir = path.slice(0, i);
    if (!(await this.io.stat(dir))) await this.io.mkdir(dir);
  }
}

export class FileSystemAdapter extends DataAdapter {
  getBasePath(): string {
    return this.io.basePath;
  }
  getFullPath(normalizedPath: string): string {
    const p = normalizePath(normalizedPath);
    return p === "/" ? this.io.basePath : `${this.io.basePath}/${p}`;
  }
  get basePath(): string {
    return this.io.basePath;
  }
}

// ---------------------------------------------------------------- Vault

const HIDDEN = (name: string): boolean => name.startsWith(".");

export class Vault extends Events {
  adapter: FileSystemAdapter;
  configDir = ".obsidian";
  private index = new Map<string, TAbstractFile>();
  private root: TFolder;

  constructor(public io: VaultIo) {
    super();
    this.adapter = new FileSystemAdapter(io);
    this.root = new TFolder(this, "/");
    this.index.set("/", this.root);
  }

  getName(): string {
    return this.io.name;
  }
  getRoot(): TFolder {
    return this.root;
  }

  /** Builds the file index (hidden entries such as `.obsidian` are not part of the vault). */
  async load(): Promise<void> {
    this.index.clear();
    this.root = new TFolder(this, "/");
    this.index.set("/", this.root);
    await this.walk("");
    if (!this.initialCreatesDone) {
      this.pendingInitial = [...this.index.values()].filter((n) => n !== this.root);
    }
  }

  private pendingInitial: TAbstractFile[] = [];
  private initialCreatesDone = false;
  /** True while pre-existing files are being announced; the metadata cache ignores these. */
  replayingInitial = false;

  /**
   * Fires `create` once for every file/folder that existed when the vault loaded (Obsidian's
   * initialization behaviour). Called by the workspace right before layout becomes ready; after
   * that nothing is replayed, so late listeners never see pre-existing files.
   */
  replayInitialCreates(): void {
    this.initialCreatesDone = true;
    const pending = this.pendingInitial;
    this.pendingInitial = [];
    this.replayingInitial = true;
    try {
      for (const node of pending) {
        if (this.index.get(node.path) === node) this.trigger("create", node);
      }
    } finally {
      this.replayingInitial = false;
    }
  }

  private async walk(dir: string): Promise<void> {
    const entries = (await this.io.list(dir)).filter((e) => !HIDDEN(e.name));
    const subs: Promise<void>[] = [];
    for (const e of entries) {
      const node = this.addNode(e);
      if (node instanceof TFolder) subs.push(this.walk(e.path));
    }
    await Promise.all(subs);
  }

  private addNode(e: VaultEntry): TAbstractFile {
    const existing = this.index.get(e.path);
    if (existing) return existing;
    const node = e.isDir ? new TFolder(this, e.path) : new TFile(this, e.path);
    if (node instanceof TFile) node.stat = { ctime: e.ctime, mtime: e.mtime, size: e.size };
    const slash = e.path.lastIndexOf("/");
    const parent =
      slash < 0 ? this.root : (this.index.get(e.path.slice(0, slash)) as TFolder | undefined);
    node.parent = parent ?? this.root;
    node.parent.children.push(node);
    this.index.set(e.path, node);
    return node;
  }

  private removeNode(node: TAbstractFile): void {
    if (node instanceof TFolder) for (const c of Array.from(node.children)) this.removeNode(c);
    this.index.delete(node.path);
    if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const p = normalizePath(path);
    return this.index.get(p) ?? null;
  }
  getFileByPath(path: string): TFile | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }
  getFolderByPath(path: string): TFolder | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : null;
  }
  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.index.values()];
  }
  getAllFolders(includeRoot = true): TFolder[] {
    return this.getAllLoadedFiles().filter(
      (f): f is TFolder => f instanceof TFolder && (includeRoot || !f.isRoot()),
    );
  }
  getFiles(): TFile[] {
    return this.getAllLoadedFiles().filter((f): f is TFile => f instanceof TFile);
  }
  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension.toLowerCase() === "md");
  }

  read(file: TFile): Promise<string> {
    return this.io.readText(file.path);
  }
  cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }
  readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }
  getResourcePath(file: TFile): string {
    return this.adapter.getResourcePath(file.path);
  }

  private async refreshStat(file: TFile): Promise<void> {
    const s = await this.io.stat(file.path);
    if (s) file.stat = { ctime: s.ctime, mtime: s.mtime, size: s.size };
  }

  async create(path: string, data: string): Promise<TFile> {
    const p = normalizePath(path);
    if (this.index.has(p)) throw new Error("File already exists.");
    await this.adapter.write(p, data);
    await this.ensureFolderNodes(p.slice(0, Math.max(0, p.lastIndexOf("/"))));
    const s = await this.io.stat(p);
    const node = this.addNode({
      name: p.slice(p.lastIndexOf("/") + 1),
      path: p,
      isDir: false,
      mtime: s?.mtime ?? Date.now(),
      ctime: s?.ctime ?? Date.now(),
      size: s?.size ?? data.length,
    }) as TFile;
    this.trigger("create", node);
    return node;
  }

  private async ensureFolderNodes(dir: string): Promise<void> {
    if (!dir || this.index.has(dir)) return;
    const slash = dir.lastIndexOf("/");
    if (slash > 0) await this.ensureFolderNodes(dir.slice(0, slash));
    this.addNode({
      name: dir.slice(slash + 1),
      path: dir,
      isDir: true,
      mtime: 0,
      ctime: 0,
      size: 0,
    });
  }

  async createFolder(path: string): Promise<TFolder> {
    const p = normalizePath(path);
    if (this.index.has(p)) throw new Error("Folder already exists.");
    await this.io.mkdir(p);
    await this.ensureFolderNodes(p);
    const node = this.index.get(p) as TFolder;
    this.trigger("create", node);
    return node;
  }

  async modify(file: TFile, data: string): Promise<void> {
    await this.io.writeText(file.path, data);
    await this.refreshStat(file);
    this.trigger("modify", file);
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(await this.read(file));
    await this.modify(file, next);
    return next;
  }

  async append(file: TFile, data: string): Promise<void> {
    await this.modify(file, (await this.read(file)) + data);
  }

  async delete(file: TAbstractFile, _force?: boolean): Promise<void> {
    await this.io.remove(file.path);
    this.removeNode(file);
    this.trigger("delete", file);
  }

  async trash(file: TAbstractFile, _system: boolean): Promise<void> {
    await this.delete(file);
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const to = normalizePath(newPath);
    if (this.index.has(to)) throw new Error("Destination file already exists!");
    const oldPath = file.path;
    await this.adapter.rename(oldPath, to);
    this.reindex(file, to);
    this.trigger("rename", file, oldPath);
  }

  private reindex(node: TAbstractFile, newPath: string): void {
    const oldPath = node.path;
    this.index.delete(oldPath);
    if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
    node.path = newPath;
    const slash = newPath.lastIndexOf("/");
    const parent =
      slash < 0
        ? this.root
        : ((this.index.get(newPath.slice(0, slash)) as TFolder | undefined) ?? this.root);
    node.parent = parent;
    parent.children.push(node);
    this.index.set(newPath, node);
    if (node instanceof TFolder) {
      for (const c of Array.from(node.children)) this.reindex(c, `${newPath}/${c.name}`);
    }
  }

  async copy(file: TFile, newPath: string): Promise<TFile> {
    return this.create(newPath, await this.read(file));
  }

  getConfig(_key: string): unknown {
    return undefined;
  }

  /**
   * Makes sure a file that exists on disk is in the index (a note Writer just created may be
   * reported by the watcher after the UI already navigated to it). Fires `create` when it adds.
   */
  async ensureIndexed(path: string): Promise<void> {
    const p = normalizePath(path);
    if (this.index.has(p)) return;
    await this.notifyExternal("create", p);
  }

  /**
   * Feed changes the host observed (file watcher) into the model. Writes made through this
   * Vault trigger their own events and must not be reported again.
   */
  async notifyExternal(kind: "create" | "modify" | "delete", path: string): Promise<void> {
    const p = normalizePath(path);
    if (p.split("/").some(HIDDEN)) return;
    const existing = this.index.get(p);
    if (kind === "delete") {
      if (existing) {
        this.removeNode(existing);
        this.trigger("delete", existing);
      }
      return;
    }
    const s = await this.io.stat(p);
    if (!s) {
      // Gone by the time we looked (rename source, quick delete): drop the stale node.
      if (existing) {
        this.removeNode(existing);
        this.trigger("delete", existing);
      }
      return;
    }
    if (existing instanceof TFile) {
      existing.stat = { ctime: s.ctime, mtime: s.mtime, size: s.size };
      this.trigger("modify", existing);
      return;
    }
    if (existing) return;
    await this.ensureFolderNodes(p.slice(0, Math.max(0, p.lastIndexOf("/"))));
    const node = this.addNode({
      name: p.slice(p.lastIndexOf("/") + 1),
      path: p,
      isDir: s.type === "folder",
      ...s,
    });
    this.trigger("create", node);
  }
}

// ---------------------------------------------------------------- metadata

export interface Loc {
  line: number;
  col: number;
  offset: number;
}
export interface Pos {
  start: Loc;
  end: Loc;
}
export interface LinkCache {
  link: string;
  original: string;
  displayText?: string;
  position: Pos;
}
export interface TagCache {
  tag: string;
  position: Pos;
}
export interface HeadingCache {
  heading: string;
  level: number;
  position: Pos;
}
export interface CachedMetadata {
  frontmatter?: Record<string, any>;
  frontmatterPosition?: Pos;
  links?: LinkCache[];
  embeds?: LinkCache[];
  tags?: TagCache[];
  headings?: HeadingCache[];
}

/** Replaces fenced and inline code with spaces (same length) so scanners skip it. */
function maskCode(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|(?![\s\S]))/gm, blank)
    .replace(/`[^`\n]*`/g, blank);
}

function locator(text: string): (offset: number) => Loc {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, col: offset - starts[lo], offset };
  };
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/** Pure: parses frontmatter, links, embeds, tags and headings of a note. */
export function parseNoteMetadata(raw: string): CachedMetadata {
  const out: CachedMetadata = {};
  const loc = locator(raw);
  const parsed = parseFrontmatter(raw);
  const bodyOffset = raw.length - parsed.body.length;

  if (parsed.frontmatter !== null) {
    try {
      const fm = yamlParse(parsed.frontmatter);
      if (fm && typeof fm === "object" && !Array.isArray(fm))
        out.frontmatter = fm as Record<string, any>;
    } catch {
      // Invalid YAML: Obsidian shows an error but indexes the rest; so do we.
    }
    out.frontmatterPosition = { start: loc(0), end: loc(Math.max(0, bodyOffset - 1)) };
  }

  const text = maskCode(parsed.body);
  const pos = (s: number, e: number): Pos => ({
    start: loc(bodyOffset + s),
    end: loc(bodyOffset + e),
  });

  const links: LinkCache[] = [];
  const embeds: LinkCache[] = [];
  for (const m of text.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
    const w = parseWikiLink(m[2]);
    const link = w.fragment !== null ? `${w.path}#${w.fragment}` : w.path;
    const cache: LinkCache = {
      link,
      original: m[0],
      displayText: w.alias ?? link,
      position: pos(m.index, m.index + m[0].length),
    };
    (m[1] ? embeds : links).push(cache);
  }
  for (const m of text.matchAll(/(!?)\[([^\]\n]*)\]\((<[^>\n]*>|[^)\s\n]+)(?:\s+"[^"\n]*")?\)/g)) {
    let dest = m[3].startsWith("<") ? m[3].slice(1, -1) : m[3];
    if (EXTERNAL.test(dest)) continue;
    try {
      dest = decodeURIComponent(dest);
    } catch {
      // keep as typed
    }
    const cache: LinkCache = {
      link: dest,
      original: m[0],
      displayText: m[2],
      position: pos(m.index, m.index + m[0].length),
    };
    (m[1] ? embeds : links).push(cache);
  }
  if (links.length)
    out.links = links.sort((a, b) => a.position.start.offset - b.position.start.offset);
  if (embeds.length)
    out.embeds = embeds.sort((a, b) => a.position.start.offset - b.position.start.offset);

  const tags: TagCache[] = [];
  for (const m of text.matchAll(/(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
    const start = m.index + m[1].length;
    tags.push({ tag: `#${m[2]}`, position: pos(start, start + m[2].length + 1) });
  }
  if (tags.length) out.tags = tags;

  const headings: HeadingCache[] = [];
  for (const m of text.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    headings.push({
      heading: m[2],
      level: m[1].length,
      position: pos(m.index, m.index + m[0].length),
    });
  }
  if (headings.length) out.headings = headings;
  return out;
}

export function getAllTags(cache: CachedMetadata): string[] | null {
  const set = new Set<string>();
  for (const t of cache.tags ?? []) set.add(t.tag);
  for (const t of parseFrontMatterTags(cache.frontmatter) ?? []) set.add(t);
  return set.size > 0 ? [...set] : null;
}

export class MetadataCache extends Events {
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  private cache = new Map<string, CachedMetadata>();
  private refs: EventRef[] = [];
  private tickets = new Map<string, number>();

  constructor(private vault: Vault) {
    super();
  }

  /** Starts following vault changes. `dispose()` stops. */
  start(): void {
    if (this.refs.length > 0) return;
    const v = this.vault;
    this.refs.push(
      v.on("create", (f: unknown) => void this.reindexOne(f)),
      v.on("modify", (f: unknown) => void this.reindexOne(f)),
      v.on("delete", (f: TAbstractFile) => {
        if (!(f instanceof TFile)) return;
        this.drop(f.path);
        this.trigger("deleted", f, this.cache.get(f.path));
        this.resolveAll();
      }),
      v.on("rename", (f: TAbstractFile, oldPath: string) => {
        if (!(f instanceof TFile)) return;
        const c = this.cache.get(oldPath);
        this.drop(oldPath);
        if (c) this.cache.set(f.path, c);
        this.resolveAll();
      }),
    );
  }

  dispose(): void {
    for (const r of this.refs.splice(0)) r.e.offref(r);
  }

  private drop(path: string): void {
    this.cache.delete(path);
    delete this.resolvedLinks[path];
    delete this.unresolvedLinks[path];
  }

  private async reindexOne(f: unknown): Promise<void> {
    if (this.vault.replayingInitial) return; // indexAll() covers pre-existing files
    if (!(f instanceof TFile) || f.extension.toLowerCase() !== "md") return;
    await this.indexFile(f);
    this.resolveAll();
  }

  /** Parses one file and fires `changed`. Does not resolve links (see resolveAll). */
  async indexFile(file: TFile): Promise<CachedMetadata> {
    // A slower, older read must not overwrite the result of a newer one for the same path.
    const ticket = (this.tickets.get(file.path) ?? 0) + 1;
    this.tickets.set(file.path, ticket);
    const content = await this.vault.cachedRead(file);
    const meta = parseNoteMetadata(content);
    if (this.tickets.get(file.path) !== ticket) return this.cache.get(file.path) ?? meta;
    this.cache.set(file.path, meta);
    this.trigger("changed", file, content, meta);
    return meta;
  }

  /** Indexes every markdown file, then resolves links and fires `resolved`. */
  async indexAll(): Promise<void> {
    await Promise.all(this.vault.getMarkdownFiles().map((f) => this.indexFile(f)));
    this.resolveAll();
  }

  private resolveAll(): void {
    this.resolvedLinks = {};
    this.unresolvedLinks = {};
    for (const [path, meta] of this.cache) {
      const resolved: Record<string, number> = {};
      const unresolved: Record<string, number> = {};
      for (const l of [...(meta.links ?? []), ...(meta.embeds ?? [])]) {
        const target = this.getFirstLinkpathDest(parseLinkPath(l.link), path);
        const bucket = target ? resolved : unresolved;
        const key = target ? target.path : parseLinkPath(l.link);
        if (!key) continue; // [[#heading]] links to the note itself
        bucket[key] = (bucket[key] ?? 0) + 1;
      }
      this.resolvedLinks[path] = resolved;
      this.unresolvedLinks[path] = unresolved;
    }
    this.trigger("resolved");
  }

  /**
   * Undocumented but used by plugins (Copilot's graph boost): who links to `file`.
   * `data` maps each linking note's path to the link entries that resolve to `file`.
   */
  getBacklinksForFile(file: TFile): {
    data: Map<string, LinkCache[]>;
    get(path: string): LinkCache[] | undefined;
    keys(): string[];
  } {
    const data = new Map<string, LinkCache[]>();
    for (const [path, meta] of this.cache) {
      if (path === file.path) continue; // self-links are not backlinks
      const hits = [...(meta.links ?? []), ...(meta.embeds ?? [])].filter(
        (l) => this.getFirstLinkpathDest(parseLinkPath(l.link), path)?.path === file.path,
      );
      if (hits.length > 0) data.set(path, hits);
    }
    return { data, get: (p) => data.get(p), keys: () => [...data.keys()] };
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.cache.get(file.path) ?? null;
  }
  getCache(path: string): CachedMetadata | null {
    return this.cache.get(normalizePath(path)) ?? null;
  }

  getTags(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const meta of this.cache.values())
      for (const t of getAllTags(meta) ?? []) out[t] = (out[t] ?? 0) + 1;
    return out;
  }

  /** Obsidian resolution: exact path (with or without .md), else shortest-path name match. */
  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const want = normalizePath(linkpath);
    if (!want || want === "/") return this.vault.getFileByPath(sourcePath);
    const exact = this.vault.getFileByPath(want) ?? this.vault.getFileByPath(`${want}.md`);
    if (exact) return exact;
    const name = (want.endsWith(".md") ? want : `${want}.md`).toLowerCase();
    const wantsPath = name.includes("/");
    const candidates = this.vault.getFiles().filter((f) => {
      const p = f.path.toLowerCase();
      return wantsPath
        ? p === name || p.endsWith(`/${name}`)
        : f.name.toLowerCase() === name || f.name.toLowerCase() === want.toLowerCase();
    });
    if (candidates.length === 0) return null;
    const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    candidates.sort((a, b) => {
      const sa = a.parent && a.parent.path === dir ? 0 : 1;
      const sb = b.parent && b.parent.path === dir ? 0 : 1;
      return sa - sb || a.path.length - b.path.length || a.path.localeCompare(b.path);
    });
    return candidates[0];
  }

  fileToLinktext(file: TFile, _sourcePath: string, omitMdExtension = true): string {
    const base = omitMdExtension && file.extension === "md" ? file.path.slice(0, -3) : file.path;
    const sameName = this.vault.getFiles().filter((f) => f.name === file.name);
    return sameName.length > 1
      ? base
      : omitMdExtension && file.extension === "md"
        ? file.basename
        : file.name;
  }

  isUserIgnored(_path: string): boolean {
    return false;
  }
}

function parseLinkPath(link: string): string {
  const i = link.indexOf("#");
  return i < 0 ? link : link.slice(0, i);
}
