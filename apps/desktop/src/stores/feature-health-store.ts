// What went wrong in built-in features, and what Rust recovered from (SPECs/builtin-plugins-spec.md
// section 16). One store: every host path reports a failure here (`lib/features/health.ts`), the
// loader reads `isOff` to unregister a feature for the session, the notices and the Features
// section read it. Nothing here is persisted: a restart starts clean (Rust owns the markers).
import { create } from "zustand";

/** Failures of one feature within a session before it is switched off for the session. */
export const FAILURE_LIMIT = 3;

export interface FeatureFailure {
  boundary: string;
  /** Unix ms of the last failure. */
  at: number;
  /** Failures this session (a Rust failure counts as the limit at once). */
  count: number;
}

/** A setting Rust turned off at startup because the last run died in that feature. */
export interface CrashDisabled {
  id: string;
  setting: string;
  boundary: string;
}

/** Payload of the `features_status` command. */
export interface FeaturesStatus {
  safeMode: boolean;
  crashDisabled: CrashDisabled[];
  failures: { id: string; boundary: string; at: number }[];
}

interface FeatureHealthState {
  failures: Record<string, FeatureFailure>;
  /** Features switched off for this session (three web failures or one Rust failure). */
  sessionOff: Record<string, true>;
  crashDisabled: CrashDisabled[];
  safeMode: boolean;
  /** Notices the user closed, by `<kind>:<id>`. */
  dismissed: Record<string, true>;

  /** One failure in the web half; the third switches the feature off for the session. */
  recordFailure: (id: string, boundary: string) => void;
  /** `features:failed` from Rust: its web half goes off at once. */
  markFailedByRust: (id: string, boundary: string) => void;
  /** A failure that cannot be retried (the Obsidian host failed to boot): off for the session at once. */
  failNow: (id: string, boundary: string) => void;
  applyStatus: (status: FeaturesStatus) => void;
  /** The user turned the feature back on: forget its failures (web half at once). */
  clear: (id: string) => void;
  dismiss: (key: string) => void;
}

export const useFeatureHealth = create<FeatureHealthState>()((set, get) => ({
  failures: {},
  sessionOff: {},
  crashDisabled: [],
  safeMode: false,
  dismissed: {},

  recordFailure: (id, boundary) =>
    set((s) => {
      const count = (s.failures[id]?.count ?? 0) + 1;
      return {
        failures: { ...s.failures, [id]: { boundary, at: Date.now(), count } },
        sessionOff: count >= FAILURE_LIMIT ? { ...s.sessionOff, [id]: true } : s.sessionOff,
      };
    }),

  markFailedByRust: (id, boundary) => get().failNow(id, boundary),

  failNow: (id, boundary) =>
    set((s) => ({
      failures: { ...s.failures, [id]: { boundary, at: Date.now(), count: FAILURE_LIMIT } },
      sessionOff: { ...s.sessionOff, [id]: true },
    })),

  applyStatus: (status) =>
    set((s) => {
      const failures = { ...s.failures };
      const sessionOff = { ...s.sessionOff };
      for (const f of status.failures) {
        failures[f.id] = { boundary: f.boundary, at: f.at, count: FAILURE_LIMIT };
        sessionOff[f.id] = true;
      }
      return {
        safeMode: status.safeMode,
        crashDisabled: status.crashDisabled,
        failures,
        sessionOff,
      };
    }),

  clear: (id) =>
    set((s) => {
      const failures = { ...s.failures };
      const sessionOff = { ...s.sessionOff };
      delete failures[id];
      delete sessionOff[id];
      return {
        failures,
        sessionOff,
        crashDisabled: s.crashDisabled.filter((c) => c.id !== id),
      };
    }),

  dismiss: (key) => set((s) => ({ dismissed: { ...s.dismissed, [key]: true } })),
}));

/** Is the feature off for this run whatever its setting says: safe mode or a session failure? */
export function isOffForSession(
  state: Pick<FeatureHealthState, "safeMode" | "sessionOff">,
  id: string,
): boolean {
  return state.safeMode || state.sessionOff[id] === true;
}
