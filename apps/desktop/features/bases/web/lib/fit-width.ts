// Fit-to-content width of a table column (double-click on a column divider). Pure: text is
// measured through an injected `Measure`, so the DOM/canvas measurer lives in the component.
import { itemText } from "./cells";
import { MIN_COLUMN_WIDTH } from "./grid";
import type { Cell } from "./types";

/** Largest width a fit produces (px). Manual drags may still go up to `MAX_COLUMN_WIDTH`. */
export const FIT_MAX_COLUMN_WIDTH = 800;
/** Horizontal padding (`px-2` = 8 + 8) plus the 1px right border of a header, cell or summary. */
export const CELL_CHROME = 17;
/**
 * Work cap. Every row's text length is computed (cheap, O(rows)); only the `FIT_MEASURE_LIMIT`
 * longest texts are measured, since in proportional fonts the longest string is almost always
 * (or within a few px of) the widest. Rows beyond `FIT_SCAN_LIMIT` are not looked at.
 */
export const FIT_MEASURE_LIMIT = 300;
export const FIT_SCAN_LIMIT = 50_000;

/** Which font a text is drawn in: header label, cell body, list chip, summary text, group tag. */
export type MeasureKind = "header" | "cell" | "chip" | "summary" | "summary-value" | "tag";
export type Measure = (text: string, kind: MeasureKind) => number;

const CHECKBOX_WIDTH = 14;
const CHIP_CHROME = 16 + 4; // chip padding + gap between chips
const SORT_GAP = 4; // `gap-1` between header parts
const SUMMARY_GAP = 6; // `gap-1.5` between summary label and value

interface Piece {
  /** Rough length used only to pick which cells to measure. */
  weight: number;
  width: (measure: Measure) => number;
}

/** What one cell draws, as measurable pieces (text in its font, plus fixed-size parts). */
function cellPiece(cell: Cell): Piece | null {
  switch (cell.type) {
    case "null":
      return null;
    case "boolean":
      return { weight: 2, width: () => CHECKBOX_WIDTH };
    case "list": {
      const items = cell.value.map(itemText).filter((t) => t !== "");
      if (items.length === 0) return null;
      return {
        weight: items.reduce((n, t) => n + Math.min(t.length, 16) + 4, 0),
        // Chips are capped at 16ch by the renderer; the cap is applied on the measured text.
        width: (measure) =>
          items.reduce(
            (n, t) =>
              n + Math.min(measure(t, "chip"), measure("0".repeat(16), "chip")) + CHIP_CHROME,
            0,
          ) - 4,
      };
    }
    case "error":
      return {
        weight: cell.value.message.length + 8,
        width: (measure) => measure(`! Error: ${cell.value.message}`, "chip") + 12,
      };
    default:
      return cell.display === ""
        ? null
        : { weight: cell.display.length, width: (measure) => measure(cell.display, "cell") };
  }
}

export interface FitInput {
  /** Header label. */
  header: string;
  /** Sort marker text (`↑`, `↓2`) when the column is sorted. */
  sortMarker?: string;
  /** The column is the group-by column (header shows a "grouped" tag). */
  grouped?: boolean;
  /** Every row's cell for this column, in any order. */
  cells: Iterable<Cell | undefined>;
  /** Summary rows: the summary's label (`Sum`) and displayed values, if the column has one. */
  summary?: { label: string; values: readonly string[] };
  measure: Measure;
}

/** Width that shows the column's header, every cell and its summaries, clamped. */
export function fitColumnWidth(input: FitInput): number {
  const { measure } = input;
  let content = measure(input.header, "header");
  if (input.sortMarker) content += SORT_GAP + measure(input.sortMarker, "header");
  if (input.grouped) content += SORT_GAP + measure("grouped", "tag");
  let widest = content;

  if (input.summary) {
    const label = measure(input.summary.label, "summary");
    for (const v of input.summary.values)
      widest = Math.max(widest, label + SUMMARY_GAP + measure(v, "summary-value"));
  }

  // Pick the longest cells by weight, bounded in both scanned and measured count.
  const picked: Piece[] = [];
  let scanned = 0;
  for (const cell of input.cells) {
    if (++scanned > FIT_SCAN_LIMIT) break;
    const piece = cell ? cellPiece(cell) : null;
    if (!piece) continue;
    if (picked.length < FIT_MEASURE_LIMIT) {
      picked.push(piece);
      continue;
    }
    // Replace the lightest kept piece when this one is heavier (linear scan is fine at 300).
    let min = 0;
    for (let i = 1; i < picked.length; i++) if (picked[i]!.weight < picked[min]!.weight) min = i;
    if (piece.weight > picked[min]!.weight) picked[min] = piece;
  }
  for (const piece of picked) widest = Math.max(widest, piece.width(measure));

  return clampFit(widest + CELL_CHROME);
}

export function clampFit(px: number): number {
  return Math.min(FIT_MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.ceil(px)));
}
