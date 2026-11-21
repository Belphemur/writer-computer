import { GitMergeIcon } from "@hugeicons/core-free-icons";
import { getFileStem } from "@/lib/paths";
import { definePageKind } from "./types";

/**
 * The merge view of one conflicted file (`SPECs/git-sync-spec.md` "Merge view"): Mine, Result and
 * Theirs side by side. `path` is the file's absolute path, where the user's version is. One tab per
 * file. The view is the `git` feature's; with it off the tab shows the "turned off" page.
 */
export type GitMergeLocation = {
  kind: "git-merge";
  path: string;
};

export const gitMergeKind = definePageKind<"git-merge", GitMergeLocation>({
  kind: "git-merge",
  title: (l) => `Resolve: ${getFileStem(l.path)}`,
  description: "Settle a conflict between two devices",
  icon: GitMergeIcon,
  loadsDocument: false,
  feature: "git",
  fromPayload: (d) => (typeof d.path === "string" ? { kind: "git-merge", path: d.path } : null),
  paths: (l) => [l.path],
  tabKey: (l) => l.path,
  // a renamed file keeps its tab; a deleted one has nothing left to settle
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  removePath: (l, path) => (l.path === path ? null : l),
  serialize: (l) => ({ path: l.path }),
});
