// Path helpers for Bases. Tabs and editor state hold absolute paths; query results and
// `index://changed` carry vault-relative ones.

/** `relative` (vault-relative, forward slashes) under `root`. */
export function toAbsolutePath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${relative.replace(/^[\\/]+/, "")}`;
}

/** `absolute` relative to `root` with forward slashes, or `null` when it is outside `root`. */
export function toRelativePath(root: string, absolute: string): string | null {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = absolute.replace(/\\/g, "/");
  return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : null;
}
