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
  /** Tags, missing notes and other secondary things. */
  muted: string;
  background: string;
}

export const FALLBACK_THEME: GraphTheme = {
  accent: "#7c6af7",
  edge: "#9a9aa4",
  edgeStrong: "#5f5f6b",
  label: "#4a4a55",
  muted: "#a0a0aa",
  background: "#ffffff",
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
  muted: "--text-icon-muted",
  background: "--surface-primary",
};

/** Resolve the theme variables on `el` to concrete colors. Falls back per color when the browser
 *  gives nothing usable (an unset variable, a test DOM). */
export function readTheme(el: HTMLElement): GraphTheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  el.appendChild(probe);
  try {
    const out = { ...FALLBACK_THEME };
    for (const key of Object.keys(VARS) as (keyof GraphTheme)[]) {
      probe.style.color = `var(${VARS[key]})`;
      const c = getComputedStyle(probe).color;
      if (/^(rgb|#)/i.test(c)) out[key] = c;
    }
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
