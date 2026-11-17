// Components features mount once at the app root (the Obsidian host's plugin browser). The app
// (`components/feature-overlays.tsx`) reads this registry, so it names no feature
// (docs/consolidation.md: registry over per-case branches). Entries exist while a feature is on.
import { OwnedRegistry } from "@/lib/owned-registry";
import type { OverlayContribution } from "./types";

export type OwnedOverlay = OverlayContribution & { owner: string };

export const overlayContributions = new OwnedRegistry<OwnedOverlay>();
