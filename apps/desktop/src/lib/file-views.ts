// Which plugin view, if any, opens a workspace file. The page-kind registry asks this (sync, so a
// path can be routed anywhere) and the plugins store answers while a plugin host is attached: a
// registered file extension, or a note the plugins redirect into their own view. With no host (no
// workspace, restricted vault, plugins off) nothing is claimed and the text editor opens the file.
export type FileViewResolver = (path: string) => string | null;

let resolver: FileViewResolver | null = null;

/** Installs (or with null removes) the resolver; the plugins store owns it. A resolver must not
 *  throw: the host's wraps plugin code and records the error, so a misbehaving plugin patch
 *  cannot make a file unopenable. */
export function setFileViewResolver(next: FileViewResolver | null): void {
  resolver = next;
}

/** Removes `fn` if it is still the installed resolver (a newer host may have replaced it). */
export function clearFileViewResolver(fn: FileViewResolver): void {
  if (resolver === fn) resolver = null;
}

/** The registered plugin view type that opens `path`, or null for the text editor. */
export function resolveFileView(path: string): string | null {
  return resolver ? resolver(path) : null;
}
