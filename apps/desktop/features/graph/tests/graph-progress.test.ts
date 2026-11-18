// The phases before the first drawn frame, in order, and the counts line.
import { describe, expect, it } from "vite-plus/test";
import {
  countsLine,
  derivePhase,
  PHASE_LABEL,
  visiblePhase,
  type PhaseInput,
} from "../web/progress";

const base: PhaseInput = {
  configLoaded: true,
  slice: {},
  fetching: false,
  error: null,
  clustersPending: false,
  nodes: 10,
  framed: true,
};

describe("derivePhase", () => {
  it("goes loading, clusters, layout, ready", () => {
    expect(derivePhase({ ...base, configLoaded: false })).toBe("loading");
    expect(derivePhase({ ...base, slice: null })).toBe("loading");
    expect(derivePhase({ ...base, fetching: true })).toBe("loading");
    expect(derivePhase({ ...base, clustersPending: true, framed: false })).toBe("clusters");
    expect(derivePhase({ ...base, framed: false })).toBe("layout");
    expect(derivePhase(base)).toBe("ready");
  });

  it("an empty graph is ready (nothing to lay out) and an error wins over everything", () => {
    expect(derivePhase({ ...base, nodes: 0, framed: false })).toBe("ready");
    expect(derivePhase({ ...base, slice: null, error: "x" })).toBe("error");
  });

  it("has one short status line per working phase", () => {
    expect(PHASE_LABEL).toEqual({
      loading: "Loading notes…",
      clusters: "Finding clusters…",
      layout: "Laying out…",
    });
  });

  it("does not wait for a canvas that is not drawing", () => {
    expect(visiblePhase("layout", false)).toBe("ready");
    expect(visiblePhase("layout", true)).toBe("layout");
    expect(visiblePhase("loading", false)).toBe("loading");
  });
});

describe("countsLine", () => {
  it("groups thousands and pluralizes", () => {
    expect(countsLine(1284, 3902)).toBe("1,284 notes · 3,902 links");
    expect(countsLine(1, 1)).toBe("1 note · 1 link");
  });
});
