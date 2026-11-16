// "Open log folder" and "Copy recent errors": one implementation for the command palette and
// the Settings > Logs block. The lines come from the local log files, already redacted by Rust.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as tauri from "@/lib/tauri";

export const RECENT_ERROR_LINES = 200;

/** Copies the newest error and warn lines; returns how many (0 leaves the clipboard alone). */
export async function copyRecentErrors(): Promise<number> {
  const lines = await tauri.recentLogErrors(RECENT_ERROR_LINES);
  if (lines.length === 0) return 0;
  await writeText(lines.join("\n"));
  return lines.length;
}

export function openLogFolder(): Promise<void> {
  return tauri.openLogFolder();
}

/** The outcome as a sentence for a notice. */
export function copyResultMessage(count: number): string {
  return count === 0 ? "No recent errors or warnings in the logs." : `Copied ${count} log lines.`;
}
