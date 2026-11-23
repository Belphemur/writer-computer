import { useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Menu01Icon } from "@hugeicons/core-free-icons";
import { detectPlatform, MENU_BUTTON } from "@/lib/platform";
import { isKeyRecording } from "@/lib/keybindings/recording";
import { logger } from "@/lib/logger";
import { openAppMenu } from "@/lib/tauri";

function open() {
  openAppMenu().catch((e: unknown) =>
    logger.warn("app-menu", `opening the app menu failed: ${String(e)}`),
  );
}

/** Alt pressed and released alone opens the menu, as it does for a menu bar. It listens in the
 *  capture phase, so a key another handler stops still cancels it (Alt+Left, Alt+Tab); text being
 *  composed, a key being recorded on the Hotkeys page, the wheel, a click and a blur cancel it
 *  too, and a release with Ctrl, Shift or Meta held (Ctrl+Alt) opens nothing. Registers nothing
 *  unless `enabled` (Linux). */
export function useAltOpensMenu(onOpen: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let armed = false;
    const disarm = () => {
      armed = false;
    };
    const down = (e: KeyboardEvent) => {
      if (e.isComposing || isKeyRecording() || e.key !== "Alt") return disarm();
      if (e.ctrlKey || e.shiftKey || e.metaKey) return disarm();
      if (!e.repeat) armed = true;
    };
    const up = (e: KeyboardEvent) => {
      const open =
        armed && e.key === "Alt" && !e.isComposing && !e.ctrlKey && !e.shiftKey && !e.metaKey;
      armed = false;
      if (open) onOpen();
    };
    const opts = { capture: true } as const;
    window.addEventListener("keydown", down, opts);
    window.addEventListener("keyup", up, opts);
    window.addEventListener("pointerdown", disarm, opts);
    window.addEventListener("wheel", disarm, { capture: true, passive: true });
    window.addEventListener("blur", disarm);
    return () => {
      window.removeEventListener("keydown", down, opts);
      window.removeEventListener("keyup", up, opts);
      window.removeEventListener("pointerdown", disarm, opts);
      window.removeEventListener("wheel", disarm, opts);
      window.removeEventListener("blur", disarm);
    };
  }, [onOpen, enabled]);
}

/** The app menu on Linux: a button at the left of the chrome bar opening the menu `app_menu.rs`
 *  defines (macOS has the native menu bar, so nothing renders there). */
export function AppMenuButton() {
  const isLinux = detectPlatform() === "linux";
  useAltOpensMenu(open, isLinux);
  if (!isLinux) return null;
  return (
    <button
      type="button"
      onClick={open}
      aria-label="Menu"
      title="Menu"
      style={{ left: MENU_BUTTON.edge, width: MENU_BUTTON.width }}
      className="group pointer-events-auto absolute top-1/2 flex h-7 -translate-y-1/2 items-center justify-center rounded-md text-[var(--fg-base)] transition-colors hover:bg-[var(--surface-subtle)] hover:transition-none"
    >
      <span className="opacity-60 transition-opacity group-hover:opacity-100 group-hover:transition-none">
        <HugeiconsIcon icon={Menu01Icon} size={18} color="currentColor" strokeWidth={2} />
      </span>
    </button>
  );
}
