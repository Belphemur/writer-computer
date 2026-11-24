// The OpenCode feature (spec `SPECs/opencode-backend-spec.md`): a second backend of the Agent pane.
// The transport, the mapper and the server are the Rust half (`../rust/`); this half registers the
// backend with the `agent.backends` point (`@/lib/features/agent-backends`), so the pane, its
// Settings tab and its model chip learn about it without naming it. Loaded at startup, so it
// imports only `defineFeature`, the manifest, the tool table and `import()` thunks.
import { defineFeature } from "@/lib/features/registry";
import {
  invalidateBackendModels,
  type BackendModel,
  type DetectedProgram,
} from "@/lib/features/agent-backends";
import manifest from "../feature.json";
import tools from "../tools.json";
import { OPENCODE_BACKEND_ID, OPENCODE_KEYS } from "./keys";
import { toBackendModel } from "./lib/models";

/** `opencode:models-updated`, without the feature prefix (`ctx.listen` adds it). */
const MODELS_UPDATED_EVENT = "models-updated";
const ipc = () => import("./ipc");

async function detect(binaryOverride: string | null): Promise<DetectedProgram> {
  const s = await (await ipc()).status(binaryOverride);
  // the Rust half knows its pinned range: its verdict and oldest version are the status
  return {
    found: s.found,
    path: s.path,
    version: s.version,
    authenticated: null,
    supported: s.supported,
    minVersion: s.minVersion,
  };
}

async function models(): Promise<BackendModel[]> {
  return (await (await ipc()).models()).map(toBackendModel);
}

export default defineFeature({
  id: manifest.id,
  // The server says its models changed: forget the cached list so the chip and Settings ask again.
  activate: (ctx) => {
    ctx.listen(MODELS_UPDATED_EVENT, () => invalidateBackendModels(OPENCODE_BACKEND_ID));
  },
  contributes: {
    agentBackends: [
      {
        id: manifest.contributes.agentBackends[0]!,
        backendId: OPENCODE_BACKEND_ID,
        label: "OpenCode",
        glyph: "O",
        program: "opencode",
        installUrl: "https://opencode.ai/docs/",
        signIn: {
          hint: "Connect a provider: run `opencode auth login` in a terminal, then retry.",
          command: "opencode auth login",
        },
        keys: OPENCODE_KEYS,
        detect,
        models,
        settingsPanel: () => import("./settings-panel").then((m) => m.OpencodeSettingsPanel),
        toolTable: tools,
      },
    ],
  },
});
