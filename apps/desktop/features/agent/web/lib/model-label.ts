/**
 * Short names for the model chip. The id the CLI reports (`claude-opus-5-5`) or the alias the
 * user picked (`opus`) becomes `Opus 5.5` / `Opus`; the catalog's label wins when it has one.
 */
import { catalogModel, DEFAULT_MODEL_ID } from "./model-catalog";

import { prettyModelId } from "@/lib/model-name";

export { prettyModelId };

export function shortModelName(id: string | null | undefined): string {
  if (!id || id === DEFAULT_MODEL_ID) return "Default";
  const known = catalogModel(id);
  if (known && !known.alias) return known.label;
  if (known) return known.label;
  return prettyModelId(id);
}

/** Does what the CLI reported match what was asked for? Aliases match their family. */
export function reportedMatches(requested: string | null, reported: string | null): boolean {
  if (!requested || !reported) return true; // default: whatever the CLI picked is right
  if (requested === reported) return true;
  return catalogModel(requested)?.alias === true && reported.includes(requested);
}
