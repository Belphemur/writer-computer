// External links from plugin UI. Electron plugins call `window.open(url, "_blank")` and render
// `<a href target="_blank">`; the Tauri webview ignores the first (returns null) and would navigate
// the app window away for the second. While a plugin is loaded both go to the system browser
// through the SAME implementation as `electron.shell.openExternal` (http, https, mailto only).
import { recordPluginError } from "../error-log";
import { electronModule } from "./misc";

const OPENABLE = new Set(["http:", "https:", "mailto:"]);

const externalUrl = (raw: unknown, base: string): string | null => {
  try {
    const u = new URL(String(raw), base);
    return OPENABLE.has(u.protocol) &&
      !(u.origin === new URL(base).origin && u.protocol !== "mailto:")
      ? u.href
      : null;
  } catch {
    return null;
  }
};

const open = (url: string): void => {
  electronModule.shell.openExternal(url).catch((e: unknown) => {
    console.error("[plugin] could not open the system browser:", e);
    recordPluginError("host", "open-external", e);
  });
};

/** Installs the `window.open` override and a document click handler; returns the remover. */
export function installExternalLinks(win: Window & typeof globalThis = window): () => void {
  const doc = win.document;
  const originalOpen = win.open;
  const patched = function (this: unknown, url?: string | URL, ...rest: unknown[]) {
    const target = url === undefined ? null : externalUrl(url, doc.baseURI);
    if (target) {
      open(target);
      return null;
    }
    return (originalOpen as (...a: unknown[]) => Window | null).call(win, url, ...rest);
  } as typeof win.open;
  win.open = patched;

  const onClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!a) return;
    const url = externalUrl(a.getAttribute("href"), doc.baseURI);
    if (!url) return;
    e.preventDefault();
    open(url);
  };
  // Bubble phase: a plugin that handled the click itself (React, preventDefault) wins.
  doc.addEventListener("click", onClick);
  return () => {
    doc.removeEventListener("click", onClick);
    if (win.open === patched) win.open = originalOpen;
  };
}
