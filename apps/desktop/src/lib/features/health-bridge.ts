// Connects the health store to Rust: `features:failed` switches a feature's web half off, and the
// startup status (safe mode, what a crash turned off, failures so far) fills the notices.
import { listen as tauriListen } from "@tauri-apps/api/event";
import { featuresStatus } from "@/lib/tauri";
import { logger } from "@/lib/logger";
import { useFeatureHealth, type FeaturesStatus } from "@/stores/feature-health-store";

export const FAILED_EVENT = "features:failed";

export interface BridgeDeps {
  listen?: typeof tauriListen;
  status?: () => Promise<FeaturesStatus>;
}

/** Starts once at app start (called by the loader). Failures to reach Rust are logged, never thrown. */
export function startFeatureHealthBridge({
  listen = tauriListen,
  status = featuresStatus,
}: BridgeDeps = {}): void {
  const health = useFeatureHealth.getState();
  try {
    void listen<{ id: string; boundary: string }>(FAILED_EVENT, (e) =>
      health.markFailedByRust(e.payload.id, e.payload.boundary),
    ).catch((e) => logger.error("app", `features:failed listener failed: ${String(e)}`));
  } catch (e) {
    logger.error("app", `features:failed listener failed: ${String(e)}`);
  }
  try {
    void status().then(health.applyStatus, (e) =>
      logger.error("app", `features status failed: ${String(e)}`),
    );
  } catch (e) {
    logger.error("app", `features status failed: ${String(e)}`);
  }
}
