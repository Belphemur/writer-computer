// `fs` and `fs/promises`.
//
// Async: a vault-confined text subset over the host's VaultIo (readFile, writeFile, appendFile,
// stat/lstat, access, mkdir, rm, rmdir, unlink, rename, readdir, realpath, copyFile). Files are
// UTF-8 text (no binary IO yet); `read_directory` hides dotfiles. stat/access/realpath outside the
// vault go through `plugin_fs_probe` (allow-listed paths only, else EACCES); reads/writes outside
// the vault are EACCES, except the home-directory mounts of `home-mounts.ts` (served from inside
// the vault). mkdtemp/open/streams/symlink/chmod... are not supported.
//
// Sync: WKWebView cannot block on IPC, so existsSync/statSync/lstatSync/accessSync/realpathSync/
// readdirSync/readFileSync answer ONLY from a read-only cache filled asynchronously by
// `registerSyncProbePaths` (plugin_fs_probe) at boot. Unknown path = missing file (existsSync
// false, others throw ENOENT). A known file's CONTENT is only available when a host primed it with
// `primeSyncFileContents`; otherwise readFileSync throws EACCES. A known directory lists as [].
// All other sync calls throw ENOSYS.
import type { VaultIo } from "../api/vault";
import { Buffer } from "./buffer";
import { errnoError, messageOf, nodeError, type NodeError } from "./errors";
import type { FsProbe } from "./ipc";
import { posix } from "./path";
import { mountedAbsPath, mountedVaultPath } from "./home-mounts";
import { getBasePath, getNodeIpc, getOsInfo, syncContentCache, syncProbeCache } from "./state";

type PathLike = string | URL | Uint8Array;

const toPathString = (p: PathLike): string => {
  if (typeof p === "string") return p;
  if (p instanceof URL) return decodeURIComponent(p.pathname);
  if (p instanceof Uint8Array) return Buffer.from(p).toString("utf8");
  throw nodeError(
    "ERR_INVALID_ARG_TYPE",
    'The "path" argument must be of type string or an instance of Buffer or URL',
    {
      name: "TypeError",
    },
  );
};
const toAbs = (p: PathLike): string => posix.resolve(toPathString(p));

// ---------------------------------------------------------------- Stats

export class Stats {
  readonly dev = 0;
  readonly mode: number;
  readonly uid = 0;
  readonly gid = 0;
  readonly mtime: Date;
  readonly ctime: Date;
  readonly atime: Date;
  readonly birthtime: Date;
  readonly atimeMs: number;
  readonly birthtimeMs: number;
  constructor(
    private readonly kind: "file" | "dir",
    readonly size: number,
    readonly mtimeMs = 0,
    readonly ctimeMs = 0,
  ) {
    this.mode = kind === "dir" ? 0o40755 : 0o100644;
    this.mtime = new Date(mtimeMs);
    this.ctime = new Date(ctimeMs);
    this.atime = this.mtime;
    this.birthtime = this.ctime;
    this.atimeMs = mtimeMs;
    this.birthtimeMs = ctimeMs;
  }
  isFile = (): boolean => this.kind === "file";
  isDirectory = (): boolean => this.kind === "dir";
  isSymbolicLink = (): boolean => false;
  isFIFO = (): boolean => false;
  isSocket = (): boolean => false;
  isBlockDevice = (): boolean => false;
  isCharacterDevice = (): boolean => false;
}

class Dirent {
  constructor(
    readonly name: string,
    private readonly dir: boolean,
    readonly parentPath: string,
  ) {}
  isFile = (): boolean => !this.dir;
  isDirectory = (): boolean => this.dir;
  isSymbolicLink = (): boolean => false;
}

const statsOfProbe = (p: FsProbe): Stats => new Stats(p.is_dir ? "dir" : "file", p.size ?? 0);

// ---------------------------------------------------------------- sync cache API

const cacheKey = (abs: string): string => (abs.length > 1 ? abs.replace(/\/+$/, "") : abs);

/**
 * Host hook: probes `paths` (absolute) with `plugin_fs_probe` and stores the answers for the sync
 * fs functions. Call before plugin code that uses existsSync & co. runs. Paths outside Rust's
 * allow-list come back as not existing.
 */
export async function registerSyncProbePaths(paths: readonly string[]): Promise<void> {
  const list = [...new Set(paths.filter((p) => typeof p === "string" && p !== "").map(toAbs))];
  // Rust refuses more than 256 paths per call (PROBE_MAX_PATHS).
  for (let i = 0; i < list.length; i += 200)
    for (const r of await getNodeIpc().fsProbe(list.slice(i, i + 200))) storeProbe(r);
}

