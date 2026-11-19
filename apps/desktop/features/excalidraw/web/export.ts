// The window's answer to `writer excalidraw:export` (the socket command in `rust/ipc.rs`): write
// `<name>.svg` next to the drawing and answer with its path, which Rust reduces to the one
// vault-relative path. Lazy: this and the exporter load on the first request.
import { exportSvgFile } from "./lib/export-svg";

export async function handleExport(payload: unknown): Promise<{ path: string }> {
  const path = (payload as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || path === "") throw new Error("no drawing path");
  return { path: await exportSvgFile(path) };
}
