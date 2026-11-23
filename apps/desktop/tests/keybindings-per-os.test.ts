// Default hotkeys per OS (SPECs/linux-support-spec.md "Default hotkeys per OS"): history keys, the
// mouse side buttons, no literal `Meta`/`Ctrl` where the platforms differ, and no chord a Linux
// desktop reserves. Each OS is explicit (a registry built with that platform), never the host's.
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import "../src/lib/features/builtin";
import { parseChord } from "../src/lib/keybindings/chord";
import { CORE_BINDINGS } from "../src/lib/keybindings/core-bindings";
import { mouseHistoryDirection } from "../src/lib/keybindings/mouse-history";
import {
  KeybindingRegistry,
  keybindings,
  resolveKeys,
  type OsKey,
} from "../src/lib/keybindings/registry";
import type { Platform } from "../src/lib/platform";

const key = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
const everywhere = {
  "not-compact": () => true,
  "editor-not-focused": () => true,
  "outside-agent-pane": () => true,
  "image-viewer": () => true,
  "pdf-viewer": () => true,
  "no-viewer": () => true,
};
const registryFor = (platform: Platform) => {
  const r = new KeybindingRegistry(everywhere, () => platform);
  for (const b of CORE_BINDINGS) r.add("core", b);
  return r;
};
const idFor = (r: KeybindingRegistry, e: KeyboardEvent, phase: "bubble" | "capture") =>
  r.find(e, phase)?.id;

describe("back and forward per OS", () => {
  it("macOS: Cmd+[ / Cmd+] everywhere, Alt+Arrow outside the note", () => {
    const r = registryFor("macos");
    expect(idFor(r, key({ key: "[", metaKey: true }), "capture")).toBe("history-back");
    expect(idFor(r, key({ key: "]", metaKey: true }), "capture")).toBe("history-forward");
    expect(idFor(r, key({ key: "ArrowLeft", altKey: true }), "bubble")).toBe("navigate-back");
    expect(idFor(r, key({ key: "ArrowRight", altKey: true }), "bubble")).toBe("navigate-forward");
    expect(idFor(r, key({ key: "[", ctrlKey: true }), "capture")).toBeUndefined();
    expect(r.shortcutFor("history-back")).toBe("⌘[");
  });

  it("Linux: Alt+Arrow everywhere, the note included, in the capture phase", () => {
    const r = registryFor("linux");
    expect(idFor(r, key({ key: "ArrowLeft", altKey: true }), "capture")).toBe("history-back");
    expect(idFor(r, key({ key: "ArrowRight", altKey: true }), "capture")).toBe("history-forward");
    // Ctrl+[ is not history, and nothing is left on the bubble phase for Alt+Arrow.
    expect(idFor(r, key({ key: "[", ctrlKey: true }), "capture")).toBeUndefined();
    expect(idFor(r, key({ key: "ArrowLeft", altKey: true }), "bubble")).toBeUndefined();
    expect(r.shortcutFor("history-back")).toBe("Alt+Left");
    expect(r.effectiveKeys("navigate-back")).toEqual([]);
  });

  it("Windows follows the Linux keys", () => {
    const r = registryFor("windows");
    expect(idFor(r, key({ key: "ArrowLeft", altKey: true }), "capture")).toBe("history-back");
  });

  it("the mouse side buttons are history on Linux and Windows, never on macOS", () => {
    expect(mouseHistoryDirection(3, "linux")).toBe("back");
    expect(mouseHistoryDirection(4, "linux")).toBe("forward");
    expect(mouseHistoryDirection(4, "windows")).toBe("forward");
    for (const button of [0, 1, 2, 3, 4]) {
      expect(mouseHistoryDirection(button, "macos")).toBeNull();
    }
    expect(mouseHistoryDirection(1, "linux")).toBeNull(); // the middle button stays a link button
  });
});

/** The desktop shortcut a Linux chord would collide with, or null. */
const reserved = (chord: string): string | null => {
  const c = parseChord(chord);
  const ctrl = c.mod || c.ctrl;
  if (c.meta) return "Super";
  if (ctrl && c.alt && c.key === "T") return "Ctrl+Alt+T (terminal)";
  if (ctrl && c.alt && c.key.startsWith("Arrow")) return "Ctrl+Alt+Arrow (workspaces)";
  if (ctrl && c.alt && c.key === "Delete") return "Ctrl+Alt+Delete";
  if (c.alt && c.key === "F2") return "Alt+F2";
  if (c.alt && c.key === "Tab") return "Alt+Tab";
  if (c.alt && c.key === " ") return "Alt+Space";
  return null;
};

const OSES: readonly OsKey[] = ["mac", "windows", "linux"];
// Same chord on every OS on purpose: the tab cycle is Ctrl+Tab on macOS too.
const SAME_ON_EVERY_OS = new Set(["Ctrl+Tab", "Ctrl+Shift+Tab"]);

describe("every registered binding", () => {
  const all = () => keybindings.list();

  it("names no literal Meta or Ctrl where the platforms differ", () => {
    const offenders: string[] = [];
    for (const b of all()) {
      for (const os of OSES) {
        const per = Array.isArray(b.keys) ? null : (b.keys as Record<string, unknown>);
        // `Meta` is Cmd only in the macOS list of a per-OS spec (so Ctrl+[ stays free there).
        const macListOfPerOsSpec = per !== null && os === "mac" && "mac" in per;
        for (const chord of resolveKeys(b.keys, os)) {
          const c = parseChord(chord);
          const literal = c.meta ? "Meta" : c.ctrl ? "Ctrl" : null;
          if (!literal || SAME_ON_EVERY_OS.has(chord) || macListOfPerOsSpec) continue;
          offenders.push(`${b.id} (${os}): ${chord}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives Linux no chord a desktop reserves", () => {
    const offenders = all().flatMap((b) =>
      resolveKeys(b.keys, "linux")
        .filter((chord) => reserved(chord))
        .map((chord) => `${b.id}: ${chord} (${reserved(chord)})`),
    );
    expect(offenders).toEqual([]);
  });

  it("the reserved-chord check catches every chord it lists", () => {
    // Guards the test above against becoming vacuous.
    expect(reserved("Meta+K")).toBe("Super");
    expect(reserved("Mod+Alt+T")).toContain("Ctrl+Alt+T");
    expect(reserved("Mod+Alt+ArrowLeft")).toContain("workspaces");
    expect(reserved("Ctrl+Alt+Delete")).toContain("Delete");
    expect(reserved("Alt+Tab")).toBe("Alt+Tab");
    expect(reserved("Alt+F2")).toBe("Alt+F2");
    expect(reserved("Alt+ ")).toBe("Alt+Space");
    expect(reserved("Alt+ArrowLeft")).toBeNull();
    expect(reserved("Mod+Shift+T")).toBeNull();
  });
});
