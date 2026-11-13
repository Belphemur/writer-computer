// Adapted from opensidian (GPL-3.0-or-later).
// The tiny Node surface plugins may `require`: a working POSIX `path`, an `fs` that throws,
// and a minimal `process`. Everything else is refused by the loader with a clear error.

const stripTrailing = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

function normalize(p: string): string {
  if (p === "") return ".";
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
    } else out.push(part);
  }
  const joined = out.join("/");
  const trailing = p.endsWith("/") && joined !== "";
  const res = (abs ? "/" : "") + joined + (trailing ? "/" : "");
  return res === "" ? "." : res;
}

function basename(p: string, ext?: string): string {
  const base = stripTrailing(p).slice(stripTrailing(p).lastIndexOf("/") + 1);
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}

function dirname(p: string): string {
  const s = stripTrailing(p);
  const i = s.lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : s.slice(0, i);
}

function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i);
}

function join(...parts: string[]): string {
  const j = parts.filter((p) => p !== "").join("/");
  return j === "" ? "." : normalize(j);
}

function resolve(...parts: string[]): string {
  let acc = "";
  for (let i = parts.length - 1; i >= 0 && !acc.startsWith("/"); i--)
    if (parts[i]) acc = acc ? `${parts[i]}/${acc}` : parts[i];
  const n = normalize(acc.startsWith("/") ? acc : `/${acc}`);
  return stripTrailing(n);
}

function relative(from: string, to: string): string {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

function parse(p: string): { root: string; dir: string; base: string; ext: string; name: string } {
  const base = basename(p);
  const ext = extname(p);
  const d = dirname(p);
  return {
    root: p.startsWith("/") ? "/" : "",
    dir: d === "." && !p.includes("/") ? "" : d,
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
}

function format(o: {
  dir?: string;
  root?: string;
  base?: string;
  name?: string;
  ext?: string;
}): string {
  const base = o.base ?? `${o.name ?? ""}${o.ext ?? ""}`;
  const dir = o.dir ?? o.root ?? "";
  return dir ? (dir === o.root ? `${dir}${base}` : `${dir}/${base}`) : base;
}

const posix = {
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
  isAbsolute: (p: string): boolean => p.startsWith("/"),
  toNamespacedPath: (p: string): string => p,
};

export const pathShim = Object.freeze({ ...posix, posix, win32: posix });

/** Any member is a function that throws when called, so `const { readFileSync } = require("fs")` still loads. */
function throwingModule(name: string): Record<string, unknown> {
  const fail = (member: string) => (): never => {
    throw new Error(
      `${name}.${member}() is not supported in Writer: plugins have no direct file system access`,
    );
  };
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "__esModule") return false;
      if (prop === "default") return undefined;
      if (typeof prop === "symbol") return undefined;
      return fail(prop);
    },
    has: () => true,
  });
}

export const fsShim = throwingModule("fs");
export const fsPromisesShim = throwingModule("fs/promises");

export function createProcessShim(): Record<string, unknown> {
  return {
    env: {},
    argv: [],
    platform: "darwin",
    arch: "arm64",
    version: "v0.0.0",
    // No `versions.node`: plugins use it to detect a real Node, which this is not.
    versions: {},
    pid: 0,
    title: "writer",
    exitCode: undefined,
    browser: true,
    cwd: () => "/",
    nextTick: (cb: (...a: unknown[]) => void, ...args: unknown[]): void => {
      queueMicrotask(() => cb(...args));
    },
    hrtime: Object.assign(() => [0, 0], { bigint: () => BigInt(0) }),
    emitWarning: () => {},
    on: () => {},
    off: () => {},
    once: () => {},
    emit: () => false,
  };
}
