// External links from plugin UI. Electron plugins call `window.open(url, "_blank")` and render
// `<a href target="_blank">`; the Tauri webview ignores the first (returns null) and would navigate
// the app window away for the second. While a plugin is loaded both go to the system browser
// through the SAME implementation as `electron.shell.openExternal` (http, https, mailto only).
import { EXTERNAL_PROTOCOLS } from "@/lib/external-url";
import { bindLinkActivation } from "@/lib/link-activation";
import { recordPluginError } from "../error-log";
import { electronModule } from "./misc";

const externalUrl = (raw: unknown, base: string): string | null => {
  try {
    const u = new URL(String(raw), base);
    return EXTERNAL_PROTOCOLS.has(u.protocol) &&
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

/** Opens `raw` in the system browser when it is an http(s) or mailto URL; false (and nothing
 *  happens) for anything else. Same implementation as the document click handler below. */
export function openExternalUrl(raw: string, base: string = document.baseURI): boolean {
  const url = externalUrl(raw, base);
  if (!url) return false;
  open(url);
  return true;
}

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

  // Bubble phase (`bindLinkActivation` skips a handled event): a plugin that handled the click
  // itself (React, preventDefault) wins. Middle and Cmd/Ctrl clicks reach the browser too.
  const off = bindLinkActivation(doc.documentElement, (el) => {
    const url = externalUrl(el.closest("a[href]")?.getAttribute("href"), doc.baseURI);
    return url ? { kind: "custom", open: () => open(url) } : null;
  });
  return () => {
    off();
    if (win.open === patched) win.open = originalOpen;
  };
}
