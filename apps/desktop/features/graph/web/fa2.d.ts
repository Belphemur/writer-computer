// The ForceAtlas2 package ships its single-step iteration and defaults as plain CommonJS files with
// no typings; the worker core uses exactly these two (`iterate.js` is what the package's own worker
// runs per batch).
declare module "graphology-layout-forceatlas2/iterate.js" {
  export default function iterate(
    settings: Record<string, unknown>,
    nodes: Float32Array,
    edges: Float32Array,
  ): void;
}
declare module "graphology-layout-forceatlas2/defaults.js" {
  const defaults: Record<string, unknown>;
  export default defaults;
}
