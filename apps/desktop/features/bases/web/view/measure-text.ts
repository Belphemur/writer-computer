import type { Measure, MeasureKind } from "../lib/fit-width";

// Sizes and weights mirror the classes in base-table.tsx / cell-view.tsx.
const SPECS: Record<MeasureKind, { size: number; weight: number }> = {
  header: { size: 12, weight: 500 },
  cell: { size: 13, weight: 400 },
  chip: { size: 11, weight: 400 },
  summary: { size: 11, weight: 400 },
  "summary-value": { size: 11, weight: 500 },
  tag: { size: 10, weight: 400 },
};

/**
 * Canvas text measurer using the font family the real cells use (computed style of a rendered
 * cell, else of the grid). Without a canvas (jsdom) it falls back to a per-character estimate.
 */
export function createMeasure(grid: HTMLElement): Measure {
  const sample = grid.querySelector<HTMLElement>("[data-cell-type]") ?? grid;
  const style = getComputedStyle(sample);
  const family = style.fontFamily || "sans-serif";
  const ctx = document.createElement("canvas").getContext("2d");
  return (text, kind) => {
    const { size, weight } = SPECS[kind];
    if (!ctx) return text.length * size * 0.55;
    ctx.font = `${weight} ${size}px ${family}`;
    return ctx.measureText(text).width;
  };
}
