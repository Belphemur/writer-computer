import type { Size } from "./view-transform";

// The size an SVG draws at: its `width` and `height` when they are usable (absolute units), else
// its `viewBox`. The webview reports 0 or a default for an SVG that only has a viewBox, or one with
// relative units, and a tiny declared size would make the viewer's 100% a speck.

/** CSS pixels per unit. `%`, `em`, `ex` and `rem` are relative: not usable. */
const UNITS: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

/** A declared side shorter than this on both axes counts as a placeholder, not a real size. */
const TINY = 24;

function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`(?<![\\w:.-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function length(value: string | null): number | null {
  if (!value) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value);
  const factor = m ? UNITS[m[2]!.toLowerCase()] : undefined;
  if (!m || factor === undefined) return null;
  const px = parseFloat(m[1]!) * factor;
  return px > 0 && Number.isFinite(px) ? px : null;
}

function viewBox(value: string | null): Size | null {
  if (!value) return null;
  const n = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [, , width, height] = n;
  if (n.length !== 4 || !width || !height || !(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/** The intrinsic size of the SVG in `source`, or null when it says nothing usable. */
export function svgIntrinsicSize(source: string): Size | null {
  const tag = /<svg\b[^>]*>/i.exec(source)?.[0];
  if (!tag) return null;
  const w = length(attribute(tag, "width"));
  const h = length(attribute(tag, "height"));
  const box = viewBox(attribute(tag, "viewBox"));
  if (w && h) return box && Math.max(w, h) < TINY ? box : { width: w, height: h };
  if (!box) return null;
  // one side given: the other follows the viewBox's ratio
  if (w) return { width: w, height: (w * box.height) / box.width };
  if (h) return { width: (h * box.width) / box.height, height: h };
  return box;
}
