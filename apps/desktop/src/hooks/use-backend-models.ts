import { useEffect, useState } from "react";
import {
  invalidateBackendModels,
  loadBackendModels,
  onBackendModelsInvalidated,
  type BackendModel,
} from "@/lib/features/agent-backends";

export type BackendModelsState =
  | { status: "loading" }
  | { status: "ready"; models: BackendModel[] }
  | { status: "error"; message: string };

/** The live model list of an agent backend, through the one shared loader: the chip and a
 *  backend's Settings panel read the same cached answer. `reload` forgets it and asks again, for
 *  every reader. `backend` null: not wanted (a backend with a static catalog). */
export function useBackendModels(
  backend: { backendId?: string; id?: string; models?: () => Promise<BackendModel[]> } | null,
): { state: BackendModelsState; reload: () => void } {
  const [state, setState] = useState<BackendModelsState>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const key = backend ? (backend.backendId ?? backend.id ?? "") : "";
  useEffect(() => onBackendModelsInvalidated(() => setVersion((v) => v + 1)), []);
  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    loadBackendModels(backend).then(
      (models) => !cancelled && setState({ status: "ready", models }),
      (e: unknown) =>
        !cancelled &&
        setState({ status: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
    // `backend` is the registry's stable object: its id is the identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
  return { state, reload: () => invalidateBackendModels(key) };
}
