import { definePageKind } from "./types";

/** The camera of a graph tab (sigma's normalised camera state), restored with the session. */
export type GraphCamera = { x: number; y: number; ratio: number };

/**
 * The global graph (SPECs/graph-view-spec.md). `center` is the note the tab centers on (and its
 * neighbourhood when `depth` is set by "Focus here"); `camera` and `pins` are per tab state kept
 * in the session, never in the vault (pins are keyed by vault-relative note path).
 */
export type GraphLocation = {
  kind: "graph";
  center?: string;
  depth?: number;
  camera?: GraphCamera;
  pins?: Record<string, [number, number]>;
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function cameraOf(v: unknown): GraphCamera | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { x, y, ratio } = v as Record<string, unknown>;
  return isNum(x) && isNum(y) && isNum(ratio) && ratio > 0 ? { x, y, ratio } : undefined;
}

function pinsOf(v: unknown): Record<string, [number, number]> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, [number, number]> = {};
  for (const [path, xy] of Object.entries(v)) {
    if (Array.isArray(xy) && isNum(xy[0]) && isNum(xy[1])) out[path] = [xy[0], xy[1]];
  }
  return Object.keys(out).length ? out : undefined;
}

/** The location with the optional fields that are set (no `undefined` keys: they are compared). */
function withState(l: GraphLocation, state: Partial<Omit<GraphLocation, "kind">>): GraphLocation {
  const next = { ...l, ...state };
  for (const k of ["center", "depth", "camera", "pins"] as const) {
    if (next[k] === undefined) delete next[k];
  }
  return next;
}

// The view (GraphView) is the `graph` feature's, registered in `./views`; off, the tab shows the
// "turned off" page. A graph is not a document: it claims no path and has no primary path.
export const graphKind = definePageKind<"graph", GraphLocation>({
  kind: "graph",
  title: () => "Graph",
  description: "Graph of notes and links",
  keepAlive: true,
  loadsDocument: false,
  feature: "graph",
  fromPayload: (data) =>
    withState(
      { kind: "graph" },
      {
        center: typeof data.center === "string" && data.center ? data.center : undefined,
        depth: isNum(data.depth) ? data.depth : undefined,
        camera: cameraOf(data.camera),
        pins: pinsOf(data.pins),
      },
    ),
  rewritePath: (l, from, to) =>
    withState(l, {
      center: l.center === from ? to : l.center,
      pins: l.pins && from in l.pins ? renameKey(l.pins, from, to) : l.pins,
    }),
  removePath: (l, path) =>
    withState(l, {
      center: l.center === path ? undefined : l.center,
      pins: l.pins && path in l.pins ? dropKey(l.pins, path) : l.pins,
    }),
  serialize: (l) => {
    const { kind: _kind, ...rest } = withState(l, {});
    return rest;
  },
});

function renameKey<T>(rec: Record<string, T>, from: string, to: string): Record<string, T> {
  const { [from]: moved, ...rest } = rec;
  return { ...rest, [to]: moved as T };
}

function dropKey<T>(rec: Record<string, T>, key: string): Record<string, T> | undefined {
  const { [key]: _gone, ...rest } = rec;
  return Object.keys(rest).length ? rest : undefined;
}

export { withState as withGraphState };
