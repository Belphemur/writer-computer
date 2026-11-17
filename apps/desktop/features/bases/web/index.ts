// Obsidian Bases as a built-in feature (SPECs/builtin-plugins-spec.md step 5, spec
// `SPECs/obsidian-bases-spec.md`). Registers what exists only while Bases is on: the base view
// as the body of the `base` page kind, the embeds in notes (`![[x.base]]` and ```base fences) as
// an editor extension, and the `bases.views` service the Obsidian shim registers plugin views
// through. Everything heavy sits behind `load` thunks: the view chunk loads when a base tab first
// renders, the embed widgets when the first editor opens; this file and the service are small.
//
// Stays in core on purpose: the `base` page kind's behaviour (session restore and path routing
// need it before any feature runs, `Location` is a closed union), the sidebar's Database icon for
// `.base` files (a file-type icon, like the others; with the feature off the file is still a
// base file), the editor store's per-tab view choice, and `isBasePath`.
//
// Switched off: the base tab shows "Bases is turned off" with Turn on and Open as text, `.base`
// files open as text, embeds fall back to plain wiki links, and `getService("bases.views")` is
// empty. There are no palette commands, shortcuts or settings of its own today.
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";
import { BASES_VIEWS } from "./api";
import { basesViewsService, disposeBasesViews } from "./service";

export default defineFeature({
  id: manifest.id,
  contributes: {
    editorExtensions: [
      {
        id: "bases.embeds",
        load: () => import("./embed-decorations").then((m) => m.baseEmbedDecorations()),
      },
    ],
    slots: [
      {
        id: "bases.base-tab",
        slot: "page-view:base",
        load: () => import("./view").then((m) => m.BaseView),
      },
    ],
    services: [{ id: BASES_VIEWS, service: basesViewsService, dispose: disposeBasesViews }],
  },
});
