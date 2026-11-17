// Context-menu items contributed by features, per surface. A surface builder asks for the items
// and appends them where it says (docs/consolidation.md: registry over per-case branches). Only
// `editor-body` has a host today; a surface joins when its first feature needs it.
import type { EditorView } from "@codemirror/view";
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import { logger } from "@/lib/logger";
import { OwnedRegistry } from "@/lib/owned-registry";

export interface EditorBodyMenuContribution {
  owner: string;
  /** `<feature id>.<name>`. */
  id: string;
  /** Items for a right-click at `event` in `view`; empty when the feature has nothing to offer there. */
  items: (view: EditorView, event: MouseEvent) => MenuItemSpec[] | Promise<MenuItemSpec[]>;
}

export const editorBodyMenuContributions = new OwnedRegistry<EditorBodyMenuContribution>();

/** All contributed items in registration order; a failing contribution is logged and skipped. */
export async function contributedEditorBodyItems(
  view: EditorView,
  event: MouseEvent,
): Promise<MenuItemSpec[]> {
  const parts = await Promise.all(
    editorBodyMenuContributions.list().map(async (c) => {
      try {
        return await c.items(view, event);
      } catch (e) {
        logger.error("app", `menu contribution ${c.id} failed: ${String(e)}`);
        return [];
      }
    }),
  );
  return parts.flat();
}
