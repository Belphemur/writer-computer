// The window's half of the CLI-to-app socket (`src-tauri/src/ipc/`, spec `SPECs/writer-cli-spec.md`
// "Talking to the running app"). Rust asks this window with an `ipc:request` event
// `{ id, topic, payload }`; the handler registered for the topic answers and the answer goes back
// through `ipc_reply`. Core's handlers (`open`, `reveal`, `active`) are here and reuse the paths
// the UI itself uses; a feature adds its own topic through `contributes.ipcRequests`.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { findEditorView } from "@/lib/editor-views";
import { CORE_OWNER, handleIpcRequest, ipcRequestHandlers } from "@/lib/features/ipc-requests";
import { openPathAtAnchor, type LinkIntent } from "@/lib/link-activation";
import { revealPathInSidebar } from "@/lib/reveal-in-sidebar";
import * as tauri from "@/lib/tauri";
import { openFileAtLine } from "@/components/editor-area/reveal-line";
import { useEditorStore } from "@/stores/editor-store";

interface OpenPayload {
  path: string;
  newTab: boolean;
  line: number | null;
  anchor: string | null;
}

/** `open`: the window's own open path, with the options the CLI gave (`newTab`, `line` or
 *  `anchor`). A new tab opens active, like Cmd+Shift+click on a link. */
async function open(payload: unknown): Promise<unknown> {
  const p = payload as OpenPayload;
  const intent: LinkIntent = p.newTab ? "new-tab-active" : "current";
  if (p.line !== null && p.line !== undefined) {
    await openFileAtLine(p.path, p.line, { intent });
  } else {
    await openPathAtAnchor(p.path, p.anchor, intent);
  }
  return {};
}

async function reveal(payload: unknown): Promise<unknown> {
  await revealPathInSidebar((payload as { path: string }).path, { showSidebar: true });
  return {};
}

/** `active`: the active tab's path, kind and cursor line, and nothing else. Rust reduces whatever
 *  this returns to those three fields again, so text could not leave even through a bug here. */
function active(): unknown {
  const { tabs, activeTabId, activeFilePath } = useEditorStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return { path: null, kind: null, line: null };
  const view = findEditorView(activeFilePath);
  const line = view ? view.state.doc.lineAt(view.state.selection.main.head).number : null;
  return { path: activeFilePath, kind: tab.location.kind, line };
}

const CORE_HANDLERS: Record<string, (payload: unknown) => unknown> = { open, reveal, active };

/** Register core's handlers; returns the teardown. Idempotent per topic (a re-register replaces). */
export function registerCoreIpcHandlers(): () => void {
  const offs = Object.entries(CORE_HANDLERS).map(([topic, handle]) =>
    ipcRequestHandlers.add(topic, { id: `core.${topic}`, topic, handle, owner: CORE_OWNER }),
  );
  return () => offs.forEach((off) => off());
}

interface IpcRequest {
  id: string;
  topic: string;
  payload: unknown;
}

/** Run one request and send its answer. A handler that throws answers with its message: the CLI
 *  shows it, nothing logs it. */
export async function answerIpcRequest(req: IpcRequest): Promise<void> {
  try {
    const result = await handleIpcRequest(req.topic, req.payload);
    await tauri.ipcReply(req.id, { result: result ?? null });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await tauri.ipcReply(req.id, { error });
  }
}

/** Listen for CLI requests once this window's startup has resolved, then say it is ready (Rust
 *  holds requests for a window that is not ready, such as one `open` just created). */
export function useIpcRequests(startupResolved: boolean): void {
  useEffect(() => registerCoreIpcHandlers(), []);
  useEffect(() => {
    if (!startupResolved) return;
    let cancelled = false;
    const unlisten = listen<IpcRequest>("ipc:request", (event) => {
      void answerIpcRequest(event.payload);
    });
    void unlisten.then(() => {
      if (!cancelled) void tauri.ipcReady();
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, [startupResolved]);
}
