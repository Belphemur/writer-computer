// Tabs and editor state hold absolute paths; the index and the graph hold vault-relative ones.

/** `absolute` relative to `root` with forward slashes, or null when it is outside `root`. */
export function toRelativePath(root: string, absolute: string): string | null {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = absolute.replace(/\\/g, "/");
  return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : null;
}
