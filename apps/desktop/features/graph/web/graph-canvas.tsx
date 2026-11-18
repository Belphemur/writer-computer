// The canvas: react-sigma hosts sigma (WebGL) over the shared graphology model. React renders the
// chrome only; every node and edge is styled by the reducers (`reducers.ts`) from a mutable view
// state, which is why hover, search and zoom thresholds never re-render React per node. The
// controller below wires the model sync, the ForceAtlas2 worker (`layout.ts`), group hulls,
// pointer events (clicks through link activation), drag-to-pin and keyboard navigation.
import { SigmaContainer, useRegisterEvents, useSigma } from "@react-sigma/core";
import "@react-sigma/core/lib/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { showNativeContextMenu } from "@/components/editor-area/editor-context-menu";
import type { GraphCamera } from "@/components/editor-area/page-kinds";
import { logger } from "@/lib/logger";
import { keyIntent, type LinkIntent } from "@/lib/link-activation";
import { nodeClick, nodeMenu, intentOf, type MenuHandlers } from "./actions";
import { syncGroups, type GroupsResult } from "./groups";
import type { Overview } from "./aggregate";
import { CardsLayer, pickCards, type CardData } from "./cards-layer";
import { anyInView, createFollow, fitTarget, sameTarget, type Point } from "./camera-fit";
import { attachHulls } from "./hulls";
import {
  atLeast,
  cardPriorityKeys,
  edgeLabelsRendered,
  fadeAt,
  hubRanks,
  LOD_HYSTERESIS,
  LOD_TABLE,
  levelFor,
  type LabelMode,
  ratioForSpacing,
  spacingPx,
} from "./lod";
import { attachOverview } from "./overview";
import { DIRECTION_KEYS, pickNeighbor } from "./keyboard";
import { createLayout, type Forces, type Layout } from "./layout";
import {
  applySpec,
  createModel,
  type EdgeAttrs,
  type GraphModel,
  type GraphSpec,
  type NodeAttrs,
} from "./model";
import { edgeStyle, edgeTitle, neighborsOf, nodeStyle, type ViewState } from "./reducers";
import { primitives, SIGMA_SETTINGS } from "./sigma-options";
import { FALLBACK_THEME, readTheme, type GraphTheme } from "./theme";

/** What a parent can ask of the canvas. */
export interface CanvasApi {
  fit(): void;
  centerOn(key: string): void;
  unpinAll(): void;
  unpin(key: string): void;
  /** Pinned notes (vault-relative path) of the layout. */
  isPinned(key: string): boolean;
}

export interface GraphCanvasProps {
  spec: GraphSpec;
  groups: GroupsResult;
  forces: Forces;
  animate: boolean;
  /** Scales the level-of-detail boundaries (the "Label zoom" setting; above 1 shows detail sooner). */
  labelRatio: number;
  /** How node labels show (`lod.ts`, the Display section of the panel). */
  labelMode: LabelMode;
  /** The aggregated overview (group bubbles), or null when the flat hubs overview applies. */
  overview: Overview | null;
  center: string | null;
  propertyLabels: readonly string[];
  /** Search matches, or null without a search. */
  matches: ReadonlySet<string> | null;
  isActive: boolean;
  camera?: GraphCamera;
  pins?: Record<string, [number, number]>;
  onCameraChange?: (camera: GraphCamera) => void;
  onPinsChange?: (pins: Record<string, [number, number]>) => void;
  /** A node was clicked (or Enter on the focused one) with the link-activation intent. */
  onOpenNode: (node: NodeAttrs, intent: LinkIntent) => void;
  menuHandlers: Omit<MenuHandlers, "selection">;
  onEdgeHover?: (hover: { title: string; x: number; y: number } | null) => void;
  onSelection?: (paths: string[]) => void;
  onFocusNode?: (key: string | null) => void;
  onContextLost?: () => void;
  apiRef?: React.MutableRefObject<CanvasApi | null>;
  /** Bumped to center the camera on `centerRequest.key`. */
  centerRequest?: { key: string; n: number } | null;
  /** A frame of `spec` was drawn (the end of the layout phase, `progress.ts`). */
  onFrame?: (spec: GraphSpec) => void;
}

