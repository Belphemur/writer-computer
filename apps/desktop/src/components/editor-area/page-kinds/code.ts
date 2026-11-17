import { isCodePath } from "@/lib/code-files";
import { getFileName } from "@/lib/paths";
import { definePageKind } from "./types";

/**
 * A code or text file (py, ts, json, sh, ...) in the code editor: the same CodeMirror stack as
 * notes without the markdown live preview. The path loads into the editor store like a note
 * (`loadsDocument` stays true) but as one block of text, with no frontmatter. Claimed by
 * `forPath` for the extensions in `files.code-extensions`; the tab title keeps the extension.
 */
export type CodeLocation = { kind: "code"; path: string };

export const codeKind = definePageKind<"code", CodeLocation>({
  kind: "code",
  title: (l) => getFileName(l.path),
  description: "Code file",
  keepAlive: true,
  supportsFileContextMenu: true,
  forPath: (path) => (isCodePath(path) ? { kind: "code", path } : null),
  fromPayload: (data) => (typeof data.path === "string" ? { kind: "code", path: data.path } : null),
  paths: (l) => [l.path],
  primaryPath: (l) => l.path,
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  removePath: (l, path) => (l.path === path ? null : l),
  serialize: (l) => ({ path: l.path }),
});
