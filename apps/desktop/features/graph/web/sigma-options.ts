// The sigma 4 render declaration: node shapes (circle, square for attachments, diamond for bases),
// one edge program with a dash pattern driven by two edge variables (`dash`, `gap`: a very long dash
// draws solid, the embed edge uses a short one) and an arrow extremity the reducers switch on past a
// zoom threshold. Label density keeps text readable at 10,000 nodes: sigma draws the largest
// (highest degree) labels first within a grid and skips the rest.
import {
  extremityArrow,
  layerDashed,
  pathLine,
  sdfCircle,
  sdfDiamond,
  sdfSquare,
} from "sigma/rendering";
import type { Settings } from "sigma/settings";

export const primitives = {
  nodes: {
    shapes: [sdfCircle(), sdfSquare(), sdfDiamond()],
  },
  edges: {
    paths: [pathLine()],
    extremities: [extremityArrow()],
    variables: {
      dash: { type: "number", default: 100000 },
      gap: { type: "number", default: 1 },
    },
    layers: [
      layerDashed({
        dashSize: { attribute: "dash", default: 100000, mode: "pixels" },
        gapSize: { attribute: "gap", default: 1, mode: "pixels" },
      }),
    ],
    defaultHead: "none",
  },
} as const;

export const SIGMA_SETTINGS: Partial<Settings> = {
  renderLabels: true,
  renderEdgeLabels: false,
  enableEdgeEvents: true,
  enableNodeDrag: true,
  labelDensity: 0.6,
  labelGridCellSize: 120,
  labelRenderedSizeThreshold: 4,
  hideEdgesOnMove: true,
  hideLabelsOnMove: true,
  zoomToSizeRatioFunction: (ratio: number) => Math.sqrt(ratio),
  minCameraRatio: 0.02,
  maxCameraRatio: 20,
};
