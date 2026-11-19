// The window's answer to `writer excalidraw:export` and `excalidraw:preview` (the socket commands
// in `rust/ipc.rs`, topic `excalidraw:render`): draw the drawing as it is on disk (an open tab
// saves first) as an SVG or a PNG and answer with the image. Rust writes the file (the socket
// carries no image, and only Rust knows where it may go), so this returns data, never a path:
// the markup for an SVG, base64 for a PNG. Lazy: this and the exporter load on the first request.
import * as tauri from "@/lib/tauri";
import { renderPng, renderSvg } from "./lib/export-svg";
import { flushLiveView } from "./lib/live-views";

export interface Rendered {
  format: "png" | "svg";
  data: string;
}

/** A blob as base64, without the data-URL prefix. */
async function base64Of(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("could not read the image"));
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

export async function handleRender(payload: unknown): Promise<Rendered> {
  const { path, format, scale } = (payload ?? {}) as {
    path?: unknown;
    format?: unknown;
    scale?: unknown;
  };
  if (typeof path !== "string" || path === "") throw new Error("no drawing path");
  if (format !== "png" && format !== "svg") throw new Error("format is png or svg");
  await flushLiveView(path);
  const text = (await tauri.readFile(path)).content;
  if (format === "svg") return { format, data: await renderSvg(path, text) };
  const s = typeof scale === "number" && scale > 0 ? scale : 1;
  return { format, data: await base64Of(await renderPng(path, text, s)) };
}
