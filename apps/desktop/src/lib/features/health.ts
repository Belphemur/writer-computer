// The one way a web-side feature failure is reported: logged (redacted in Rust) and counted in the
// health store, whose third strike switches the feature off for the session. Host paths call
// `reportFailure` (menus, editor extensions, the error boundary) or the feature host's own `fail`.
import { logger } from "@/lib/logger";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { featureOfOwner } from "./id";

/** Counts one failure of `id` at `boundary` (`command`, `menu`, `editor-extension`, `render`, ...). */
export function recordFailure(id: string, boundary: string): void {
  useFeatureHealth.getState().recordFailure(id, boundary);
}

/** Logs and counts a failure of the feature that owns `owner`; an owner that is not a built-in
 *  feature (an Obsidian plugin) is only logged. */
export function reportOwnerFailure(owner: string, boundary: string, error: unknown): void {
  const id = featureOfOwner(owner);
  logger.error("app", `${boundary} of ${owner} failed: ${String(error)}`, {
    plugin: id ?? owner,
    phase: boundary,
  });
  if (id) recordFailure(id, boundary);
}
