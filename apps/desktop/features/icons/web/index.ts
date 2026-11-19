// The icons feature (SPECs/icons-spec.md): icons on files and folders, in the sidebar, tabs, note
// first heading and links, set from "Change icon..." and shown inline as `:shortcodes:`. The one store and
// hook every surface reads is core's (`lib/file-icons.ts`); this feature fills it from Rust and
// owns the picker, the menu items and the shortcode extension. Import-light: the picker, the note
// icon, the shortcodes and the Settings page are lazy chunks.
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";
import { changeIconItems } from "./menus";
import { openIconPicker } from "./picker-store";
import { ICONS_CHANGED } from "./ipc";
import { startIconSync, syncIcons } from "./sync";

export default defineFeature({
  id: manifest.id,
  activate(ctx) {
    const stop = startIconSync();
    // The CLI, Obsidian with Iconize or a sync tool changed a file: ask Rust again.
    const unlisten = ctx.listen(ICONS_CHANGED, () => void syncIcons());
    return () => {
      unlisten();
      stop();
    };
  },
  contributes: {
    commands: manifest.contributes.commands.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      when: (ctx) => ctx.hasWorkspace && !ctx.isCompactFileMode && ctx.activeFilePath !== null,
      run: (ctx) => {
        if (ctx.activeFilePath) openIconPicker([ctx.activeFilePath]);
      },
    })),
    menus: {
      "sidebar-file": [
        { id: "icons.sidebar-file", items: (entry) => changeIconItems([entry.path]) },
      ],
      "sidebar-folder": [
        { id: "icons.sidebar-folder", items: (entry) => changeIconItems([entry.path]) },
      ],
      "sidebar-bulk": [{ id: "icons.sidebar-bulk", items: (paths) => changeIconItems(paths) }],
      "editor-tab": [{ id: "icons.editor-tab", items: (path) => changeIconItems([path]) }],
    },
    overlays: [
      {
        id: "icons.picker",
        load: () => import("./picker").then((m) => m.default),
      },
    ],
    editorExtensions: [
      {
        id: "icons.note-icon",
        load: () => import("./note-icon").then((m) => m.noteIconExtension()),
      },
      {
        id: "icons.shortcodes",
        load: () => import("./shortcodes").then((m) => m.shortcodesExtension()),
      },
    ],
    settingsSection: {
      id: "icons",
      label: "Icons",
      order: 46,
      load: () => import("./settings-page").then((m) => ({ default: m.IconsSection })),
    },
  },
});
