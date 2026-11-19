// The Excalidraw feature (ADR 2026-11-18 "draw natively with a built-in Excalidraw feature
// compatible with Obsidian drawings", spec `SPECs/excalidraw-spec.md`): the drawing tab, drawings
// embedded in notes, SVG export and "New drawing". This file is loaded at startup, so it imports
// only `defineFeature`, the manifest, tiny modules and `import()` thunks: Excalidraw and
// everything that touches it live in the lazy chunks (a test pins that the startup graph never
// reaches the package).
//
// Core keeps the `drawing` page kind (`Location` is a closed union and session restore needs it
// at startup), `isDrawingPath`, and the rule that decides whether Writer or the Obsidian plugin
// opens drawings (`lib/drawing-files.ts`, answered here by the `excalidraw.files` service).
// Everything that is logic and not canvas, the codec, the commands an agent runs, the layout and
// the validation, is the Rust half (`../rust/`).
//
// Switched off: a drawing's tab shows "Excalidraw is turned off" with Turn on and Open as text,
// embeds fall back to plain wiki links, and the `writer excalidraw:*` commands say so.
import { defineFeature } from "@/lib/features/registry";
import type { CommandContribution } from "@/lib/features/types";
import { DRAWING_FILES, type DrawingFiles } from "@/lib/drawing-files";
import { useEditorStore } from "@/stores/editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import manifest from "../feature.json";
import { diskSyncListener } from "./disk-sync";

const isDrawingTab = (): boolean => {
  const { tabs, activeTabId } = useEditorStore.getState();
  return tabs.find((t) => t.id === activeTabId)?.location.kind === "drawing";
};

const files: DrawingFiles = {
  handledNatively: () =>
    useSettingsStore.getState().settings["excalidraw.handle-files"] !== "plugin",
};

const commands: CommandContribution[] = [
  {
    id: "excalidraw.new-drawing",
    label: "New drawing",
    description: "Create a drawing next to the open note",
    when: (ctx) => ctx.hasWorkspace && !ctx.isCompactFileMode,
    run: async () => {
      const m = await import("./lib/new-drawing");
      const dir = m.defaultDrawingDir();
      if (dir) await m.createDrawing(dir);
    },
  },
  {
    id: "excalidraw.export-svg",
    label: "Export drawing as SVG",
    description: "Write the drawing as an SVG next to it",
    when: isDrawingTab,
    run: async () => {
      const { activeFilePath } = useEditorStore.getState();
      if (!activeFilePath) return;
      const { exportSvgFile } = await import("./lib/export-svg");
      await exportSvgFile(activeFilePath);
    },
  },
];

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands,
    editorExtensions: [
      {
        id: "excalidraw.embeds",
        load: () => import("./embed-decorations").then((m) => m.drawingEmbedDecorations()),
      },
    ],
    slots: [
      {
        id: "excalidraw.drawing-tab",
        slot: "page-view:drawing",
        load: () => import("./components/drawing-view").then((m) => m.DrawingView),
      },
    ],
    menus: {
      "sidebar-folder": [
        {
          id: "excalidraw.new-drawing",
          items: (entry) => [
            {
              kind: "item",
              id: "excalidraw-new-drawing",
              text: "New drawing",
              action: () =>
                void import("./lib/new-drawing").then((m) => m.createDrawing(entry.path)),
            },
          ],
        },
      ],
    },
    workspaceListeners: [diskSyncListener],
    ipcRequests: [
      {
        id: "excalidraw.export",
        topic: "excalidraw:export",
        handle: (payload) => import("./export").then((m) => m.handleExport(payload)),
      },
    ],
    services: [{ id: DRAWING_FILES, service: files }],
  },
});