function storeProbe(r: FsProbe): void {
  const key = cacheKey(toAbs(r.path));
  syncProbeCache.set(key, r);
  if (r.text !== undefined) syncContentCache.set(key, r.text);
}

/**
 * Agent CLIs are validated synchronously: the plugin `realpathSync`s the program and reads the
 * package metadata next to it (`provenance.json` of a native bundle, `package.json` of an npm
 * package, one directory up). Rust returns the canonical path and those files' content for
 * programs `plugin_which` vouched for; this stores them in the sync cache.
 */
export async function primeCompanions(p: FsProbe): Promise<void> {
  if (!p.exists || !p.is_file || !p.real) return;
  const dir = posix.dirname(p.real);
  await registerSyncProbePaths([
    p.real,
    posix.join(dir, "provenance.json"),
    posix.join(dir, "package.json"),
    posix.join(posix.dirname(dir), "package.json"),
  ]);
}

/** Host hook: makes `readFileSync(path)` return `text` (the file's content snapshot). */
export function primeSyncFileContents(path: string, text: string): void {
  syncContentCache.set(cacheKey(toAbs(path)), text);
}

const probed = (p: PathLike): FsProbe | undefined => {
  let abs: string;
  try {
    abs = toAbs(p);
  } catch {
    return undefined;
  }
  const hit = syncProbeCache.get(cacheKey(abs));
  return hit?.exists ? hit : undefined;
};

// ---------------------------------------------------------------- module

// Values are the Linux/macOS-common ones; the SDK reads O_* at module scope.
export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0x200,
  O_EXCL: 0x800,
  O_TRUNC: 0x400,
  O_APPEND: 0x8,
  O_NONBLOCK: 0x4,
  O_NOFOLLOW: 0x100,
  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFDIR: 0o040000,
};

export interface FsModuleOptions {
  io?: VaultIo;
}

const unsupported = (name: string): never => {
  throw errnoError("ENOSYS", name, undefined, `${name}() is not supported in Writer`);
};

/**
 * A path a user typed or picked for an agent CLI (a "Save path" button stats it) can be anywhere.
 * `plugin_fs_probe` only answers inside its allow-list, so an executable at an absolute path is
 * confirmed with `plugin_which(path)`: the capability a plugin already has (no process, no
 * consent) and the one that makes the Rust side remember the path for this window, after which
 * the probe sees it. Anything else (not executable, not a file) stays missing.
 */
async function probeTypedExecutable(abs: string): Promise<FsProbe | undefined> {
  const ipc = getNodeIpc();
  try {
    if ((await ipc.which(abs)) === null) return undefined;
    const again = (await ipc.fsProbe([abs]))[0];
    return again?.exists ? again : undefined;
  } catch {
    return undefined; // EINVAL (a `..` path) or a backend failure: the path stays missing
  }
}

