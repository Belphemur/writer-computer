// The colors the canvas draws with. Sigma parses plain color strings (hex, rgb), not CSS variables
// or `color-mix()`, so the app's theme variables are resolved to `rgb()` once per theme change by
// asking the browser (`getComputedStyle` of a probe element). The palettes are fixed: group colors
// and property-label colors are picked by index so the same value always gets the same color.

export interface GraphTheme {
  /** Notes with no rule or group. */
  accent: string;
  /** Link edges and quiet chrome. */
  edge: string;
  edgeStrong: string;
  label: string;
  /** Text that must read (matched and hovered labels, edge lines): the primary text colour. */
  text: string;
  /** The plate behind such a label. */
  labelBackground: string;
  /** Tags, missing notes and other secondary things. */
  muted: string;
  background: string;
}

export const FALLBACK_THEME: GraphTheme = {
  accent: "#7c6af7",
  edge: "#9a9aa4",
  edgeStrong: "#5f5f6b",
  label: "#4a4a55",
  text: "#1f1f26",
  labelBackground: "#ffffff",
  muted: "#a0a0aa",
  background: "#ffffff",
};

export const DARK_FALLBACK_THEME: GraphTheme = {
  accent: "#8b7cf8",
  edge: "#6b6b76",
  edgeStrong: "#a0a0aa",
  label: "#b8b8c2",
  text: "#ececf1",
  labelBackground: "#1e1e22",
  muted: "#7a7a85",
  background: "#1e1e22",
};

/** Mid-lightness hues that read on light and dark backgrounds: the one palette of group rules and
 *  property labels. */
export const PALETTE = [
  "#5b8def",
  "#e5734f",
  "#4fb286",
  "#c065d9",
  "#e0a93b",
  "#46b1c9",
  "#d9577e",
  "#8a9a3f",
] as const;

const VARS: Record<keyof GraphTheme, string> = {
  accent: "--accent",
  edge: "--line-subtle",
  edgeStrong: "--text-muted",
  label: "--text-secondary",
  text: "--text-primary",
  labelBackground: "--surface-primary",
  muted: "--text-icon-muted",
  background: "--surface-primary",
};

/** The opaque base a translucent theme colour is composited over: the window can be translucent
 *  (macOS vibrancy) and `--surface-card` is a `color-mix()` with `transparent`, so a plate drawn in
 *  that colour on the canvas would be see-through or, unparsed, fall back to white. */
const DARK_BASE = "rgb(30, 30, 34)";
const LIGHT_BASE = "rgb(255, 255, 255)";

/** `css` (any colour the engine understands: `rgb()`, `color(srgb ...)`, `oklch()`, a resolved
 *  `color-mix()`) composited over the opaque `base` and read back as `rgb()`; null when the canvas
 *  is unavailable (a test DOM). One 1x1 canvas, reused. */
let scratch: CanvasRenderingContext2D | null | undefined;
function opaque(css: string, base: string): string | null {
  if (scratch === undefined) {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      scratch = c.getContext("2d", { willReadFrequently: true });
    } catch {
      scratch = null;
    }
  }
  if (!scratch) return null;
  scratch.globalCompositeOperation = "source-over";
  scratch.fillStyle = base;
  scratch.fillRect(0, 0, 1, 1);
  scratch.fillStyle = css;
  scratch.fillRect(0, 0, 1, 1);
  const [r, g, b] = scratch.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** Relative luminance (0..1) of an `rgb(r, g, b)` string, or null. */
function luminance(rgb: string): number | null {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(rgb);
  if (!m) return null;
  return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
}

/** Resolve the theme variables on `el` to concrete, opaque colors. A light primary text colour
 *  means a dark theme, which picks the dark base and fallbacks; the label plate is the opaque
 *  background so plates never draw white on a dark canvas. */
export function readTheme(el: HTMLElement): GraphTheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  el.appendChild(probe);
  try {
    const computed = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const textRaw = computed(VARS.text);
    const dark = (luminance(opaque(textRaw, LIGHT_BASE) ?? textRaw) ?? 0) > 0.5;
    const base = dark ? DARK_BASE : LIGHT_BASE;
    const out: GraphTheme = dark ? { ...DARK_FALLBACK_THEME } : { ...FALLBACK_THEME };
    for (const key of Object.keys(VARS) as (keyof GraphTheme)[]) {
      const raw = computed(VARS[key]);
      const c = opaque(raw, base) ?? (/^(rgb|#)/i.test(raw) ? raw : null);
      if (c) out[key] = c;
    }
    out.labelBackground = out.background;
    return out;
  } finally {
    probe.remove();
  }
}

/** A stable color for a property label: the label's rank in `labels` (sorted), wrapping. */
export function labelColor(label: string, labels: readonly string[]): string {
  const i = labels.indexOf(label);
  return PALETTE[(i === -1 ? hashString(label) : i) % PALETTE.length]!;
}

/** A stable color for a group key: its rank among `keys` (sorted), wrapping. */
export function groupColor(key: string, keys: readonly string[]): string {
  const i = keys.indexOf(key);
  return PALETTE[(i === -1 ? hashString(key) : i) % PALETTE.length]!;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
