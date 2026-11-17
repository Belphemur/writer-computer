// The `graph.*` settings with their defaults read from the feature's own fragment (one source of
// truth), plus the numbers the view derives from them.
import { useSettingsStore } from "@/stores/settings-store";
import fragment from "../settings.schema.json";
import type { Forces } from "./layout";

/** The global graph requests at most this many nodes, highest degree first (spec section 5). */
export const GRAPH_LIMIT = 10_000;

type Entry = { key: string; default: unknown };
const DEFAULTS = Object.fromEntries(
  (fragment.settings as Entry[]).map((e) => [e.key, e.default]),
) as Record<string, unknown>;

export interface GraphSettings {
  localDepth: 1 | 2 | 3;
  /** Camera ratio under which every label may show (a larger zoom percent means a smaller ratio). */
  labelRatio: number;
  forces: Forces;
  animate: boolean;
  /** Property names for the close-up card, in priority order. */
  cardProperties: string[];
}

function num(settings: Record<string, unknown>, key: string): number {
  const v = settings[key];
  return typeof v === "number" && Number.isFinite(v) ? v : (DEFAULTS[key] as number);
}

/** `"type, status"` to `["type", "status"]`; the default when the setting is not a string. */
export function cardProperties(value: unknown): string[] {
  const text = typeof value === "string" ? value : String(DEFAULTS["graph.card-properties"]);
  return text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function readGraphSettings(
  settings: Record<string, unknown>,
  reducedMotion: boolean,
): GraphSettings {
  const depth = Math.round(num(settings, "graph.local-depth"));
  const animate =
    typeof settings["graph.animate"] === "boolean"
      ? (settings["graph.animate"] as boolean)
      : (DEFAULTS["graph.animate"] as boolean);
  return {
    localDepth: depth <= 1 ? 1 : depth >= 3 ? 3 : 2,
    labelRatio: 100 / Math.max(20, num(settings, "graph.label-zoom")),
    forces: {
      center: num(settings, "graph.force-center"),
      repel: num(settings, "graph.force-repel"),
      linkDistance: num(settings, "graph.force-link-distance"),
      groupPull: num(settings, "graph.force-group-pull"),
    },
    animate: animate && !reducedMotion,
    cardProperties: cardProperties(settings["graph.card-properties"]),
  };
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The live settings; re-renders only when the settings object changes. */
export function useGraphSettings(): GraphSettings {
  const settings = useSettingsStore((s) => s.settings);
  return readGraphSettings(settings, prefersReducedMotion());
}