const CAMERA_SAVE_MS = 400;

function Controller(
  props: GraphCanvasProps & { model: GraphModel; view: React.MutableRefObject<ViewState> },
) {
  const { model, view, ...p } = props;
  const sigma = useSigma<NodeAttrs, EdgeAttrs>();
  const register = useRegisterEvents();
  const latest = useRef(p);
  latest.current = p;

  const theme = useRef<GraphTheme>(FALLBACK_THEME);
  const layout = useRef<Layout | null>(null);
  const hulls = useRef<ReturnType<typeof attachHulls> | null>(null);
  const loaded = useRef(false);
  const overviewLayer = useRef<ReturnType<typeof attachOverview> | null>(null);
  const [cards, setCards] = useState<CardData[]>([]);
  const fadeFrame = useRef<number | null>(null);
  const follow = useRef(createFollow());

  const patchView = (patch: Partial<ViewState>) => {
    view.current = { ...view.current, ...patch };
    sigma.scheduleRefresh();
  };

  // Theme: resolved from the app's CSS variables, again when the theme flips.
  useEffect(() => {
    const el = sigma.getContainer();
    const apply = () => {
      theme.current = readTheme(el);
      patchView({ theme: theme.current });
      hulls.current?.redraw();
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    return () => mo.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigma]);

  // Layout supervisor and hulls: one each per sigma instance.
  useEffect(() => {
    layout.current = createLayout(model, latest.current.forces, { onSettle: () => settle() });
    layout.current.setAnimate(latest.current.animate);
    hulls.current = attachHulls(sigma, model, {
      // Clusters keep their hull, name and count from the structure level up (the overview level
      // draws one bubble per cluster instead).
      groups: () => (atLeast(view.current.level, "structure") ? latest.current.groups.groups : []),
      labelColor: () => theme.current.label,
    });
    overviewLayer.current = attachOverview(sigma, model, {
      overview: () => latest.current.overview,
      level: () => view.current.level,
      fade: () => view.current.fade,
      labelColor: () => theme.current.label,
    });
    return () => {
      overviewLayer.current?.dispose();
      overviewLayer.current = null;
      hulls.current?.dispose();
      hulls.current = null;
      if (fadeFrame.current !== null) cancelAnimationFrame(fadeFrame.current);
      layout.current?.destroy();
      layout.current = null;
    };
  }, [sigma, model]);

  useEffect(() => {
    layout.current?.setAnimate(p.animate);
  }, [p.animate]);
  useEffect(() => {
    layout.current?.setForces(p.forces);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.forces.center, p.forces.repel, p.forces.linkDistance, p.forces.groupPull]);
  useEffect(() => {
    layout.current?.setVisible(p.isActive);
  }, [p.isActive]);

  const emitPins = () => latest.current.onPinsChange?.(layout.current?.pins() ?? {});

  // Model sync: the spec and the groups, in place.
  useEffect(() => {
    const first = !loaded.current;
    const applied = applySpec(model, p.spec);
    if (first) {
      for (const [path, [x, y]] of Object.entries(p.pins ?? {})) {
        if (model.hasNode(path)) model.mergeNodeAttributes(path, { x, y, fixed: true });
      }
    }
    const anchors = syncGroups(model, p.groups, p.forces.groupPull);
    patchView({
      propertyLabels: p.propertyLabels,
      center: p.center,
      hubRank: hubRanks(p.spec.nodes),
      order: p.spec.nodes.length,
      groupedOverview: p.overview?.mode === "groups",
    });
    updateLevel();
    const restoring = first && model.order > 0 && p.camera !== undefined;
    if (applied.structural || anchors) {
      if (!restoring) follow.current.newLayout();
      layout.current?.start();
    }
    hulls.current?.redraw();
    if (model.order > 0) {
      const drawn = p.spec;
      sigma.once("afterRender", () => latest.current.onFrame?.(drawn));
    }
    if (first && model.order > 0) {
      loaded.current = true;
      const camera = sigma.getCamera();
      if (p.camera) {
        camera.setState({ ...camera.getState(), ...p.camera });
        follow.current.restore();
      } else void camera.reset({ duration: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.spec, p.groups, p.propertyLabels, p.overview]);

  useEffect(() => patchView({ matches: p.matches }), [p.matches]); // eslint-disable-line react-hooks/exhaustive-deps

  // The label mode changes what is drawn, never the layout or the data: a view patch and a refresh.
  useEffect(() => {
    patchView({ labelMode: p.labelMode });
    syncEdgeLabels();
    if (p.labelMode !== "hover") return;
    setCards([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.labelMode]);

  /** Sigma draws edge labels (property names) per label mode and level; the reducer picks edges. */
  const syncEdgeLabels = () => {
    const on = edgeLabelsRendered(view.current.labelMode, view.current.level);
    if (sigma.getSetting("renderEdgeLabels") !== on) sigma.setSetting("renderEdgeLabels", on);
  };

  const fit = () => {
    follow.current.newLayout();
    fitCamera(latest.current.animate);
  };

  const centerOn = (key: string) => {
    const d = sigma.getNodeDisplayData(key);
    if (!d) return;
    const camera = sigma.getCamera();
    const target = { x: d.x, y: d.y, ratio: Math.min(camera.getState().ratio, 0.6) };
    if (latest.current.animate) void camera.animate(target, { duration: 300 });
    else camera.setState({ ...camera.getState(), ...target });
  };

  /** The notes (hidden group anchors excluded) in the camera's framed space, or in pixels. */
  const notePoints = (to: "framed" | "viewport"): Point[] => {
    const out: Point[] = [];
    model.forEachNode((_key, a) => {
      if (a.anchor) return;
      out.push(
        to === "framed"
          ? sigma.graphToFramedGraph({ x: a.x, y: a.y })
          : sigma.graphToViewport({ x: a.x, y: a.y }),
      );
    });
    return out;
  };

  /** THE fit: the camera takes in every note with padding (animated unless reduced motion; the
   *  follow during a layout is instant). Used by the layout's follow, its settle, the toolbar's Fit
   *  and the F key. */
  const fitCamera = (animate: boolean) => {
    const camera = sigma.getCamera();
    const target = fitTarget(notePoints("framed"));
    if (!target) return void camera.reset({ duration: 0 });
    const now = camera.getState();
    if (sameTarget(target, now)) return;
    if (animate) void camera.animate(target, { duration: 300 });
    else camera.setState({ ...now, ...target });
  };

  /** The layout settled: fit for good if the camera follows, or if the saved view shows nothing. */
  const settle = () => {
    const { width, height } = sigma.getDimensions();
    const empty = !anyInView(notePoints("viewport"), width, height);
    logger.log(
      "debug",
      "app",
      `graph settled: ${model.order} nodes, camera ratio ${sigma.getCamera().getState().ratio.toFixed(3)}, level ${view.current.level}, following ${follow.current.isFollowing()}, empty view ${empty}`,
    );
    if (follow.current.isFollowing() || empty) {
      fitCamera(latest.current.animate);
      follow.current.newLayout();
    }
  };

  // While a layout runs the camera follows the growing box until the user takes over.
  useEffect(() => {
    const onRender = () => {
      if (follow.current.isFollowing() && layout.current?.isRunning()) fitCamera(false);
    };
    sigma.on("afterRender", onRender);
    return () => {
      sigma.off("afterRender", onRender);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigma]);

  // Sigma resizes on window resize only: a pane, tab or side panel that changes the container
  // would leave the canvas the wrong size, so the container is observed.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      sigma.resize();
      sigma.scheduleRefresh();
      updateLevel();
      if (follow.current.isFollowing()) fitCamera(false);
    });
    ro.observe(sigma.getContainer());
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigma]);

  useEffect(() => {
    if (p.centerRequest) centerOn(p.centerRequest.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.centerRequest?.n]);

  /** The level of detail the camera asks for now; on a change the scene fades in. */
  const updateLevel = () => {
    const { width, height } = sigma.getDimensions();
    const ratio = sigma.getCamera().getState().ratio;
    const spacing = spacingPx(ratio, view.current.order, width, height);
    const level = levelFor(spacing, view.current.level, latest.current.labelRatio);
    if (level === view.current.level) return;
    const detailed = atLeast(level, "detail");
    if (sigma.getSetting("enableEdgeEvents") !== detailed)
      sigma.setSetting("enableEdgeEvents", detailed);
    startFade({ level });
    syncEdgeLabels();
    if (level !== "closeup") setCards([]);
    hulls.current?.redraw();
    overviewLayer.current?.redraw();
  };

  /** Applies `patch` with the scene faded down, then back up (instant without motion). */
  const startFade = (patch: Partial<ViewState>) => {
    if (fadeFrame.current !== null) cancelAnimationFrame(fadeFrame.current);
    fadeFrame.current = null;
    if (!latest.current.animate) {
      patchView({ ...patch, fade: 1 });
      return;
    }
    const t0 = performance.now();
    patchView({ ...patch, fade: fadeAt(0, true) });
    const step = () => {
      const fade = fadeAt(performance.now() - t0, true);
      patchView({ fade });
      fadeFrame.current = fade < 1 ? requestAnimationFrame(step) : null;
    };
    fadeFrame.current = requestAnimationFrame(step);
  };

  /** Close-up cards: the nodes in view, capped, and their sigma labels hidden. */
  const refreshCards = () => {
    if (view.current.level !== "closeup") return;
    const { width, height } = sigma.getDimensions();
    const nodes: { key: string; attrs: NodeAttrs; x: number; y: number }[] = [];
    model.forEachNode((key, attrs) => {
      if (attrs.anchor) return;
      const p = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
      nodes.push({ key, attrs, x: p.x, y: p.y });
    });
    const mode = view.current.labelMode;
    const priority = cardPriorityKeys(mode, view.current);
    const next = pickCards(nodes, width, height, priority, undefined, mode === "hover");
    setCards(next);
    const keys = next.map((c) => c.key).join("\u0000");
    if (keys !== [...view.current.cardKeys].join("\u0000")) {
      patchView({ cardKeys: new Set(next.map((c) => c.key)) });
    }
  };

  /** Click on a group bubble: zoom to the group until it is drawn as nodes. */
  const zoomToGroup = (key: string) => {
    const bubble = latest.current.overview?.bubbles.find((b) => b.key === key);
    if (!bubble) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const m of bubble.members) {
      if (!model.hasNode(m)) continue;
      const f = sigma.graphToFramedGraph({
        x: model.getNodeAttribute(m, "x"),
        y: model.getNodeAttribute(m, "y"),
      });
      x0 = Math.min(x0, f.x);
      y0 = Math.min(y0, f.y);
      x1 = Math.max(x1, f.x);
      y1 = Math.max(y1, f.y);
    }
    if (!Number.isFinite(x0)) return;
    const { width, height } = sigma.getDimensions();
    const structure = LOD_TABLE[1].minSpacing * (1 + LOD_HYSTERESIS) * 1.1;
    const levelRatio = ratioForSpacing(
      structure / latest.current.labelRatio,
      view.current.order,
      width,
      height,
    );
    const ratio = Math.min(Math.max(x1 - x0, y1 - y0) * 1.3, levelRatio);
    const target = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, ratio };
    const camera = sigma.getCamera();
    if (latest.current.animate) void camera.animate(target, { duration: 400 });
    else camera.setState({ ...camera.getState(), ...target });
  };

  // Camera: the level of detail and the saved state.
  useEffect(() => {
    const camera = sigma.getCamera();
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      const { x, y, ratio } = camera.getState();
      // A tooltip of an edge that moved or was hidden would otherwise stay (no leave event).
      latest.current.onEdgeHover?.(null);
      updateLevel();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(
        () => latest.current.onCameraChange?.({ x, y, ratio }),
        CAMERA_SAVE_MS,
      );
    };
    camera.on("updated", onUpdate);
    onUpdate();
    sigma.on("afterRender", refreshCards);
    return () => {
      camera.off("updated", onUpdate);
      sigma.off("afterRender", refreshCards);
      if (saveTimer) clearTimeout(saveTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigma, p.labelRatio]);

  // Pointer events.
  useEffect(() => {
    const nodeAt = (key: string) => model.getNodeAttributes(key);
    register({
      enterNode: ({ node }) =>
        patchView({ hovered: node, hoverNeighbors: neighborsOf(model, node) }),
      leaveNode: () => patchView({ hovered: null, hoverNeighbors: new Set() }),
      enterEdge: ({ edge, event }) =>
        latest.current.onEdgeHover?.({
          title: edgeTitle(model.getEdgeAttributes(edge)),
          x: event.x,
          y: event.y,
        }),
      leaveEdge: () => latest.current.onEdgeHover?.(null),
      clickStage: ({ event }) => {
        const group = overviewLayer.current?.hit(event.x, event.y);
        if (group) zoomToGroup(group);
        else if (view.current.selection.size > 0) {
          patchView({ selection: new Set() });
          latest.current.onSelection?.([]);
        }
      },
      clickNode: ({ node, event }) => {
        const intent = intentOf(event.original);
        if (!intent) return;
        const a = nodeAt(node);
        const result = nodeClick(intent, event.original.shiftKey, view.current.selection, a.path);
        if ("open" in result) {
          latest.current.onOpenNode(a, result.open);
          return;
        }
        patchView({ selection: result.selection });
        latest.current.onSelection?.([...result.selection]);
      },
      rightClickNode: ({ node, event }) => {
        event.original.preventDefault();
        event.preventSigmaDefault();
        const a = nodeAt(node);
        const handlers: MenuHandlers = {
          ...latest.current.menuHandlers,
          selection: () => [...view.current.selection],
        };
        void showNativeContextMenu(nodeMenu(a, handlers), { x: event.x, y: event.y });
      },
      doubleClickNode: ({ node, event }) => {
        event.preventSigmaDefault();
        latest.current.onOpenNode(nodeAt(node), "current");
      },
      downNode: () => follow.current.userMoved(),
      downStage: () => follow.current.userMoved(),
      wheelStage: () => follow.current.userMoved(),
      nodeDragStart: () => {
        follow.current.userMoved();
        layout.current?.stop();
      },
      nodeDragEnd: ({ node }) => {
        const a = nodeAt(node);
        layout.current?.pin(node, a.x, a.y);
        emitPins();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, model]);

  useEffect(() => {
    const onLost = () => latest.current.onContextLost?.();
    sigma.on("webglContextLost", onLost);
    return () => {
      sigma.off("webglContextLost", onLost);
    };
  }, [sigma]);

  // Keyboard: arrows between neighbours, Enter opens, F fits, Escape clears.
  useEffect(() => {
    const el = sigma.getContainer();
    el.tabIndex = 0;
    el.setAttribute("role", "application");
    el.setAttribute("aria-label", "Graph. Arrow keys move between linked notes, Enter opens one.");
    const setFocus = (key: string | null) => {
      patchView({ focus: key });
      latest.current.onFocusNode?.(key);
      if (key) centerOn(key);
    };
    const onKey = (e: KeyboardEvent) => {
      const focus = view.current.focus;
      const dir = DIRECTION_KEYS[e.key];
      if (dir) {
        e.preventDefault();
        const from =
          focus ??
          latest.current.center ??
          model.nodes().find((n) => !model.getNodeAttribute(n, "anchor")) ??
          null;
        if (from === null || !model.hasNode(from)) return;
        if (focus === null) return setFocus(from);
        const at = (k: string) => {
          const d = sigma.getNodeDisplayData(k);
          return d ? sigma.framedGraphToViewport({ x: d.x, y: d.y }) : { x: 0, y: 0 };
        };
        const candidates = model
          .neighbors(from)
          .filter((k) => !model.getNodeAttribute(k, "anchor"))
          .map((k) => ({ key: k, at: at(k) }));
        const next = pickNeighbor(at(from), candidates, dir);
        if (next) setFocus(next);
      } else if (e.key === "Enter" && focus && model.hasNode(focus)) {
        const intent = keyIntent(e);
        if (intent) latest.current.onOpenNode(model.getNodeAttributes(focus), intent);
      } else if (e.key === "Escape") {
        patchView({ focus: null, selection: new Set() });
        latest.current.onSelection?.([]);
        latest.current.onFocusNode?.(null);
      } else if (e.key === "f" || e.key === "F") {
        if (!e.metaKey && !e.ctrlKey) fit();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigma, model]);

  useEffect(() => {
    if (!p.apiRef) return;
    p.apiRef.current = {
      fit,
      centerOn,
      unpinAll: () => {
        layout.current?.unpinAll();
        emitPins();
      },
      unpin: (key) => {
        layout.current?.unpin(key);
        emitPins();
      },
      isPinned: (key) => model.hasNode(key) && model.getNodeAttribute(key, "fixed") === true,
    };
    return () => {
      if (p.apiRef) p.apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigma, p.apiRef]);

  return cards.length > 0 && view.current.level === "closeup" ? <CardsLayer cards={cards} /> : null;
}

/** Is WebGL 2 available? Sigma 4 needs it; without it the view shows the node list instead. */
export function webglAvailable(): boolean {
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

export function GraphCanvas(props: GraphCanvasProps) {
  const model = useMemo(() => createModel(), []);
  const view = useRef<ViewState>(defaultView(props));
  // The reducers read `view.current`, which the controller keeps up to date: no React render per
  // hover or zoom step, sigma just refreshes.
  const options = useMemo(
    () => ({
      primitives,
      settings: SIGMA_SETTINGS,
      nodeReducer: (key: string, _d: unknown, a: NodeAttrs) => nodeStyle(key, a, view.current),
      edgeReducer: (
        key: string,
        _d: unknown,
        a: EdgeAttrs,
        _state: unknown,
        _gs: unknown,
        g: GraphModel,
      ) => edgeStyle(a, g.source(key), g.target(key), view.current),
    }),
    [],
  );
  return (
    <SigmaContainer
      graph={model}
      options={options as never}
      style={{ width: "100%", height: "100%", background: "transparent" }}
    >
      <Controller {...props} model={model} view={view} />
    </SigmaContainer>
  );
}

function defaultView(
  p: Pick<GraphCanvasProps, "center" | "matches" | "propertyLabels" | "labelMode">,
): ViewState {
  return {
    hovered: null,
    hoverNeighbors: new Set(),
    focus: null,
    center: p.center,
    matches: p.matches,
    selection: new Set(),
    level: "detail",
    labelMode: p.labelMode,
    groupedOverview: false,
    hubRank: new Map(),
    order: 0,
    cardKeys: new Set(),
    fade: 1,
    theme: FALLBACK_THEME,
    propertyLabels: p.propertyLabels,
  };
}
