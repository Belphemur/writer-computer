// Results menu output: the shown rows as a markdown table or CSV. Pure strings from the engine's
// display text; hidden extra columns never appear.
import type { BaseQueryResult } from "./types";

function shownCols(result: BaseQueryResult, shown: number | undefined): number {
  return shown === undefined ? result.columns.length : Math.min(shown, result.columns.length);
}

const mdCell = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** GitHub-style table: header row, separator, one row per shown row (group order, limit applied). */
export function resultToMarkdown(result: BaseQueryResult, shown?: number): string {
  const n = shownCols(result, shown);
  const header = result.columns.slice(0, n).map((c) => mdCell(c.displayName));
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...result.rows.map(
      (r) =>
        `| ${r.cells
          .slice(0, n)
          .map((c) => mdCell(c.display))
          .join(" | ")} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 quoting, `\n` line ends (a trailing newline), header row of display names. */
export function resultToCsv(result: BaseQueryResult, shown?: number): string {
  const n = shownCols(result, shown);
  const rows = [
    result.columns.slice(0, n).map((c) => c.displayName),
    ...result.rows.map((r) => r.cells.slice(0, n).map((c) => c.display)),
  ];
  return `${rows.map((r) => r.map(csvField).join(",")).join("\n")}\n`;
}
