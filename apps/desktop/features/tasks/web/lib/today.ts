/** The user's local day as `YYYY-MM-DD`: the day every task write is relative to (Rust never
 *  guesses the time zone from the webview). */
export function localToday(now: Date = new Date()): string {
  const y = String(now.getFullYear()).padStart(4, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
