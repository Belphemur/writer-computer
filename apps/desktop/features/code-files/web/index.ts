// The Code files feature (SPECs/code-files-spec.md, built-in feature step 5): what counts as a
// code or text file, and the code editor that opens one. This file is loaded at startup, so it
// imports only `defineFeature`, the manifest, the tiny rules module and an `import()` thunk: the
// editor, its CodeMirror setup and the language data live in the lazy chunk.
//
// Core keeps the `code` page kind's behaviour (`Location` is a closed union and session restore
// needs it at startup), the sidebar's file icons and `isCodeName` as a lookup of the
// `code-files.rules` service (`lib/code-files.ts`); the Rust half (`features/code-files/rust/`)
// feeds the visibility policy that the sidebar, index, watcher and rename ask.
//
// Switched off: a code file opens as text, a restored `code` tab shows "Code files is turned off"
// with Turn on and Open as text, nothing is listed in the tree, and `getService` is empty.
import { defineFeature } from "@/lib/features/registry";
import { CODE_FILES_RULES } from "@/lib/code-files";
import manifest from "../feature.json";
import { codeFilesRules } from "./rules";

export default defineFeature({
  id: manifest.id,
  contributes: {
    slots: [
      {
        id: "code-files.code-tab",
        slot: "page-view:code",
        load: () => import("./components/code-editor-pane").then((m) => m.CodeEditorPane),
      },
    ],
    services: [{ id: CODE_FILES_RULES, service: codeFilesRules }],
  },
});
