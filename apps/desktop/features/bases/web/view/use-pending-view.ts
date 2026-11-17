import { useEffect } from "react";
import * as editorApi from "@/hooks/editor-api";
import { consumePendingAnchor } from "@/lib/pending-anchor";

/**
 * `[[x.base#View]]` and `[x](x.base#View)` leave the view name as the pending anchor of the base
 * path (the same hand-off headings use). On mount the tab takes it as its selected view.
 */
export function usePendingBaseView(path: string, tabId: string) {
  useEffect(() => {
    const view = consumePendingAnchor(path);
    if (view) editorApi.setBaseTabView(tabId, view);
  }, [path, tabId]);
}
