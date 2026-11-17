import { useMemo } from "react";
import * as editorApi from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { toAbsolutePath } from "../lib/paths";
import * as tauri from "@/lib/tauri";
import { resolveWikiLink } from "@/lib/wiki-links";
import type { CellActions } from "./cell-view";
import { errorMessage } from "./use-base-query";

/**
 * What clicking a link or file cell does: open the target in a new main tab through the existing
 * navigation helpers. Failures (no workspace, a link that resolves to nothing) are reported with
 * `notify`, never ignored.
 */
export function useCellActions(notify: (kind: "error", message: string) => void): CellActions {
  return useMemo<CellActions>(() => {
    const openAbsolute = (absolute: string) =>
      editorApi
        .openFileInNewTab(absolute)
        .catch((e) => notify("error", `Could not open ${absolute}: ${errorMessage(e)}`));
    return {
      openFile: (relativePath) => {
        const root = getWorkspaceRoot();
        if (!root) return notify("error", "No workspace is open");
        void openAbsolute(toAbsolutePath(root, relativePath));
      },
      openLink: ({ target, resolved }) => {
        const root = getWorkspaceRoot();
        if (!root) return notify("error", "No workspace is open");
        if (resolved) {
          void openAbsolute(toAbsolutePath(root, resolved));
          return;
        }
        resolveWikiLink(target, null, tauri.resolveWikiLinkTarget).then(
          (result) => {
            if (result.kind === "internal") void openAbsolute(result.path);
            else notify("error", `"${target}" was not found in the vault`);
          },
          (e) => notify("error", `Could not resolve "${target}": ${errorMessage(e)}`),
        );
      },
    };
  }, [notify]);
}
