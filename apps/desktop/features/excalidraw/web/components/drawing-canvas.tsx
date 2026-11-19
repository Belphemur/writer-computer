import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { logger } from "@/lib/logger";
import { elementLinkIntent, openElementLink } from "../lib/element-links";
import "../drawing.css";
import type { ExcalidrawApi } from "../lib/excalidraw-lib";
import type { SceneElement } from "../lib/excalidraw-md";
import { acquireDrawingSession, type AcquiredSession } from "../lib/sessions";

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

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; held: AcquiredSession };

/**
 * Excalidraw's canvas over one drawing file: the one host behind the drawing tab and the full
 * screen of an embed. It holds the file's shared session (`lib/sessions.ts`), so two canvases on
 * one file are one drawing; the theme follows the app. It fills its parent (the parent sizes it)
 * and owns no scroller (docs/design.md). Keys are Excalidraw's own and work with the canvas
 * focused; app shortcuts are the registry's.
 */
export function DrawingCanvas({
  path,
  topRight,
  viewMode = false,
  autoFocus = false,
  beforeVaultLink,
}: {
  path: string;
  /** Read-only: pan, zoom and follow links, no editing (Excalidraw's `viewModeEnabled`). */
  viewMode?: boolean;
  /** Focus the canvas when it mounts. */
  autoFocus?: boolean;
  /** Called before an element link opens a note here or in an active tab (a full screen closes). */
  beforeVaultLink?: () => void;
  /** Extra controls in the canvas's top right corner. */
  topRight?: () => ReactNode;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const theme = useAppTheme();
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let live = true;
    let held: AcquiredSession | null = null;
    setState({ status: "loading" });
    acquireDrawingSession(path).then(
      (h) => {
        if (!live) return h.release();
        held = h;
        setState({ status: "ready", held: h });
      },
      (e: unknown) => {
        logger.error("excalidraw", `the editor did not open: ${String(e)}`);
        if (live) {
          setState({
            status: "error",
            message:
              e instanceof Error && e.message ? e.message : "The drawing editor did not load.",
          });
        }
      },
    );
    return () => {
      live = false;
      detachRef.current?.();
      detachRef.current = null;
      held?.release();
    };
  }, [path]);

  const held = state.status === "ready" ? state.held : null;
  const onApi = useCallback(
    (api: ExcalidrawApi) => {
      detachRef.current?.();
      apiRef.current = api;
      detachRef.current = held?.session.attach(api) ?? null;
    },
    [held],
  );
  const onChange = useCallback(
    (elements: readonly SceneElement[], appState: Record<string, unknown>, files: never) => {
      const api = apiRef.current;
      if (api) held?.session.handleChange(elements, appState, files, api);
    },
    [held],
  );

  // Element links open through Writer's link handling; Excalidraw never navigates the webview.
  const onLinkOpen = useCallback(
    (element: { link: string | null }, event: CustomEvent) => {
      event.preventDefault();
      if (!element.link) return;
      openElementLink(element.link, path, elementLinkIntent(event.detail), {
        beforeVaultOpen: beforeVaultLink,
      });
    },
    [path, beforeVaultLink],
  );

  // the canvas owns its state after the first render; a theme change goes through the prop
  const initialData = useMemo(() => {
    if (!held) return null;
    const initial = held.session.initial();
    return {
      elements: initial.elements,
      appState: { ...initial.appState, theme },
      files: initial.files,
      scrollToContent: true,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held]);

  if (state.status === "loading")
    return <Message testId="drawing-loading">Loading drawing</Message>;
  if (state.status === "error") return <Message testId="drawing-error">{state.message}</Message>;
  const { lib } = state.held;
  return (
    <div
      data-testid="drawing-stage"
      data-drawing-canvas
      className="writer-drawing relative h-full min-h-0 overflow-clip"
    >
      <lib.Excalidraw
        initialData={initialData}
        excalidrawAPI={onApi}
        onChange={onChange}
        onLinkOpen={onLinkOpen as never}
        theme={theme}
        viewModeEnabled={viewMode}
        autoFocus={autoFocus}
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
        renderTopRightUI={topRight}
      />
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
