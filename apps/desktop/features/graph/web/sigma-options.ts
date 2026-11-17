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
import { SOLID } from "./reducers";

export const primitives = {
  nodes: {
    shapes: [sdfCircle(), sdfSquare(), sdfDiamond()],
  },
  edges: {
    paths: [pathLine()],
    extremities: [extremityArrow()],
    variables: {
      dash: { type: "number", default: SOLID.dash },
      gap: { type: "number", default: SOLID.gap },
    },
    layers: [
      layerDashed({
        dashSize: { attribute: "dash", default: SOLID.dash, mode: "pixels" },
        gapSize: { attribute: "gap", default: SOLID.gap, mode: "pixels" },
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
