import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import type { DrawingLocation } from "@/components/editor-area/page-kinds/drawing";
import type { PageViewProps } from "@/lib/features/slots";
import { logger } from "@/lib/logger";
import { getFileName } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import "../drawing.css";
import { useDiskStore } from "../disk-sync";
import { loadDrawingText, saveDrawing, type Loaded } from "../lib/drawing-file";
import { prefersReducedMotion } from "../lib/draw-in";
import { loadExcalidraw, type ExcalidrawApi, type ExcalidrawLib } from "../lib/excalidraw-lib";
import { exportSvgFile, scheduleAutoExport, svgPathOf } from "../lib/export-svg";
import { registerLiveView } from "../lib/live-views";
import { DrawingSession } from "../lib/session";
import { offerTakeover } from "../lib/takeover";
import type { SceneElement } from "../lib/excalidraw-md";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; lib: ExcalidrawLib; loaded: Loaded };

/** The app's light or dark, from the attribute `lib/theme.ts` keeps on the root element. */
function useAppTheme(): "light" | "dark" {
  const read = () =>
    document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * The drawing tab (page kind `drawing`, slot `page-view:drawing`): Excalidraw's canvas over one
 * file, theme following the app, saved a moment after every change through the codec and
 * reloaded, merged by id and version, when the file changes from outside (docs/design.md: it
 * mounts in `PageBody`, owns no scroller of its own, and a kept-alive tab hides when inactive).
 * Keys are Excalidraw's own and work with the canvas focused; app shortcuts are the registry's.
 */
export function DrawingView({ location, isActive }: PageViewProps<DrawingLocation>) {
  const path = location.path;
  const [state, setState] = useState<State>({ status: "loading" });
  const theme = useAppTheme();
  const disk = useDiskStore((s) => s.views[path]);
  const version = disk?.version ?? 0;
  const deleted = disk?.deleted ?? false;
  const sessionRef = useRef<DrawingSession | null>(null);

  useEffect(() => {
    useDiskStore.getState().track(path);
    return () => useDiskStore.getState().forget(path);
  }, [path]);

  useEffect(() => {
    void offerTakeover();
  }, []);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    loadExcalidraw().then(
      async (lib) => {
        const session = new DrawingSession(path, {
          read: async () => (await tauri.readFile(path)).content,
          load: (text) => loadDrawingText(path, text),
          save: (baseline, snapshot) => saveDrawing(path, baseline, snapshot),
          neverCapture: lib.CaptureUpdateAction.NEVER,
          reducedMotion: prefersReducedMotion,
          onSaved: () => scheduleAutoExport(path),
          onProblem: (message) => {
            logger.warn("excalidraw", message);
            showEditorNotice(message);
          },
        });
        try {
          const loaded = await session.open();
          if (!live) return session.dispose();
          sessionRef.current = session;
          setState({ status: "ready", lib, loaded });
        } catch (e) {
          if (live)
            setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
        }
      },
      (e: unknown) => {
        logger.error("excalidraw", `the editor did not load: ${String(e)}`);
        if (live) setState({ status: "error", message: "The drawing editor did not load." });
      },
    );
    return () => {
      live = false;
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, [path]);

  useEffect(
    () =>
      state.status === "ready"
        ? registerLiveView(path, { flush: () => sessionRef.current?.flush() ?? Promise.resolve() })
        : undefined,
    [path, state.status],
  );

  // A change from outside: merge it into the canvas.
  useEffect(() => {
    if (version > 0) void sessionRef.current?.reload();
  }, [version]);

  const onApi = useCallback((api: ExcalidrawApi) => sessionRef.current?.attach(api), []);
  const onChange = useCallback(
    (elements: readonly SceneElement[], appState: Record<string, unknown>, files: never) =>
      sessionRef.current?.handleChange(elements, appState, files),
    [],
  );

  const exportSvg = useCallback(async () => {
    try {
      const svg = await exportSvgFile(path);
      showEditorNotice(`Saved ${getFileName(svg)}`);
    } catch (e) {
      logger.warn("excalidraw", `SVG export failed: ${String(e)}`);
      showEditorNotice("Could not export the drawing as SVG");
    }
  }, [path]);

  const initialData = useMemo(() => {
    if (state.status !== "ready") return null;
    const scene = state.loaded.parsed.scene;
    return {
      elements: scene.elements,
      appState: { ...scene.appState, theme },
      files: state.loaded.files,
      scrollToContent: true,
    };
    // the canvas owns its state after the first render; a theme change goes through the prop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status === "ready" ? state.loaded : null]);

  return (
    <div
      data-pane
      data-testid="drawing-view"
      className={
        isActive
          ? "relative z-10 flex h-full flex-col"
          : "absolute inset-0 invisible pointer-events-none"
      }
    >
      {deleted ? (
        <Message testId="drawing-deleted">This drawing was deleted.</Message>
      ) : state.status === "loading" ? (
        <Message testId="drawing-loading">Loading drawing</Message>
      ) : state.status === "error" ? (
        <Message testId="drawing-error">{state.message}</Message>
      ) : (
        <div
          data-testid="drawing-stage"
          className="writer-drawing relative min-h-0 flex-1 overflow-clip"
        >
          <state.lib.Excalidraw
            initialData={initialData}
            excalidrawAPI={onApi}
            onChange={onChange}
            theme={theme}
            aiEnabled={false}
            handleKeyboardGlobally={false}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                saveAsImage: false,
                toggleTheme: false,
              },
            }}
            renderTopRightUI={() => (
              <button
                type="button"
                data-testid="drawing-export-svg"
                title={`Write ${getFileName(svgPathOf(path))}`}
                onClick={() => void exportSvg()}
                className="rounded-md px-2 py-1 text-[12px] text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
              >
                Export SVG
              </button>
            )}
          />
        </div>
      )}
    </div>
  );
}

function Message({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      data-testid={testId}
      className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--text-muted)]"
    >
      {children}
    </div>
  );
}
