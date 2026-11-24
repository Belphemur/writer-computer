/** The default of an `agent.*` key: `shared/settings.schema.json` (and the feature fragments) are
 *  the one source of truth, nothing else repeats a default. */
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";

export function agentSettingDefault(key: string): unknown {
  return SETTINGS_SCHEMA.find((d) => d.key === key)?.default;
}
