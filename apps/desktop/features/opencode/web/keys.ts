// The settings keys of the feature's fragment (`../settings.schema.json`), built from the
// manifest's namespace once: the backend entry (`index.ts`) and the settings panel read them here.
import manifest from "../feature.json";

const NS = manifest.settingsNamespace;

/** The id Rust knows the backend by. */
export const OPENCODE_BACKEND_ID = "opencode";

export const OPENCODE_KEYS = {
  binaryPath: `${NS}.binary-path`,
  model: `${NS}.model`,
  effort: `${NS}.effort`,
  disabledModels: `${NS}.disabled-models`,
  disabledProviders: `${NS}.disabled-providers`,
  tiers: {
    cheap: `${NS}.model-cheap`,
    standard: `${NS}.model-standard`,
    strong: `${NS}.model-strong`,
  },
} as const;
