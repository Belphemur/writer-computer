// The Images feature (docs/decisions/2026-11-18-make-images-a-built-in-feature-with-a-rebuilt-
// zoomable-viewer.md, built-in feature step 5): the viewer that opens an image file. This file is
// loaded at startup, so it imports only `defineFeature`, the manifest, two tiny modules and an
// `import()` thunk: the viewer lives in the lazy chunk.
//
// Core keeps the `image` page kind (`Location` is a closed union and session restore needs it at
// startup), inline images in notes, paste and insert, the attachment folders, the asset protocol
// grants, chat image chips and the sidebar listing (`files.show-images`); the list of image types
// is `renderExtensions` in `shared/attachments.json`, read by all of them.
//
// Switched off: an image file's tab shows "Images is turned off" with Turn on and Open in default
// app; notes keep rendering their images.
import { defineFeature } from "@/lib/features/registry";
import type { CommandContribution, KeybindingContribution } from "@/lib/features/types";
import { isImageViewerActive } from "@/lib/keybindings/when";
import manifest from "../feature.json";
import { diskSyncListener } from "./disk-sync";
import { activeViewer } from "./lib/viewer-controller";

const ACTIONS = {
  "images.zoom-in": () => activeViewer()?.zoomIn(),
  "images.zoom-out": () => activeViewer()?.zoomOut(),
  "images.fit": () => activeViewer()?.fit(),
} as const;

// The same chords as the editor's text zoom: core's bindings apply outside an image tab
// (`no-viewer`), these inside it (`image-viewer`), so the context tells them apart.
const KEY_OPTIONS: Record<string, Partial<KeybindingContribution>> = {
  "images.zoom-in": { physicalKeys: ["NumpadAdd"] },
  "images.zoom-out": { alsoKeys: ["_"], physicalKeys: ["NumpadSubtract"] },
  "images.fit": { physicalKeys: ["Digit0", "Numpad0"] },
};

const commands: CommandContribution[] = manifest.contributes.commands.map((c) => ({
  id: c.id,
  label: c.label,
  description: c.description,
  when: () => isImageViewerActive(),
  run: () => ACTIONS[c.id as keyof typeof ACTIONS](),
}));

const keybindings: KeybindingContribution[] = manifest.contributes.keybindings.map((k) => ({
  ...k,
  ...KEY_OPTIONS[k.id],
  category: "View",
  looseShift: true,
  when: "image-viewer",
  run: () => ACTIONS[k.id as keyof typeof ACTIONS](),
}));

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands,
    keybindings,
    slots: [
      {
        id: "images.image-tab",
        slot: "page-view:image",
        load: () => import("./components/image-viewer").then((m) => m.ImageViewer),
      },
    ],
    workspaceListeners: [diskSyncListener],
  },
});
