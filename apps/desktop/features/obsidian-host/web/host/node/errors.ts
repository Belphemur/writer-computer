// Node-style error construction shared by the shims.

export type NodeError = Error & {
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
  [extra: string]: unknown;
};

export function nodeError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): NodeError {
  const e = new Error(message) as NodeError;
  e.code = code;
  Object.assign(e, extra);
  return e;
}

const ERRNO: Record<string, [number, string]> = {
  ENOENT: [-2, "no such file or directory"],
  EACCES: [-13, "permission denied"],
  EPERM: [-1, "operation not permitted"],
  EEXIST: [-17, "file already exists"],
  ENOTDIR: [-20, "not a directory"],
  EISDIR: [-21, "illegal operation on a directory"],
  ENOSYS: [-38, "function not implemented"],
  EFBIG: [-27, "file too large"],
  EILSEQ: [-84, "illegal byte sequence"],
  ESTALE: [-70, "stale file: it changed on disk"],
  UNKNOWN: [-4094, "unknown error"],
};

export function errnoNumber(code: string): number {
  return (ERRNO[code] ?? ERRNO.UNKNOWN)[0];
}

/** `ENOENT: no such file or directory, stat '/x'` with code/errno/syscall/path set. */
export function errnoError(
  code: string,
  syscall: string,
  path?: string,
  detail?: string,
): NodeError {
  const [errno, text] = ERRNO[code] ?? ERRNO.UNKNOWN;
  const suffix = path === undefined ? "" : ` '${path}'`;
  const e = new Error(`${code}: ${detail ?? text}, ${syscall}${suffix}`) as NodeError;
  e.code = code;
  e.errno = errno;
  e.syscall = syscall;
  if (path !== undefined) e.path = path;
  return e;
}

export function abortError(message = "The operation was aborted"): NodeError {
  const e = new Error(message) as NodeError;
  e.name = "AbortError";
  e.code = "ABORT_ERR";
  return e;
}

export const messageOf = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
