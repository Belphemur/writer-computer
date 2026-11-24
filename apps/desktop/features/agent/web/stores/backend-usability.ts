/**
 * Which backends can be used right now: the feature is on (it is in the registry) and its program
 * was found. Detected once per backend per session and cached; the new-chat picker, the "Default
 * agent" row and a new chat's default backend read it. A backend whose detection failed or has
 * not finished is not usable (never a guess).
 */
import { useMemo } from "react";
import { create } from "zustand";
import { useSettingsStore } from "@/stores/settings-store";
import {
  DEFAULT_BACKEND_ID,
  detectBackend,
  listBackends,
  useBackends,
  type AgentBackendDescriptor,
} from "@features/agent/web/lib/backends";

interface UsabilityState {
  /** Backend id to "its program was found"; absent: not detected yet. */
  usable: Record<string, boolean>;
}

export const useBackendUsability = create<UsabilityState>(() => ({ usable: {} }));

const inFlight = new Map<string, Promise<void>>();

const overrideOf = (b: AgentBackendDescriptor): string | null => {
  const v = useSettingsStore.getState().settings[b.keys.binaryPath];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/** Detects the backends not detected yet (all of them with `force`). Never rejects. */
export function detectUsableBackends(opts: { force?: boolean } = {}): Promise<void> {
  const known = useBackendUsability.getState().usable;
  const todo = listBackends().filter(
    (b) => b.status === "available" && (opts.force || !(b.id in known)),
  );
  return Promise.all(
    todo.map((b) => {
      const pending =
        inFlight.get(b.id) ??
        detectBackend(b, overrideOf(b))
          .then((info) => info.found)
          .catch(() => false)
          .then((found) => {
            useBackendUsability.setState((s) => ({ usable: { ...s.usable, [b.id]: found } }));
          })
          .finally(() => inFlight.delete(b.id));
      inFlight.set(b.id, pending);
      return pending;
    }),
  ).then(() => undefined);
}

export const resetBackendUsabilityForTests = () => {
  inFlight.clear();
  useBackendUsability.setState({ usable: {} });
};

/** The backends a chat could be started on, in registry order. */
export function usableBackends(
  backends: readonly AgentBackendDescriptor[],
  usable: Record<string, boolean>,
): AgentBackendDescriptor[] {
  return backends.filter((b) => b.status === "available" && usable[b.id] === true);
}

/** The backend a new chat starts on: `agent.default-backend` when that backend is registered and
 *  its program was found (not yet known is not usable), else Claude. Chats made before detection
 *  finished are moved to it afterwards (`reresolveUntouchedChats`). */
export function resolveDefaultBackend(
  setting: unknown,
  backends: readonly AgentBackendDescriptor[],
  usable: Record<string, boolean>,
): string {
  const wanted = typeof setting === "string" ? setting : DEFAULT_BACKEND_ID;
  const b = backends.find((x) => x.id === wanted && x.status === "available");
  return b && usable[b.id] === true ? b.id : DEFAULT_BACKEND_ID;
}

/** The usable backends, live (re-detects a backend whose feature was turned on). */
export function useUsableBackends(): AgentBackendDescriptor[] {
  const backends = useBackends();
  const usable = useBackendUsability((s) => s.usable);
  return useMemo(() => usableBackends(backends, usable), [backends, usable]);
}
