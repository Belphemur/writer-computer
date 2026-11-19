// What a window answers when the `writer` CLI asks the running app for something over the local
// socket (`src-tauri/src/ipc/`, spec "Talking to the running app"). The Rust half is a command of
// the allowlist (core, or `Feature::ipc_commands`); it asks this window by topic and waits for the
// answer. Core registers `open`, `reveal` and `active` (`hooks/use-ipc-requests.ts`); a feature
// contributes its own topic through `ipcRequests` and it is removed with the feature.
import { OwnedRegistry } from "@/lib/owned-registry";

/** A registered handler: a feature's, already wrapped to activate the feature first. */
export interface OwnedIpcRequest {
  /** Same as the topic for core; `<feature id>.<name>` for a feature. */
  id: string;
  topic: string;
  handle: (payload: unknown) => unknown | Promise<unknown>;
  owner: string;
}

/** The one table of handlers, keyed by topic (the allowlisted command's name). */
export const ipcRequestHandlers = new OwnedRegistry<OwnedIpcRequest>();

/** The owner of core's own handlers. */
export const CORE_OWNER = "core";

/** Answers one request. A topic nobody registered is an error the CLI shows, never a silent no-op. */
export async function handleIpcRequest(topic: string, payload: unknown): Promise<unknown> {
  const handler = ipcRequestHandlers.get(topic);
  if (!handler) throw new Error(`no handler for ${topic}`);
  return handler.handle(payload);
}