export function createFsModule(options: FsModuleOptions = {}) {
  const io = options.io;
  const base = (): string => cacheKey(io?.basePath ?? getBasePath());

  /** Vault-relative path ("" = root) or null when outside the vault. */
  const rel = (abs: string): string | null => {
    const b = base();
    if (abs === b) return "";
    if (abs.startsWith(`${b}/`)) return abs.slice(b.length + 1);
    // A plugin's home-directory data (see home-mounts.ts) lives inside the vault's plugin folder.
    return mountedVaultPath(getOsInfo().homedir, abs);
  };
  /** The absolute path a plugin sees for a vault-relative path (home mounts keep their virtual path). */
  const absOf = (relPath: string): string =>
    mountedAbsPath(getOsInfo().homedir, relPath) ?? `${base()}/${relPath}`;
  const needIo = (): VaultIo => {
    if (!io) throw errnoError("EACCES", "open", undefined, "no vault is available to this fs");
    return io;
  };
  const inVault = (p: PathLike, syscall: string): { abs: string; rel: string } => {
    const abs = toAbs(p);
    const r = rel(abs);
    if (r === null)
      throw errnoError("EACCES", syscall, toPathString(p), "permission denied (outside the vault)");
    return { abs, rel: r };
  };

  const wrapIo = async <T>(syscall: string, path: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if ((e as NodeError)?.code) throw e;
      const m = messageOf(e);
      const code = /not found|no such file|ENOENT/i.test(m)
        ? "ENOENT"
        : /denied|EACCES|outside|not allowed/i.test(m)
          ? "EACCES"
          : "EIO";
      throw errnoError(code, syscall, path, code === "EIO" ? m : undefined);
    }
  };

  async function statAny(path: PathLike, syscall: string): Promise<Stats> {
    const abs = toAbs(path);
    const r = rel(abs);
    if (r !== null) {
      const st = await wrapIo(syscall, abs, () => needIo().stat(r));
      if (!st) {
        syncProbeCache.delete(cacheKey(abs));
        throw errnoError("ENOENT", syscall, toPathString(path));
      }
      // The sync API (`existsSync`...) answers from this cache: a path the async side has seen
      // must not read as missing (Copilot checks a just-saved agent binary with `existsSync`).
      const dir = st.type === "folder";
      syncProbeCache.set(cacheKey(abs), {
        path: abs,
        exists: true,
        is_file: !dir,
        is_dir: dir,
        size: dir ? null : st.size,
      });
      return new Stats(dir ? "dir" : "file", st.size, st.mtime, st.ctime);
    }
    let probe: FsProbe | undefined;
    try {
      probe = (await getNodeIpc().fsProbe([abs]))[0];
    } catch (e) {
      throw errnoError("EACCES", syscall, toPathString(path), messageOf(e));
    }
    if (!probe?.exists) probe = (await probeTypedExecutable(abs)) ?? probe;
    if (probe) {
      storeProbe({ ...probe, path: abs });
      await primeCompanions(probe).catch(() => undefined); // best effort: only sync readers need it
    }
    if (!probe?.exists) throw errnoError("ENOENT", syscall, toPathString(path));
    return statsOfProbe(probe);
  }

  const encodingOf = (opts: unknown): string | null | undefined =>
    typeof opts === "string" ? opts : (opts as { encoding?: string | null } | undefined)?.encoding;
  const textOf = (data: unknown): string => {
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data))
      return new TextDecoder().decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
    return String(data);
  };

  async function readFile(path: PathLike, opts?: unknown): Promise<string | Buffer> {
    const { rel: r } = inVault(path, "open");
    const st = await statAny(path, "open");
    if (st.isDirectory()) throw errnoError("EISDIR", "read", toPathString(path));
    const text = await wrapIo("open", toPathString(path), () => needIo().readText(r));
    const enc = encodingOf(opts);
    return enc ? text : Buffer.from(text);
  }
  async function writeFile(path: PathLike, data: unknown, opts?: unknown): Promise<void> {
    const { rel: r } = inVault(path, "open");
    const flag = typeof opts === "object" && opts ? (opts as { flag?: string }).flag : undefined;
    let text = textOf(data);
    if (flag?.startsWith("a")) {
      const existing = await readFile(path, "utf8").catch(() => "");
      text = (existing as string) + text;
    }
    await wrapIo("open", toPathString(path), () => needIo().writeText(r, text));
  }
  const appendFile = (path: PathLike, data: unknown, opts?: unknown): Promise<void> =>
    writeFile(path, data, {
      ...(typeof opts === "object" && opts ? opts : { encoding: opts }),
      flag: "a",
    });

  async function mkdir(path: PathLike, opts?: unknown): Promise<string | undefined> {
    const { abs, rel: r } = inVault(path, "mkdir");
    const recursive =
      typeof opts === "object" &&
      opts !== null &&
      (opts as { recursive?: boolean }).recursive === true;
    const existing = await statAny(path, "mkdir").catch(() => null);
    if (existing) {
      if (recursive && existing.isDirectory()) return undefined;
      throw errnoError("EEXIST", "mkdir", toPathString(path));
    }
    let first: string | undefined;
    const targetMounted = mountedVaultPath(getOsInfo().homedir, abs) !== null;
    if (recursive) {
      const parts = r.split("/").filter(Boolean);
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        if (!(await wrapIo("mkdir", abs, () => needIo().stat(acc)))) {
          await wrapIo("mkdir", abs, () => needIo().mkdir(acc));
          // Under a home mount, report the first directory inside the mount (the backing folders
          // above it are an implementation detail, not something the plugin created).
          const shown = mountedAbsPath(getOsInfo().homedir, acc);
          if (shown !== null || !targetMounted) first ??= absOf(acc);
        }
      }
      return first;
    }
    await wrapIo("mkdir", toPathString(path), () => needIo().mkdir(r));
    return undefined;
  }

  /**
   * Removing something outside the vault is EACCES only when it EXISTS. A path that is not there
   * is ENOENT (`rm({force:true})` then succeeds): Copilot's "use my own binary" cleanup removes
   * its managed-download folders under `~/.obsidian-copilot` unconditionally, and a refusal for a
   * folder that does not exist made saving a custom Codex/OpenCode path fail.
   */
  async function inVaultOrMissing(
    path: PathLike,
    syscall: string,
  ): Promise<{ abs: string; rel: string }> {
    if (rel(toAbs(path)) === null) await statAny(path, syscall); // ENOENT when absent
    return inVault(path, syscall);
  }

  async function rm(path: PathLike, opts?: unknown): Promise<void> {
    const o = (opts ?? {}) as { recursive?: boolean; force?: boolean };
    const { rel: r } = await inVaultOrMissing(path, "rm").catch((e: NodeError) => {
      if (e.code === "ENOENT" && o.force) return { rel: null, abs: "" };
      throw e;
    });
    if (r === null) return;
    const st = await statAny(path, "rm").catch((e: NodeError) => {
      if (e.code === "ENOENT" && o.force) return null;
      throw e;
    });
    if (!st) return;
    if (r === "")
      throw errnoError("EPERM", "rm", toPathString(path), "refusing to remove the vault root");
    if (st.isDirectory() && !o.recursive)
      throw nodeError(
        "ERR_FS_EISDIR",
        `Path is a directory: rm returned EISDIR (is a directory) ${toPathString(path)}`,
        { errno: 21, syscall: "rm", path: toPathString(path) },
      );
    await wrapIo("rm", toPathString(path), () => needIo().remove(r));
  }

  async function removeKind(path: PathLike, syscall: "unlink" | "rmdir"): Promise<void> {
    const { rel: r } = await inVaultOrMissing(path, syscall);
    const st = await statAny(path, syscall);
    if (syscall === "unlink" && st.isDirectory())
      throw errnoError("EISDIR", syscall, toPathString(path));
    if (syscall === "rmdir" && !st.isDirectory())
      throw errnoError("ENOTDIR", syscall, toPathString(path));
    if (r === "")
      throw errnoError("EPERM", syscall, toPathString(path), "refusing to remove the vault root");
    await wrapIo(syscall, toPathString(path), () => needIo().remove(r));
  }

  async function rename(from: PathLike, to: PathLike): Promise<void> {
    const a = inVault(from, "rename");
    const b = inVault(to, "rename");
    await statAny(from, "rename");
    await wrapIo("rename", toPathString(from), () => needIo().rename(a.rel, b.rel));
  }

  async function readdir(path: PathLike, opts?: unknown): Promise<unknown[]> {
    const { rel: r, abs } = inVault(path, "scandir");
    const st = await statAny(path, "scandir");
    if (!st.isDirectory()) throw errnoError("ENOTDIR", "scandir", toPathString(path));
    const entries = await wrapIo("scandir", abs, () => needIo().list(r));
    const withTypes =
      typeof opts === "object" &&
      opts !== null &&
      (opts as { withFileTypes?: boolean }).withFileTypes === true;
    return entries.map((e) => (withTypes ? new Dirent(e.name, e.isDir, abs) : e.name));
  }

  async function realpath(path: PathLike): Promise<string> {
    await statAny(path, "realpath");
    return syncProbeCache.get(cacheKey(toAbs(path)))?.real ?? toAbs(path);
  }

  async function access(path: PathLike, _mode?: number): Promise<void> {
    await statAny(path, "access");
  }

  async function copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void> {
    if (mode === constants.COPYFILE_EXCL && (await statAny(dest, "copyfile").catch(() => null)))
      throw errnoError("EEXIST", "copyfile", toPathString(dest));
    await writeFile(dest, await readFile(src, "utf8"));
  }

  const promises = {
    readFile,
    writeFile,
    appendFile,
    stat: (p: PathLike) => statAny(p, "stat"),
    lstat: (p: PathLike) => statAny(p, "lstat"),
    access,
    mkdir,
    rm,
    rmdir: (p: PathLike) => removeKind(p, "rmdir"),
    unlink: (p: PathLike) => removeKind(p, "unlink"),
    rename,
    readdir,
    realpath,
    copyFile,
    mkdtemp: async (): Promise<never> => unsupported("mkdtemp"),
    open: async (): Promise<never> => unsupported("open"),
    opendir: async (): Promise<never> => unsupported("opendir"),
    symlink: async (): Promise<never> => unsupported("symlink"),
    chmod: async (): Promise<never> => unsupported("chmod"),
    chown: async (): Promise<never> => unsupported("chown"),
    utimes: async (): Promise<never> => unsupported("utimes"),
    truncate: async (): Promise<never> => unsupported("truncate"),
    watch: (): never => unsupported("watch"),
    constants,
  };

  // ---- callback forms
  const callbackForms: Record<string, unknown> = {};
  for (const name of [
    "readFile",
    "writeFile",
    "appendFile",
    "stat",
    "lstat",
    "access",
    "mkdir",
    "rm",
    "rmdir",
    "unlink",
    "rename",
    "readdir",
    "realpath",
    "copyFile",
    "mkdtemp",
    "open",
    "symlink",
    "chmod",
  ] as const) {
    const fn = promises[name] as (...a: unknown[]) => Promise<unknown>;
    callbackForms[name] = (...args: unknown[]): void => {
      const cb = args.pop();
      if (typeof cb !== "function")
        throw nodeError("ERR_INVALID_ARG_TYPE", 'The "cb" argument must be of type function', {
          name: "TypeError",
        });
      fn(...args).then(
        (v) => queueMicrotask(() => (cb as (e: null, v?: unknown) => void)(null, v)),
        (e) => queueMicrotask(() => (cb as (e: unknown) => void)(e)),
      );
    };
  }

  // ---- sync (cache only)
  const missing = (syscall: string, p: PathLike): never => {
    throw errnoError("ENOENT", syscall, toPathString(p));
  };
  const realOf = (p: PathLike): string => {
    const hit = probed(p);
    return hit ? (hit.real ?? toAbs(p)) : missing("realpath", p);
  };
  function statSync(p: PathLike, opts?: { throwIfNoEntry?: boolean }): Stats | undefined {
    const hit = probed(p);
    if (hit) return statsOfProbe(hit);
    if (opts?.throwIfNoEntry === false) return undefined;
    return missing("stat", p);
  }
  const syncModule = {
    existsSync: (p: PathLike): boolean => {
      try {
        return probed(p) !== undefined;
      } catch {
        return false;
      }
    },
    statSync,
    lstatSync: statSync,
    accessSync: (p: PathLike): void => {
      if (!probed(p)) missing("access", p);
    },
    realpathSync: Object.assign((p: PathLike): string => realOf(p), {
      native: (p: PathLike): string => realOf(p),
    }),
    readdirSync: (p: PathLike, opts?: unknown): unknown[] => {
      const hit = probed(p);
      if (!hit) return missing("scandir", p);
      if (!hit.is_dir) throw errnoError("ENOTDIR", "scandir", toPathString(p));
      void opts;
      return hit.entries ? [...hit.entries] : []; // only version roots are listed, see ipc.ts
    },
    readFileSync: (p: PathLike, opts?: unknown): string | Buffer => {
      const abs = toAbs(p);
      const hit = probed(p);
      if (!hit) return missing("open", p);
      if (hit.is_dir) throw errnoError("EISDIR", "read", toPathString(p));
      const text = syncContentCache.get(cacheKey(abs));
      if (text === undefined)
        throw errnoError(
          "EACCES",
          "open",
          toPathString(p),
          "file content is not available synchronously in Writer",
        );
      return encodingOf(opts) ? text : Buffer.from(text);
    },
  };
  const syncUnsupported: Record<string, unknown> = {};
  for (const n of [
    "writeFileSync",
    "appendFileSync",
    "mkdirSync",
    "rmSync",
    "rmdirSync",
    "unlinkSync",
    "renameSync",
    "copyFileSync",
    "openSync",
    "closeSync",
    "readSync",
    "writeSync",
    "symlinkSync",
    "chmodSync",
    "mkdtempSync",
    "truncateSync",
    "utimesSync",
  ])
    syncUnsupported[n] = () => unsupported(n);

  const fsModule = {
    ...callbackForms,
    ...syncModule,
    ...syncUnsupported,
    // exists(path, cb) is the legacy callback that takes a boolean only
    exists: (p: PathLike, cb: (e: boolean) => void): void => {
      statAny(p, "stat").then(
        () => queueMicrotask(() => cb(true)),
        () => queueMicrotask(() => cb(false)),
      );
    },
    createReadStream: (): never => unsupported("createReadStream"),
    createWriteStream: (): never => unsupported("createWriteStream"),
    watch: (): never => unsupported("watch"),
    watchFile: (): never => unsupported("watchFile"),
    constants,
    promises,
    Stats,
    Dirent,
  };
  return { fs: fsModule, promises };
}
