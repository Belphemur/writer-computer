import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Copy01Icon, MinusSignIcon, SquareIcon } from "@hugeicons/core-free-icons";
import { useBooleanSetting } from "@/hooks/use-settings";
import { detectPlatform, drawsWindowControls, WINDOW_CONTROLS } from "@/lib/platform";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowResized,
  toggleMaximizeWindow,
} from "@/lib/tauri";

const BUTTON =
  "group pointer-events-auto flex h-7 items-center justify-center rounded-md text-[var(--fg-base)] transition-colors hover:bg-[var(--surface-subtle)] hover:transition-none";
const BUTTON_STYLE = { width: WINDOW_CONTROLS.buttonWidth };
const GLYPH = "opacity-60 transition-opacity group-hover:opacity-100 group-hover:transition-none";

/** Minimize, maximize and close at the right of the chrome bar, drawn by Writer on Linux (ADR
 *  2026-11-20): the window has no frame there. Nothing renders elsewhere, or when the setting
 *  `appearance.native-decorations` gave the window the desktop's frame back. */
export function WindowControls() {
  const native = useBooleanSetting("appearance.native-decorations", false);
  if (!drawsWindowControls(detectPlatform(), native)) return null;
  return <ControlButtons />;
}

function ControlButtons() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    const sync = () => {
      isWindowMaximized().then(
        (value) => alive && setMaximized(value),
        () => {},
      );
    };
    sync();
    const unlisten = onWindowResized(sync);
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  const label = maximized ? "Restore" : "Maximize";
  return (
    <div
      className="pointer-events-none fixed right-0 top-0 z-50 flex items-center"
      style={{ height: "var(--chrome-bar-height)", paddingRight: WINDOW_CONTROLS.edge }}
    >
      <button
        type="button"
        className={BUTTON}
        style={BUTTON_STYLE}
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void minimizeWindow()}
      >
        <span className={GLYPH}>
          <HugeiconsIcon icon={MinusSignIcon} size={16} color="currentColor" strokeWidth={2} />
        </span>
      </button>
      <button
        type="button"
        className={BUTTON}
        style={BUTTON_STYLE}
        aria-label={label}
        title={label}
        onClick={() => void toggleMaximizeWindow()}
      >
        <span className={GLYPH}>
          <HugeiconsIcon
            icon={maximized ? Copy01Icon : SquareIcon}
            size={14}
            color="currentColor"
            strokeWidth={2}
          />
        </span>
      </button>
      <button
        type="button"
        className={BUTTON}
        style={BUTTON_STYLE}
        aria-label="Close"
        title="Close"
        onClick={() => void closeWindow()}
      >
        <span className={GLYPH}>
          <HugeiconsIcon icon={Cancel01Icon} size={16} color="currentColor" strokeWidth={2} />
        </span>
      </button>
    </div>
  );
}
