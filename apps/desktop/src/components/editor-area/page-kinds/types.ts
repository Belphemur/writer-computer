import type { IconSvgElement } from "@hugeicons/react";
import type { ComponentType, ReactNode } from "react";

/**
 * Session-serialized location payload. The `kind` tag plus a free-form bag of
 * fields. Session files carry this shape; an unknown `kind` (written by a
 * newer client) round-trips unchanged but fails to deserialize back into a
 * live `Location`.
 */
export interface SerializedLocation {
  kind: string;
  [key: string]: unknown;
}

/**
 * Input shape for `definePageKind`. Only `kind` and `title` are required —
 * everything else has a sensible default (see `definePageKind` below). Kinds
 * with payload (like `file`) override as many as they need; stateless kinds
 * (like `launcher`, `settings`) usually only set `keepAlive`.
 *
 * This describes a kind's *behavior* only — its React view lives separately in
 * the `pageKindViews` registry (`./views`) so the data/serialization layer
 * (stores, hooks) never transitively imports the editor UI tree.
 */
export interface PageKindInput<K extends string, L extends { kind: K }> {
  /** Discriminator string used as the map key and in the session `kind` field. */
  kind: K;
  /** Fallback tab title — beaten by a document-driven title where one exists. */
  title: (location: L) => string;
  /** Short human-readable description of this page kind — surfaced in the
   *  command palette and other places that want a subtitle for the kind. */
  description: string;

  /** The glyph before the tab title (and wherever the kind is shown). Default: none; file-like
   *  kinds are told apart by their title. The one place a kind's icon is declared. */
  icon?: IconSvgElement;
  /** Stays mounted when inactive? Default: `false`. */
  keepAlive?: boolean;
  /** Whether file-only context-menu items appear on this tab. Default: `false`. */
  supportsFileContextMenu?: boolean;
  /** Reconstruct a live location from a serialized payload. Default:
   *  `{ kind }` — which fits stateless kinds. Override when the kind carries
   *  payload (e.g. a file path). Return `null` for invalid data. */
  fromPayload?: (data: SerializedLocation) => L | null;
  /** All filesystem paths this location references. Default: `[]`. */
  paths?: (location: L) => string[];
  /** The primary path for APIs that need a single one. Default: `null`. */
  primaryPath?: (location: L) => string | null;
  /** Apply a rename/move. Default: identity. Return `null` to invalidate. */
  rewritePath?: (location: L, from: string, to: string) => L | null;
  /** Apply a delete. Default: identity. Return `null` to invalidate. */
  removePath?: (location: L, path: string) => L | null;
  /** Session payload (excluding the `kind` tag). Default: `{}`. Return `null`
   *  to skip persistence (transient kinds like launcher). */
  serialize?: (location: L) => object | null;
  /** Claim a workspace file path: return the location that opens it, or `null`
   *  to leave it to another kind (the `file` kind is the fallback). This is the
   *  one place that decides what a path opens as. Default: claims nothing. */
  forPath?: (path: string) => L | null;
  /** Is this kind's `paths` backed by a text document loaded into the editor
   *  store (`openFiles`)? Default: `true`. Kinds that render a path another way
   *  (a `.base` table) set `false`, so the store never reads it as text. */
  loadsDocument?: boolean;
  /** What makes two opens of this kind the same tab: opening a location whose key equals an open
   *  tab's focuses that tab and re-targets it (`openLocationTab`). Default: none, every open is a
   *  new tab (a file's tab is found by its path elsewhere). */
  tabKey?: (location: L) => string | undefined;
  /** The built-in feature that supplies this kind's view (`feature.json` id). While it is not
   *  running the kind claims no path (`locationForPath` leaves the file to the text kinds) and an
   *  already open tab shows the "turned off" page instead of the view. Default: core's own. */
  feature?: string;
  /** With `feature` off, keep claiming this kind's paths so the tab shows the "turned off" page
   *  instead of the file opening as text. For a kind whose files are not text (an image).
   *  Default: false. */
  claimsWhenOff?: boolean;
}

/** A registered page kind — what you actually dispatch through at runtime
 *  after `definePageKind` has filled in the defaults. All methods are
 *  required here, so call sites never need to null-check. Behavior only — the
 *  React view is held separately in `PageKindView` / the `pageKindViews`
 *  registry so stores and hooks can dispatch through this without importing the
 *  editor UI. */
export interface PageKind<K extends string = string, L extends { kind: K } = { kind: K }> {
  kind: K;
  title: (location: L) => string;
  description: string;
  icon: IconSvgElement | undefined;
  keepAlive: boolean;
  supportsFileContextMenu: boolean;
  fromPayload: (data: SerializedLocation) => L | null;
  paths: (location: L) => string[];
  primaryPath: (location: L) => string | null;
  rewritePath: (location: L, from: string, to: string) => L | null;
  removePath: (location: L, path: string) => L | null;
  serialize: (location: L) => object | null;
  forPath: (path: string) => L | null;
  loadsDocument: boolean;
  tabKey: (location: L) => string | undefined;
  feature: string | undefined;
  claimsWhenOff: boolean;
}

/** Widest `PageKind` type — used by the registry map where the specific kind
 *  isn't statically known. */
export type AnyPageKind = PageKind<string, { kind: string }>;

/** The React view for a page kind — its tab body and optional footer chrome.
 *  Kept out of `PageKind` so the editor UI is only imported by the renderer
 *  (`pageKindViews` in `./views`), never by the data/serialization layer. */
export interface PageKindView<L extends { kind: string } = { kind: string }> {
  /** React renderer for the tab body. */
  Component: ComponentType<{ location: L; isActive: boolean; tabId: string }>;
  /** Optional chrome rendered below the active tab body. */
  renderFooter?: (location: L) => ReactNode;
}

/**
 * Assemble a `PageKind` from a sparse input by filling in defaults. This is
 * the one place where the defaults live — each kind module just specifies
 * what's unique to it.
 */
export function definePageKind<K extends string, L extends { kind: K }>(
  input: PageKindInput<K, L>,
): PageKind<K, L> {
  return {
    icon: undefined,
    keepAlive: false,
    supportsFileContextMenu: false,
    fromPayload: () => ({ kind: input.kind }) as L,
    paths: () => [],
    primaryPath: () => null,
    rewritePath: (l) => l,
    removePath: (l) => l,
    serialize: () => ({}),
    forPath: () => null,
    loadsDocument: true,
    tabKey: () => undefined,
    feature: undefined,
    claimsWhenOff: false,
    ...input,
  };
}
