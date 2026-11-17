// Side effects of the Results menu: clipboard and CSV export. Kept out of the component so they
// can be exercised with mocked Tauri plugins.
import { save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { resultToCsv, resultToMarkdown } from "../lib/export";
import type { BaseQueryResult } from "../lib/types";
import * as tauri from "@/lib/tauri";

/** Copy the shown rows as a markdown table. Resolves to the number of rows copied. */
export async function copyResultsAsMarkdown(
  result: BaseQueryResult,
  shown: number,
): Promise<number> {
  await writeText(resultToMarkdown(result, shown));
  return result.rows.length;
}

/**
 * Export the shown rows as CSV: the save dialog picks the file (starting in `startDir`), the app's
 * file write path writes it. Resolves to the saved path, or `null` when the dialog was cancelled.
 * Rejects when the write fails (the write path only accepts paths inside the workspace).
 */
export async function exportResultsAsCsv(
  result: BaseQueryResult,
  shown: number,
  suggestedName: string,
  startDir: string | null,
): Promise<string | null> {
  const defaultPath = startDir
    ? `${startDir.replace(/[\\/]+$/, "")}/${suggestedName}`
    : suggestedName;
  const path = await save({ defaultPath, filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (path === null) return null;
  await tauri.writeFile(path, resultToCsv(result, shown));
  return path;
}
