// The typed client of the graph data: `graph_slice` and `graph_stats` (SPECs/note-graph-spec.md
// section 8.5), the per-vault view config (`.writer/graph.json`) and the two core reads the view
// needs (note frontmatter for color rules and Group by, the index change event).
//
// The shapes below are the section 8.5 contract (plus `cardValue`, `cardProperties` and
// `includeAttachments`), kept by hand without the `| null` the generated `bindings.ts` adds to
// every Rust `Option` so the rest of the web half reads them as plain optional fields. The
// generated file (tauri-specta, Rust half in `../rust/`) is the wire truth; `graph-ipc.test.ts`
// ties it to the manifest. Tests mock this module, so nothing else reaches the backend.
import { invoke } from "@tauri-apps/api/core";
import { featureInvoke } from "@/lib/features/ipc";
import { onIndexChanged as onCoreIndexChanged } from "@/lib/content-search";
import manifest from "../feature.json";

export type GraphNode = {
  id: number;
  /** Vault-relative path (graphology key). A missing note has its link text here. */
  path: string;
  name: string;
  folder: string;
  ext: string;
  degreeIn: number;
  degreeOut: number;
  tags: string[];
  unresolved?: boolean;
  /** The value of the first of the requested `cardProperties` that this note has set (a `type`,
   *  `status` or enum property), as text. Shown on the close-up card; absent when none is set. */
  cardValue?: string | null;
};

export type GraphEdgeKind = "link" | "embed" | "property";

export type GraphEdge = {
  id: number;
  src: number;
  dst: number | null;
  kind: GraphEdgeKind;
  label?: string;
  target: string;
  ambiguous?: boolean;
};

export type GraphSlice = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  epoch: number;
};

export type GraphSliceArgs = {
  /** Vault-relative path of the center note; none means the whole vault. */
  center?: string;
  depth?: 1 | 2 | 3;
  kinds?: GraphEdgeKind[];
  labels?: string[];
  folders?: string[];
  tags?: string[];
  includeUnresolved?: boolean;
  /** Reserved, changes nothing: tag nodes are built here from `GraphNode.tags`. */
  includeTags?: boolean;
  /** Also return non-markdown files (images, PDFs); off by default. */
  includeAttachments?: boolean;
  limit?: number;
  /** Property names in priority order for `GraphNode.cardValue` (the setting
   *  `graph.card-properties`, default `type`, `status`). */
  cardProperties?: string[];
};

export type GraphStats = { notes: number; edges: number; unresolved: number; components: number };

export interface GraphCommands {
  graph_slice: { args: { request: GraphSliceArgs }; result: GraphSlice };
  graph_stats: { args: undefined; result: GraphStats };
  graph_config_read: { args: undefined; result: string | null };
  graph_config_write: { args: { content: string }; result: null };
}

const call = featureInvoke<GraphCommands>(manifest.id, manifest.rust.commands);

export function graphSlice(args: GraphSliceArgs): Promise<GraphSlice> {
  return call("graph_slice", { request: args });
}

export function graphStats(): Promise<GraphStats> {
  return call("graph_stats");
}

/** The raw text of `.writer/graph.json` (section 6 of SPECs/graph-view-spec.md), or `null` when
 *  the vault has none yet. The Rust half confines it to the vault and writes it atomically. */
export function graphConfigRead(): Promise<string | null> {
  return call("graph_config_read");
}

export async function graphConfigWrite(content: string): Promise<void> {
  await call("graph_config_write", { content });
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
