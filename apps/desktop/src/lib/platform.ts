export type Platform = "macos" | "windows" | "linux";

/** Detect the desktop platform from the webview user agent. */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  return "linux";
}

/** Room the window chrome reserves for what the platform draws in the title row, in CSS px. */
export type ChromeInset = { start: number; end: number };

/** macOS: the traffic lights sit at the left. */
const TRAFFIC_LIGHT_INSET = 92;

/** Linux chrome sizes, in px. The components draw with these and `chromeInset` sums them, so the
 *  space reserved for the menu button and the window controls is exactly what they take. */
export const MENU_BUTTON = { edge: 12, width: 32, gap: 8 } as const;
export const WINDOW_CONTROLS = { count: 3, buttonWidth: 36, edge: 8 } as const;

const MENU_BUTTON_INSET = MENU_BUTTON.edge + MENU_BUTTON.width + MENU_BUTTON.gap;
const WINDOW_CONTROLS_INSET =
  WINDOW_CONTROLS.count * WINDOW_CONTROLS.buttonWidth + WINDOW_CONTROLS.edge;

/** Whether Writer draws its own minimize, maximize and close: Linux without the desktop's frame. */
export function drawsWindowControls(
  platform: Platform = detectPlatform(),
  nativeDecorations = false,
): boolean {
  return platform === "linux" && !nativeDecorations;
}

/** The one source of the chrome inset (ADR 2026-11-20): the layouts and the tab strip read it, so
 *  no component hard-codes a platform's gap. */
export function chromeInset(
  platform: Platform = detectPlatform(),
  nativeDecorations = false,
): ChromeInset {
  if (platform === "macos") return { start: TRAFFIC_LIGHT_INSET, end: 0 };
  if (platform === "linux") {
    return {
      start: MENU_BUTTON_INSET,
      end: drawsWindowControls(platform, nativeDecorations) ? WINDOW_CONTROLS_INSET : 0,
    };
  }
  return { start: 0, end: 0 };
}

/** Marks the root with the platform once, so CSS can branch on it (`:root[data-platform="linux"]`). */
export function installPlatformAttribute(platform: Platform = detectPlatform()) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-platform", platform);
}
