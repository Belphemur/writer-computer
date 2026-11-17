// The mouse-buttons feature: back and forward on the mouse side buttons (SPECs/mouse-side-buttons-spec.md).
// Import-light (host rule, SPECs/builtin-plugins-spec.md 7.5): the handlers sit behind a dynamic
// import. It has no palette command or key binding, so it activates at startup (`onStartup` in
// `feature.json`, started by the loader in `src/lib/features/builtin.ts`).
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";

export default defineFeature({
  id: manifest.id,
  activate: async (ctx) => (await import("./mouse-navigation")).startMouseNavigation(ctx),
});
