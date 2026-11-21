import { GitCommitIcon } from "@hugeicons/core-free-icons";
import { getFileStem } from "@/lib/paths";
import { definePageKind } from "./types";

/**
 * The version history of one file (`SPECs/git-sync-spec.md` "History"): the list of its versions
 * and what the selected one changed. `path` is the file's absolute path (it may be a file that
 * was deleted: that is how a deleted note's history opens). `rev` is the version to select;
 * `version` shows that one version read-only (the "Open" of a version) instead of the list. The
 * view is the `git` feature's; with it off the tab shows the "turned off" page.
 */
export type GitHistoryLocation = {
  kind: "git-history";
  path: string;
  rev?: string;
  version?: boolean;
};

export const gitHistoryKind = definePageKind<"git-history", GitHistoryLocation>({
  kind: "git-history",
  title: (l) => `${l.version ? "Version" : "History"}: ${getFileStem(l.path)}`,
  description: "The versions of a file",
  icon: GitCommitIcon,
  loadsDocument: false,
  feature: "git",
  fromPayload: (d) =>
    typeof d.path === "string"
      ? {
          kind: "git-history",
          path: d.path,
          ...(typeof d.rev === "string" ? { rev: d.rev } : {}),
          ...(d.version === true ? { version: true } : {}),
        }
      : null,
  paths: (l) => [l.path],
  // one tab per file, and one per version for the read-only version view
  tabKey: (l) => (l.version ? `version\n${l.path}\n${l.rev ?? ""}` : `list\n${l.path}`),
  // a renamed file keeps its history tab; a deleted one is what the history is for
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  serialize: (l) => ({ path: l.path, rev: l.rev, version: l.version }),
});
