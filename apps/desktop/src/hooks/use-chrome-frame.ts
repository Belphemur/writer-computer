import { useEffect, useRef } from "react";
import { useBooleanSetting } from "@/hooks/use-settings";
import { chromeInset, detectPlatform, type ChromeInset } from "@/lib/platform";
import { logger } from "@/lib/logger";
import { setWindowDecorations } from "@/lib/tauri";

/** The room the chrome reserves for the platform's window controls (`lib/platform.ts`). */
export function useChromeInset(): ChromeInset {
  const native = useBooleanSetting("appearance.native-decorations", false);
  return chromeInset(detectPlatform(), native);
}

/** Linux: the window starts without a frame (`tauri.linux.conf.json`); the setting
 *  `appearance.native-decorations` gives it the desktop's frame back, live. Nothing is called
 *  until the setting has been on, so a normal start never touches the window. */
export function useNativeDecorations() {
  const native = useBooleanSetting("appearance.native-decorations", false);
  const applied = useRef(false);
  useEffect(() => {
    if (detectPlatform() !== "linux" || native === applied.current) return;
    applied.current = native;
    setWindowDecorations(native).catch((e: unknown) =>
      logger.warn("chrome-frame", `setting the window decorations failed: ${String(e)}`),
    );
  }, [native]);
}
