import { useMemo } from "react";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { toAbsolutePath } from "../lib/paths";
import {
  activateLink,
  openPath,
  wikiLinkTarget,
  type LinkIntent,
  type WikiLinkReport,
} from "@/lib/link-activation";
import type { CellActions } from "./cell-view";
import { errorMessage } from "./use-base-query";

/** Cells never replace the Bases view: a plain click opens (and shows) a new tab. */
const tabIntent = (intent: LinkIntent | undefined): LinkIntent =>
  intent === undefined || intent === "current" ? "new-tab-active" : intent;

/**
 * What clicking a link or file cell does: open the target in a new main tab through the link
 * activation module. Failures (no workspace, a link that resolves to nothing) are reported with
 * `notify`, never ignored.
 */
export function useCellActions(notify: (kind: "error", message: string) => void): CellActions {
  return useMemo<CellActions>(() => {
    // A middle or Cmd/Ctrl click keeps the focus where it is.
    const openAbsolute = (absolute: string, intent?: LinkIntent) =>
      openPath(absolute, tabIntent(intent)).catch((e) =>
        notify("error", `Could not open ${absolute}: ${errorMessage(e)}`),
      );
    return {
      openFile: (relativePath, intent) => {
        const root = getWorkspaceRoot();
        if (!root) return notify("error", "No workspace is open");
        void openAbsolute(toAbsolutePath(root, relativePath), intent);
      },
      openLink: ({ target, resolved }, intent) => {
        const root = getWorkspaceRoot();
        if (!root) return notify("error", "No workspace is open");
        if (resolved) {
          void openAbsolute(toAbsolutePath(root, resolved), intent);
          return;
        }
        const report: WikiLinkReport = (problem, raw, error) => {
          if (problem === "unresolved") notify("error", `"${raw}" was not found in the vault`);
          else if (problem === "open-failed")
            notify("error", `Could not open "${raw}": ${errorMessage(error)}`);
          else notify("error", `Could not resolve "${raw}": ${errorMessage(error)}`);
        };
        activateLink(
          wikiLinkTarget(target, () => null, undefined, report),
          tabIntent(intent),
        );
      },
    };
  }, [notify]);
}
