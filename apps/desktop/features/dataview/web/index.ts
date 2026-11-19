// Dataview as a built-in feature (spec `SPECs/dataview-spec.md`, ADR
// `2026-11-18-run-dataview-queries-natively-on-the-bases-engine`): ```dataview blocks in notes
// render live through the Bases views (the query is lowered to a base in Rust), "Convert to
// Base" writes the equivalent `.base`, and ```dataviewjs is a placeholder that is never run.
// This file is loaded at startup: it imports only `defineFeature`, the manifest and an `import()`
// thunk, so the block widget loads with the first editor.
//
// Switched off: blocks are plain code fences, and `writer dql` answers that it is turned off. It
// needs the Bases feature to show rows (a block says so when Bases is off).
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";

export default defineFeature({
  id: manifest.id,
  contributes: {
    editorExtensions: [
      {
        id: "dataview.blocks",
        load: () => import("./decorations").then((m) => m.dataviewDecorations()),
      },
    ],
  },
});
