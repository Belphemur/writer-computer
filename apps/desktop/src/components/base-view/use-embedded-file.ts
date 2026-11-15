import { useEffect, useState } from "react";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { onIndexChanged } from "@/lib/bases/ipc";
import * as tauri from "@/lib/tauri";
import { resolveWikiLink } from "@/lib/wiki-links";
import { errorMessage } from "./use-base-query";

export type EmbeddedFile =
  | { status: "loading" }
  | { status: "ready"; path: string }
  | { status: "missing" }
  | { status: "error"; message: string };

/**
 * Resolves the target of `![[x.base]]` (relative to the embedding note) to an absolute path.
 * A missing file is a state, not an error: it re-resolves when the index reports a change, so
 * creating the base makes the embed appear. Resolution failures are surfaced, never swallowed.
 */
export function useEmbeddedFile(target: string, notePath: string): EmbeddedFile {
  const [state, setState] = useState<{ key: string; value: EmbeddedFile } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${notePath}\0${target}`;

  useEffect(() => {
    let current = true;
    const root = getWorkspaceRoot();
    if (!root) {
      setState({ key, value: { status: "error", message: "No workspace is open" } });
      return;
    }
    resolveWikiLink(target, root, tauri.fuzzySearch, tauri.fileExists, notePath, (name) =>
      tauri.findFileByName(root, name),
    ).then(
      (result) => {
        if (!current) return;
        setState({
          key,
          value:
            result.kind === "internal"
              ? { status: "ready", path: result.path }
              : { status: "missing" },
        });
      },
      (e) => {
        if (current) setState({ key, value: { status: "error", message: errorMessage(e) } });
      },
    );
    return () => {
      current = false;
    };
  }, [key, target, notePath, attempt]);

  const missing = state?.key === key && state.value.status === "missing";
  useEffect(() => {
    if (!missing) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onIndexChanged(() => {
      if (!disposed) setAttempt((n) => n + 1);
    }).then(
      (fn) => (disposed ? fn() : (unlisten = fn)),
      () => undefined,
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [missing]);

  return state?.key === key ? state.value : { status: "loading" };
}
