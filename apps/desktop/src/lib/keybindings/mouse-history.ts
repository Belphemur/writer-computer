// The mouse side buttons as history back / forward. macOS drivers send Cmd+[ / Cmd+] for them (the
// `history-back` / `history-forward` bindings); on Linux and Windows the page gets the buttons
// themselves, `MouseEvent.button` 3 (back) and 4 (forward), and runs the same store actions.
import type { Platform } from "@/lib/platform";

export type HistoryDirection = "back" | "forward";

/** What a mouse button does on `platform`, or null when it is not a history button here. */
export function mouseHistoryDirection(button: number, platform: Platform): HistoryDirection | null {
  if (platform === "macos") return null;
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return null;
}
