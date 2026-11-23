import type { Platform } from "@/lib/platform";

/** The oldest WebKitGTK that draws Writer: its stylesheet uses CSS nesting and `color-mix`, which
 *  arrived with WebKitGTK 2.44 (Safari 17.4). Documented in `SPECs/linux-support-spec.md`. */
export const MIN_WEBKITGTK = "2.44";

/** What the stylesheet needs, asked of the web view itself: a version string would not tell. */
const REQUIRED_CSS = [
  ["color", "color-mix(in srgb, red 50%, blue)"], // color-mix
  ["selector(&)"], // nesting
] as const;

type CssSupports = { supports(...args: string[]): boolean };

/** True when the web view understands the CSS Writer is drawn with. A runtime without `CSS` (a
 *  test, the playground's server render) counts as supported: there is nothing to warn about. */
export function webviewSupportsStyles(css: CssSupports | undefined = globalThis.CSS): boolean {
  if (!css || typeof css.supports !== "function") return true;
  return REQUIRED_CSS.every((args) => css.supports(...args));
}

/** The one-line message for an old web view, or null when it is fine. */
export function oldWebviewMessage(
  platform: Platform,
  css: CssSupports | undefined = globalThis.CSS,
): string | null {
  if (webviewSupportsStyles(css)) return null;
  return platform === "linux"
    ? `Writer needs WebKitGTK ${MIN_WEBKITGTK} or newer. Update webkit2gtk-4.1 with your package manager, then reopen Writer.`
    : "Writer needs a newer system web view. Update your operating system, then reopen Writer.";
}
