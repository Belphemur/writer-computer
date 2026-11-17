/**
 * Send-time resolution of the paths behind a message's `@` tokens (spec "What Writer sends").
 * It runs before the pure `buildPrompt` and never guesses:
 *
 *  1. a picked note that no longer exists at the path its pick recorded (renamed or moved
 *     between the pick and the send) follows to the one vault file with exactly its file name;
 *     with none or several the recorded path stays;
 *  2. a token nobody picked becomes a reference only when it is an exact vault-relative path to
 *     something that exists (the user typed the whole path); a bare name, a missing path or a
 *     path outside the vault stays literal text with no reference.
 *
 * I/O sits behind {@link RefIo} so the logic is testable without a window.
 */
import { fileExists, findFilesByExactName } from "@/lib/tauri";
import type { ContextRef } from "./events";
import { isActiveNoteToken } from "./mentions";
import { tokenizeMessage } from "./trigger";

export type RefIo = {
  /** Does this vault-relative path (file or folder) exist? */
  exists(rel: string): Promise<boolean>;
  /** Every vault-relative path whose file name is exactly `fileName` (extension included). */
  findByName(fileName: string): Promise<string[]>;
};

const fileNameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** A typed path with an extension is a note (or file); without one, a folder. */
const kindOfTypedPath = (p: string): "note" | "folder" =>
  /\.[^/.]+$/.test(fileNameOf(p)) ? "note" : "folder";

export async function prepareRefs(
  text: string,
  refs: readonly ContextRef[],
  io: RefIo,
): Promise<ContextRef[]> {
  const out: ContextRef[] = [];
  for (const r of refs) {
    if (r.kind === "note" && (await io.exists(r.path)) === false) {
      const same = await io.findByName(fileNameOf(r.path));
      out.push(same.length === 1 ? { ...r, path: same[0]! } : r);
    } else out.push(r);
  }
  const known = new Set(
    out.flatMap((r) =>
      r.kind === "note" || r.kind === "folder" ? [r.path, r.label ?? r.path] : [],
    ),
  );
  const tried = new Set<string>();
  for (const seg of tokenizeMessage(text)) {
    if (seg.kind !== "mention" || isActiveNoteToken(seg) || known.has(seg.path)) continue;
    const p = seg.path.replace(/\/$/, "");
    if (!p || p.startsWith("/") || p.split("/").includes("..") || tried.has(p)) continue;
    tried.add(p);
    if ((await io.exists(p)) === true)
      out.push({ kind: kindOfTypedPath(p), path: p } as ContextRef);
  }
  return out;
}

/** The real I/O for a workspace `root` (absolute). */
export function createRefIo(root: string): RefIo {
  const base = root.endsWith("/") ? root : `${root}/`;
  return {
    exists: (p) => fileExists(`${base}${p}`),
    findByName: (fileName) => findFilesByExactName(fileName),
  };
}
