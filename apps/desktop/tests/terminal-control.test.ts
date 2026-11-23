import { describe, expect, test } from "vite-plus/test";
import { terminalSelection } from "../src/components/settings-panel/terminal-control";
import type { TerminalInfo } from "../src/lib/tauri";

const found: TerminalInfo[] = [
  { id: "ghostty", label: "Ghostty", names: ["ghostty", "Ghostty"] },
  { id: "iterm2", label: "iTerm2", names: ["iterm2", "iTerm2", "iTerm"] },
];

describe("terminalSelection", () => {
  test("blank is the system default", () => {
    expect(terminalSelection("", found)).toBe("");
    expect(terminalSelection("  ", found)).toBe("");
  });

  test("an older stored name selects its terminal, case-insensitively", () => {
    expect(terminalSelection("Ghostty", found)).toBe("ghostty");
    expect(terminalSelection("iterm", found)).toBe("iterm2");
  });

  test("a name or path that is not in the found list is Other", () => {
    const other = terminalSelection("/opt/term/bin/myterm", found);
    expect(other).not.toBe("");
    expect(found.map((t) => t.id)).not.toContain(other);
    expect(terminalSelection("kitty", found)).toBe(other);
    expect(terminalSelection("ghostty", [])).toBe(other);
  });
});
