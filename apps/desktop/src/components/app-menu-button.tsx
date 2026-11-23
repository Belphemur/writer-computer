import { useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Menu01Icon } from "@hugeicons/core-free-icons";
import { detectPlatform } from "@/lib/platform";
import { logger } from "@/lib/logger";
import { openAppMenu } from "@/lib/tauri";

const noop = () => {};

function open() {
  openAppMenu().catch((e: unknown) =>
    logger.warn("app-menu", `opening the app menu failed: ${String(e)}`),
  );
}

/** Alt pressed and released alone opens the menu, as it does for a menu bar. Any other key in
 *  between (Alt+Tab, Alt+Left) cancels it. */
export function useAltOpensMenu(onOpen: () => void) {
  useEffect(() => {
    let armed = false;
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Alt") armed = false;
      else if (!e.repeat) armed = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt" && armed) onOpen();
      armed = false;
    };
    const cancel = () => {
      armed = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("pointerdown", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("pointerdown", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [onOpen]);
}

/** The app menu on Linux: a button at the left of the chrome bar opening the menu `app_menu.rs`
 *  defines (macOS has the native menu bar, so nothing renders there). */
export function AppMenuButton() {
  const isLinux = detectPlatform() === "linux";
  useAltOpensMenu(isLinux ? open : noop);
  if (!isLinux) return null;
  return (
    <button
      type="button"
      onClick={open}
      aria-label="Menu"
      title="Menu"
      className="group pointer-events-auto absolute left-3 top-1/2 flex h-7 w-8 -translate-y-1/2 items-center justify-center rounded-md text-[var(--fg-base)] transition-colors hover:bg-[var(--surface-subtle)] hover:transition-none"
    >
      <span className="opacity-60 transition-opacity group-hover:opacity-100 group-hover:transition-none">
        <HugeiconsIcon icon={Menu01Icon} size={18} color="currentColor" strokeWidth={2} />
      </span>
    </button>
  );
}
