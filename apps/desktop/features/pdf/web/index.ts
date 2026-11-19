// The PDF feature (docs/decisions/2026-11-18-read-pdfs-in-a-built-in-pdf-feature-rendered-with-
// pdf-js.md, spec SPECs/pdf-spec.md, built-in feature step 5): the reader that opens a PDF file
// and the viewer embedded in a note. This file is loaded at startup, so it imports only
// `defineFeature`, the manifest, two tiny modules and `import()` thunks: pdf.js and everything
// that touches it live in the lazy chunks (a test pins that the startup graph never reaches the
// package).
//
// Core keeps the `pdf` page kind (`Location` is a closed union and session restore needs it at
// startup), the sidebar listing with its setting `files.show-pdfs`, links with `#page=N`
// (`lib/pdf-anchor.ts`), the agent composer's PDF attachments and the Rust side (`read_document`,
// the one list of document types in `shared/attachments.json`).
//
// Switched off: a PDF's tab shows "PDF is turned off" with Turn on and Open in default app;
// `![[x.pdf]]` stays a plain line; the composer still attaches PDFs, only without a page count.
import { defineFeature } from "@/lib/features/registry";
import type { CommandContribution, KeybindingContribution } from "@/lib/features/types";
import { isPdfViewerActive } from "@/lib/keybindings/when";
import manifest from "../feature.json";
import { PDF_INFO, type PdfInfo } from "./api";
import { activeViewer } from "./lib/viewer-controller";

const ACTIONS = {
  "pdf.zoom-in": () => activeViewer()?.zoomIn(),
  "pdf.zoom-out": () => activeViewer()?.zoomOut(),
  "pdf.fit": () => activeViewer()?.fit(),
  "pdf.find": () => activeViewer()?.find(),
} as const;

// The same chords as the editor's text zoom: core's bindings apply outside a viewer tab
// (`no-viewer`), these inside a PDF tab (`pdf-viewer`), so the context tells them apart. Cmd+F is
// the editor's own find (CodeMirror's keymap) while an editor has focus; a PDF tab has none.
const KEY_OPTIONS: Record<string, Partial<KeybindingContribution>> = {
  "pdf.zoom-in": { physicalKeys: ["NumpadAdd"] },
  "pdf.zoom-out": { alsoKeys: ["_"], physicalKeys: ["NumpadSubtract"] },
  "pdf.fit": { physicalKeys: ["Digit0", "Numpad0"] },
};

const commands: CommandContribution[] = manifest.contributes.commands.map((c) => ({
  id: c.id,
  label: c.label,
  description: c.description,
  when: () => isPdfViewerActive(),
  run: () => ACTIONS[c.id as keyof typeof ACTIONS](),
}));

const keybindings: KeybindingContribution[] = manifest.contributes.keybindings.map((k) => ({
  ...k,
  ...KEY_OPTIONS[k.id],
  category: "View",
  looseShift: k.id !== "pdf.find",
  when: "pdf-viewer",
  run: () => ACTIONS[k.id as keyof typeof ACTIONS](),
}));

const info: PdfInfo = {
  pageCountOfPath: (path) => import("./lib/pdf-info").then((m) => m.pageCountOfPath(path)),
  pageCountOfBytes: (bytes) => import("./lib/pdf-info").then((m) => m.pageCountOfBytes(bytes)),
};

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands,
    keybindings,
    editorExtensions: [
      {
        id: "pdf.embeds",
        load: () => import("./embed-decorations").then((m) => m.pdfEmbedDecorations()),
      },
    ],
    slots: [
      {
        id: "pdf.pdf-tab",
        slot: "page-view:pdf",
        load: () => import("./components/pdf-viewer").then((m) => m.PdfViewer),
      },
    ],
    services: [{ id: PDF_INFO, service: info }],
  },
});
