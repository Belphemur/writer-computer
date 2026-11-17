// Services: a typed capability a feature offers to core or to another feature, found through a
// registry lookup so the consumer depends on an interface and never imports the provider
// (SPECs/builtin-plugins-spec.md, "Service"). A feature declares `provides` in `feature.json`
// (service ids) and registers the implementations in `contributes.services`; both go away when the
// feature is switched off, so `getService` is `undefined` exactly while the feature is not
// running and the consumer says "not available" (the Obsidian shim's `registerBasesView` answers
// `false`, as Obsidian does without the core plugin).
//
// The interface type lives with the provider's public entry (`@features/<id>/web/api`); a consumer
// imports it with `import type` only (erased at build time), so no runtime edge exists between
// the two features.
import { OwnedRegistry } from "@/lib/owned-registry";

export interface ServiceContribution<T = unknown> {
  /** `<feature id>.<name>`, one of the manifest's `provides`. */
  id: string;
  service: T;
  /** Runs when the feature is switched off, after the service is no longer found. */
  dispose?: () => void;
}

export type OwnedService = ServiceContribution & { owner: string };

export const serviceContributions = new OwnedRegistry<OwnedService>((s) => s.dispose?.());

/** The service `id`, or `undefined` while its feature is off. The caller names the interface. */
export function getService<T>(id: string): T | undefined {
  return serviceContributions.get(id)?.service as T | undefined;
}
