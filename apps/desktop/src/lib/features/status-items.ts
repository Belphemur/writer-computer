// Items features add to the document footer, after the built-in counts. The footer
// (`components/editor-area/document-footer.tsx`) reads this registry, so it names no feature.
import { OwnedRegistry } from "@/lib/owned-registry";
import type { StatusItemContribution } from "./types";

export type OwnedStatusItem = StatusItemContribution & { owner: string };

export const statusItemContributions = new OwnedRegistry<OwnedStatusItem>();
