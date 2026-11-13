// `path`: POSIX and a minimal-but-correct win32 flavour. `resolve` uses the runtime cwd (the vault
// base path once the runtime is preloaded, "/" before).
import { getBasePath } from "./state";

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}
export interface PathModule {
  sep: string;
  delimiter: string;
  normalize(p: string): string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  parse(p: string): ParsedPath;
  format(o: Partial<ParsedPath>): string;
  isAbsolute(p: string): boolean;
  toNamespacedPath(p: string): string;
  posix: PathModule;
  win32: PathModule;
}

function assertString(p: unknown, name = "path"): asserts p is string {
  if (typeof p !== "string") {
    const e = new TypeError(`The "${name}" argument must be of type string. Received ${typeof p}`);
    (e as TypeError & { code: string }).code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
}

/** Collapses `.`/`..`/empty segments of a separator-split path. */
function collapse(segments: string[], allowAboveRoot: boolean): string[] {
  const out: string[] = [];
  for (const s of segments) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (allowAboveRoot) out.push("..");
    } else out.push(s);
  }
  return out;
}

function stripExt(base: string, ext?: string): string {
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}

function extOf(base: string): string {
  if (base === ".." || base === ".") return "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

function makePosix(cwd: () => string): PathModule {
  const isAbsolute = (p: string): boolean => (assertString(p), p.startsWith("/"));
  const normalize = (p: string): string => {
    assertString(p);
    if (p === "") return ".";
    const abs = p.startsWith("/");
    const trailing = p.endsWith("/");
    const body = collapse(p.split("/"), !abs).join("/");
    if (body === "") return abs ? "/" : trailing ? "./" : ".";
    return (abs ? "/" : "") + body + (trailing ? "/" : "");
  };
  const join = (...parts: string[]): string => {
    parts.forEach((p) => assertString(p));
    const j = parts.filter((p) => p !== "").join("/");
    return j === "" ? "." : normalize(j);
  };
  const resolve = (...parts: string[]): string => {
    let acc = "";
    let abs = false;
    for (let i = parts.length - 1; i >= -1 && !abs; i--) {
      const seg = i >= 0 ? parts[i] : cwd();
      assertString(seg);
      if (seg === "") continue;
      acc = acc === "" ? seg : `${seg}/${acc}`;
      abs = seg.startsWith("/");
    }
    const body = collapse(acc.split("/"), !abs).join("/");
    return abs ? `/${body}` : body === "" ? "." : body;
  };
  const trimmed = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
  const basename = (p: string, ext?: string): string => {
    assertString(p);
    const t = trimmed(p);
    if (t === "/") return "";
    return stripExt(t.slice(t.lastIndexOf("/") + 1), ext);
  };
  const dirname = (p: string): string => {
    assertString(p);
    if (p === "") return ".";
    const t = trimmed(p);
    if (t === "/") return "/";
    const i = t.lastIndexOf("/");
    if (i < 0) return ".";
    return i === 0 ? "/" : t.slice(0, i).replace(/\/+$/, "") || "/";
  };
  const extname = (p: string): string => (assertString(p), extOf(basename(p)));
  const relative = (from: string, to: string): string => {
    assertString(from, "from");
    assertString(to, "to");
    const a = resolve(from).split("/").filter(Boolean);
    const b = resolve(to).split("/").filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
  };
  const parse = (p: string): ParsedPath => {
    assertString(p);
    const root = p.startsWith("/") ? "/" : "";
    const base = basename(p);
    const t = trimmed(p);
    const idx = t.lastIndexOf("/");
    const dir = t === "/" ? "/" : idx < 0 ? "" : idx === 0 ? "/" : t.slice(0, idx);
    const ext = extOf(base);
    return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
  };
  const format = (o: Partial<ParsedPath>): string => {
    const base = o.base || `${o.name ?? ""}${o.ext ?? ""}`;
    const dir = o.dir || o.root || "";
    if (!dir) return base;
    return dir === o.root ? `${dir}${base}` : `${dir}/${base}`;
  };
  const mod: PathModule = {
    sep: "/",
    delimiter: ":",
    normalize,
    join,
    resolve,
    relative,
    dirname,
    basename,
    extname,
    parse,
    format,
    isAbsolute,
    toNamespacedPath: (p) => p,
    posix: undefined as unknown as PathModule,
    win32: undefined as unknown as PathModule,
  };
  return mod;
}

const isSepW = (c: string | undefined): boolean => c === "/" || c === "\\";

interface WinRoot {
  /** `C:` or `\\server\share` ("" when none). */
  device: string;
  /** Has a root separator after the device (or a bare leading separator). */
  abs: boolean;
  /** Length of the consumed root text. */
  end: number;
}

function winRoot(p: string): WinRoot {
  if (isSepW(p[0]) && isSepW(p[1])) {
    // UNC: \\server\share
    let i = 2;
    while (i < p.length && !isSepW(p[i])) i++;
    const server = p.slice(2, i);
    if (server && i < p.length) {
      let j = i + 1;
      while (j < p.length && isSepW(p[j])) j++;
      let k = j;
      while (k < p.length && !isSepW(p[k])) k++;
      if (k > j) return { device: `\\\\${server}\\${p.slice(j, k)}`, abs: true, end: k };
    }
  }
  if (/^[A-Za-z]:/.test(p))
    return { device: p.slice(0, 2), abs: isSepW(p[2]), end: isSepW(p[2]) ? 3 : 2 };
  if (isSepW(p[0])) return { device: "", abs: true, end: 1 };
  return { device: "", abs: false, end: 0 };
}

function makeWin32(cwd: () => string): PathModule {
  const normalize = (p: string): string => {
    assertString(p);
    if (p === "") return ".";
    const r = winRoot(p);
    const tail = p.slice(r.end);
    const trailing = isSepW(p[p.length - 1]);
    const body = collapse(tail.split(/[\\/]/), !r.abs).join("\\");
    const rootText = r.device + (r.abs ? "\\" : "");
    if (body === "") return rootText || (trailing ? ".\\" : ".");
    return rootText + body + (trailing ? "\\" : "");
  };
  const join = (...parts: string[]): string => {
    parts.forEach((p) => assertString(p));
    const j = parts.filter((p) => p !== "").join("\\");
    return j === "" ? "." : normalize(j);
  };
  const resolve = (...parts: string[]): string => {
    let device = "";
    let tail = "";
    let abs = false;
    for (let i = parts.length - 1; i >= -1; i--) {
      const seg = i >= 0 ? parts[i] : cwd();
      assertString(seg);
      if (seg === "") continue;
      const r = winRoot(seg);
      if (r.device && device && r.device.toLowerCase() !== device.toLowerCase()) continue;
      if (!device && r.device) device = r.device;
      const rest = seg.slice(r.end);
      if (!abs) {
        tail = rest === "" ? tail : tail === "" ? rest : `${rest}\\${tail}`;
        abs = r.abs;
      }
      if (abs && device) break;
    }
    const body = collapse(tail.split(/[\\/]/), !abs).join("\\");
    const out = device + (abs ? "\\" : "") + body;
    return out || ".";
  };
  const trimmedW = (p: string): string => {
    const r = winRoot(p);
    let end = p.length;
    while (end > r.end && isSepW(p[end - 1])) end--;
    return p.slice(0, end);
  };
  const basename = (p: string, ext?: string): string => {
    assertString(p);
    const r = winRoot(p);
    const t = trimmedW(p).slice(r.device.startsWith("\\\\") ? r.end : /^[A-Za-z]:/.test(p) ? 2 : 0);
    const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
    return stripExt(t.slice(i + 1), ext);
  };
  const dirname = (p: string): string => {
    assertString(p);
    if (p === "") return ".";
    const r = winRoot(p);
    const t = trimmedW(p);
    const rest = t.slice(r.end);
    const i = Math.max(rest.lastIndexOf("\\"), rest.lastIndexOf("/"));
    const rootText = p.slice(0, r.end);
    if (i < 0) return rootText || ".";
    return rootText + rest.slice(0, i).replace(/[\\/]+$/, "");
  };
  const relative = (from: string, to: string): string => {
    assertString(from, "from");
    assertString(to, "to");
    const f = resolve(from);
    const t = resolve(to);
    if (f.toLowerCase() === t.toLowerCase()) return "";
    const rf = winRoot(f);
    const rt = winRoot(t);
    if (rf.device.toLowerCase() !== rt.device.toLowerCase()) return t;
    const a = f.slice(rf.end).split("\\").filter(Boolean);
    const b = t.slice(rt.end).split("\\").filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
    return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("\\");
  };
  const parse = (p: string): ParsedPath => {
    assertString(p);
    const r = winRoot(p);
    const root = p.slice(0, r.end);
    const base = basename(p);
    const ext = extOf(base);
    const dir = dirname(p);
    return {
      root,
      dir: dir === "." && !p.includes("\\") && !p.includes("/") ? "" : dir,
      base,
      ext,
      name: ext ? base.slice(0, -ext.length) : base,
    };
  };
  const format = (o: Partial<ParsedPath>): string => {
    const base = o.base || `${o.name ?? ""}${o.ext ?? ""}`;
    const dir = o.dir || o.root || "";
    if (!dir) return base;
    return dir === o.root ? `${dir}${base}` : `${dir}\\${base}`;
  };
  return {
    sep: "\\",
    delimiter: ";",
    normalize,
    join,
    resolve,
    relative,
    dirname,
    basename,
    extname: (p) => (assertString(p), extOf(basename(p))),
    parse,
    format,
    isAbsolute: (p) => (assertString(p), winRoot(p).abs),
    toNamespacedPath: (p) => p,
    posix: undefined as unknown as PathModule,
    win32: undefined as unknown as PathModule,
  };
}

const cwd = (): string => getBasePath();
export const posix = makePosix(cwd);
export const win32 = makeWin32(cwd);
posix.posix = posix;
posix.win32 = win32;
win32.posix = posix;
win32.win32 = win32;

/** The `path` module (POSIX flavour; Writer targets macOS/Linux, `path.win32` is available). */
export const pathModule: PathModule = posix;
