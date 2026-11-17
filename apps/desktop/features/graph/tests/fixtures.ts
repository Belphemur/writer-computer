// Shared slices for the graph tests (synthetic names only; never a real vault).
import type { GraphEdge, GraphNode, GraphSlice } from "../web/ipc";

export function node(id: number, path: string, extra: Partial<GraphNode> = {}): GraphNode {
  const name = path.split("/").pop()!;
  return {
    id,
    path,
    name,
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    ext: name.includes(".") ? name.split(".").pop()! : "",
    degreeIn: 0,
    degreeOut: 0,
    tags: [],
    ...extra,
  };
}

export function edge(
  id: number,
  src: number,
  dst: number | null,
  kind: GraphEdge["kind"] = "link",
  label?: string,
): GraphEdge {
  return { id, src, dst, kind, target: `t${dst}`, ...(label ? { label } : {}) };
}

/** a -> b, a embeds c, b --manager--> a, plus a lonely note and a base file. */
export function smallSlice(): GraphSlice {
  return {
    nodes: [
      node(1, "People/Ana.md", { degreeOut: 2, degreeIn: 1, tags: ["person", "team/eng"] }),
      node(2, "People/Ben.md", { degreeOut: 1, degreeIn: 1, tags: ["person"] }),
      node(3, "Notes/Plan.md", { degreeIn: 1 }),
      node(4, "Lonely.md"),
      node(5, "Team.base", { ext: "base" }),
    ],
    edges: [
      edge(1, 1, 2),
      edge(2, 1, 3, "embed"),
      edge(3, 2, 1, "property", "manager"),
      edge(4, 1, 2),
    ],
    truncated: false,
    limit: 10_000,
    epoch: 1,
  };
}

/** A synthetic vault of `n` notes in a ring with some cross links. */
export function bigSlice(n: number): GraphSlice {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(
      node(i + 1, `f${i % 50}/note-${i}.md`, { degreeOut: 3, degreeIn: 3, tags: [`t${i % 7}`] }),
    );
  }
  let id = 1;
  for (let i = 0; i < n; i++) {
    edges.push(edge(id++, i + 1, ((i + 1) % n) + 1));
    edges.push(edge(id++, i + 1, ((i * 7 + 3) % n) + 1));
    edges.push(edge(id++, i + 1, ((i * 13 + 5) % n) + 1, "embed"));
  }
  return { nodes, edges, truncated: n >= 10_000, limit: 10_000, epoch: 1 };
}
