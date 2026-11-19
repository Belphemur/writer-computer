// The app's own keyboard shortcuts, as data. Adding one is one entry here (and its row in
// docs/keyboard-shortcuts.md: `tests/keybindings.test.ts` fails when the two disagree). The
// handlers read store state at event time, as the old `if` chain did. A binding id equal to a
// palette command id makes the palette show the key (`shortcutFor`), so the two cannot drift.
import { toggleSidebar } from "@/hooks/use-sidebar";
import { resetZoom, zoomIn, zoomOut } from "@/hooks/zoom-api";
import { closeWindow } from "@/lib/tauri";
import { useEditorStore } from "@/stores/editor-store";
import { useUIStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { keybindings, type Keybinding } from "./registry";
import { isCompactFileMode } from "./when";

const digits = (prefix: string) => Array.from({ length: 9 }, (_, i) => `${prefix}${i + 1}`);
const hasRoot = () => useWorkspaceStore.getState().root !== null;
const openPalette = (mode: "search" | "search-notes" | "create-file") =>
  useUIStore.getState().openCommandPalette(mode);

function cycleTab(direction: 1 | -1) {
  const { tabs, activeTabId, setActiveTab } = useEditorStore.getState();
  if (tabs.length === 0 || !activeTabId) return;
  const idx = tabs.findIndex((tab) => tab.id === activeTabId);
  if (idx === -1) return;
  setActiveTab(tabs[(idx + direction + tabs.length) % tabs.length]!.id);
}

export const CORE_BINDINGS: readonly Keybinding[] = [
  {
    id: "reopen-closed-tab",
    keys: ["Mod+Shift+T"],
    description: "Reopen the last closed tab",
    category: "Tabs",
    layoutIndependent: true,
    run: () => {
      if (!isCompactFileMode()) void useEditorStore.getState().reopenClosedTab();
    },
  },
  {
    // Inside the editor, Alt+Arrow is CodeMirror's word-wise cursor motion.
    id: "navigate-back",
    keys: ["Alt+ArrowLeft"],
    description: "Navigate back (outside the note)",
    category: "Navigation",
    when: "editor-not-focused",
    run: () => void useEditorStore.getState().navigateBack(),
  },
  {
    id: "navigate-forward",
    keys: ["Alt+ArrowRight"],
    description: "Navigate forward (outside the note)",
    category: "Navigation",
    when: "editor-not-focused",
    run: () => void useEditorStore.getState().navigateForward(),
  },
  {
    id: "command-palette",
    keys: ["Mod+P"],
    description: "Command palette",
    category: "Navigation",
    run: () => {
      if (hasRoot()) openPalette("search");
    },
  },
  {
    id: "command-palette-anywhere",
    keys: ["Mod+Shift+P"],
    description: "Command palette, also when no workspace is open",
    category: "Navigation",
    run: () => openPalette("search"),
  },
  {
    id: "go-to-file",
    keys: ["Mod+O"],
    description: "Go to file (same as the command palette)",
    category: "Navigation",
    run: () => {
      if (hasRoot()) openPalette("search");
    },
  },
  {
    id: "search-notes",
    keys: ["Mod+Shift+F"],
    description: "Search in notes",
    category: "Navigation",
    run: () => {
      if (hasRoot() && !isCompactFileMode()) openPalette("search-notes");
    },
  },
  {
    // Not in the compact window: the key falls through (no preventDefault) as it always did.
    // Once the launcher is the only tab left there is nothing to close (closing it would just
    // recreate it), so the window closes; Rust turns that into a hide for the main window.
    // Any other tab, Settings included, closes like a file tab.
    id: "close-tab",
    keys: ["Mod+W"],
    description: "Close the current tab; hides the window when only an empty new tab is left",
    category: "Tabs",
    when: "not-compact",
    run: () => {
      const { tabs, activeTabId, closeActiveTab } = useEditorStore.getState();
      const onlyLauncherLeft = tabs.every((tab) => tab.location.kind === "launcher");
      if (onlyLauncherLeft && tabs.length <= 1) {
        void closeWindow();
        return;
      }
      if (activeTabId) closeActiveTab();
    },
  },
  {
    id: "toggle-sidebar",
    keys: ["Mod+\\"],
    description: "Toggle sidebar",
    category: "View",
    run: () => {
      if (!isCompactFileMode()) toggleSidebar();
    },
  },
  {
    id: "new-file",
    keys: ["Mod+N"],
    description: "Create new note",
    category: "Navigation",
    run: () => {
      if (hasRoot()) openPalette("create-file");
    },
  },
  {
    id: "new-tab",
    keys: ["Mod+T"],
    description: "New tab",
    category: "Tabs",
    run: () => {
      if (!isCompactFileMode() && hasRoot()) useEditorStore.getState().openNewTab();
    },
  },
  {
    id: "next-tab",
    keys: ["Ctrl+Tab"],
    description: "Next tab",
    category: "Tabs",
    run: () => {
      if (!isCompactFileMode()) cycleTab(1);
    },
  },
  {
    id: "previous-tab",
    keys: ["Ctrl+Shift+Tab"],
    description: "Previous tab",
    category: "Tabs",
    run: () => {
      if (!isCompactFileMode()) cycleTab(-1);
    },
  },
  // Editor text zoom (a percent on top of Font Size), so it needs no workspace and compact windows
  // take it too (an image tab's viewer has the same chords, `features/images`). Alt chords are left alone: Cmd+Alt+0 is the editor's "strip heading".
  {
    id: "zoom-in",
    when: "no-image-viewer",
    keys: ["Mod+=", "Mod++"],
    description: "Zoom editor text in",
    category: "View",
    looseShift: true,
    physicalKeys: ["NumpadAdd"],
    run: () => zoomIn(),
  },
  {
    id: "zoom-out",
    when: "no-image-viewer",
    keys: ["Mod+-"],
    description: "Zoom editor text out",
    category: "View",
    looseShift: true,
    alsoKeys: ["_"],
    physicalKeys: ["NumpadSubtract"],
    run: () => zoomOut(),
  },
  {
    id: "zoom-reset",
    when: "no-image-viewer",
    keys: ["Mod+0"],
    description: "Actual size",
    category: "View",
    looseShift: true,
    physicalKeys: ["Digit0", "Numpad0"],
    run: () => resetZoom(),
  },
  {
    id: "jump-to-tab",
    keys: digits("Mod+"),
    description: "Jump to Nth tab",
    category: "Tabs",
    rebindable: false, // `run` reads the digit from the key
    run: (e) => {
      if (isCompactFileMode()) return;
      const { tabs, setActiveTab } = useEditorStore.getState();
      const tab = tabs[parseInt(e.key) - 1];
      if (tab) setActiveTab(tab.id);
    },
  },
  // Cmd+[ / Cmd+] are history back / forward everywhere, the note included (what mouse drivers send
  // for the side buttons). Capture phase, so it wins over CodeMirror's indent bindings (Tab and
  // Shift-Tab still indent); the agent pane keeps them for its chat switcher.
  {
    id: "history-back",
    keys: ["Meta+["],
    description: "Navigate back, everywhere including the note",
    category: "Navigation",
    phase: "capture",
    when: "outside-agent-pane",
    run: (e) => {
      if (!e.repeat) void useEditorStore.getState().navigateBack();
    },
  },
  {
    id: "history-forward",
    keys: ["Meta+]"],
    description: "Navigate forward, everywhere including the note",
    category: "Navigation",
    phase: "capture",
    when: "outside-agent-pane",
    run: (e) => {
      if (!e.repeat) void useEditorStore.getState().navigateForward();
    },
  },
];

for (const binding of CORE_BINDINGS) keybindings.add("core", binding);
