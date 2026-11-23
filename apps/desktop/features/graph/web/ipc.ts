// The typed client of the graph data: `graph_slice` and `graph_stats` (SPECs/note-graph-spec.md
// section 8.5), the per-vault view config (`.writer/graph.json`) and the two core reads the view
// needs (note frontmatter for color rules and Group by, the index change event).
//
// The wire types come from the generated `bindings.ts` (tauri-specta, Rust half in `../rust/`),
// so a field change in Rust is a type error here. `Plain` only drops the `| null` the generator
// adds to every optional field (Rust never sends null for them: it skips `None`), so the rest of
// the web half reads them as plain optional fields. `tests/helpers/feature-ipc.ts` pins every call
// to the bindings and the manifest. Tests mock this module, so nothing else reaches the backend.
import { invoke } from "@tauri-apps/api/core";
import { onIndexChanged as onCoreIndexChanged } from "@/lib/content-search";
import type * as wire from "./bindings";
import { commands } from "./bindings";

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type Plain<T> = { [K in keyof T]: K extends OptionalKeys<T> ? Exclude<T[K], null> : T[K] };

export type GraphEdgeKind = wire.EdgeKind;
export type GraphNode = Plain<wire.GraphNode>;
export type GraphEdge = Plain<wire.GraphEdge>;
export type GraphSlice = Omit<wire.GraphSlice, "nodes" | "edges"> & {
  nodes: GraphNode[];
  edges: GraphEdge[];
};
export type GraphSliceArgs = Plain<wire.GraphSliceRequest>;
export type GraphStats = wire.GraphStats;

export function graphSlice(args: GraphSliceArgs): Promise<GraphSlice> {
  // The answer is the wire one; `Plain` only narrows the `| null` Rust never sends.
  return commands.graphSlice(args) as Promise<GraphSlice>;
}

export function graphStats(): Promise<GraphStats> {
  return commands.graphStats();
}

/** The raw text of `.writer/graph.json` (section 6 of SPECs/graph-view-spec.md), or `null` when
 *  the vault has none yet. The Rust half confines it to the vault and writes it atomically. */
export function graphConfigRead(): Promise<string | null> {
  return commands.graphConfigRead();
}

export async function graphConfigWrite(content: string): Promise<void> {
  await commands.graphConfigWrite(content);
}

/** Frontmatter per note, from the index (a core command): what color rules and Group by read.
 *  Paths are vault-relative; notes the index does not know are left out. */
export async function noteFrontmatter(
  paths: readonly string[],
): Promise<Record<string, Record<string, unknown>>> {
  const r = await invoke<{
    notes: { path: string; frontmatter: Record<string, unknown> | null }[];
  }>("index_get_metadata", { paths: [...paths] });
  const out: Record<string, Record<string, unknown>> = {};
  for (const n of r.notes) if (n.frontmatter) out[n.path] = n.frontmatter;
  return out;
}

/** The vault's frontmatter property names, for the Group by picker (a core command). */
export async function vaultPropertyNames(): Promise<string[]> {
  const props = await invoke<{ name: string }[]>("index_properties");
  return props.map((p) => p.name).sort((a, b) => a.localeCompare(b));
}

export type IndexChange = { full: boolean; paths: string[] };

/** Subscribe to the vault index's change batches; resolves to the unsubscribe function. */
export const onIndexChanged = onCoreIndexChanged;
