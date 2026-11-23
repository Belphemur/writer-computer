import { AppLayout } from "./components/app-layout";
import { NoteTitleDialog } from "./components/note-title-dialog";
import { CommandPalette } from "./components/command-palette";
import { FeatureOverlays } from "./components/feature-overlays";
import { TelemetryConsentDialog } from "./components/telemetry-consent-dialog";
import { WindowTitle } from "./components/window-title";
import { useIsStartupResolved } from "./hooks/use-workspace";
import { useFileWatcher } from "./hooks/use-file-watcher";
import { useIpcRequests } from "./hooks/use-ipc-requests";
import { useNativeDecorations } from "./hooks/use-chrome-frame";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts";
import { useMenuEvents } from "./hooks/use-menu-events";
import { useOpenDrop } from "./hooks/use-open-drop";
import "./lib/features/builtin";
import "./lib/global-recents";
import "./lib/standalone-watch";
import "./App.css";

function App() {
  const isStartupResolved = useIsStartupResolved();

  useFileWatcher();
  useKeyboardShortcuts();
  useMenuEvents();
  useNativeDecorations();
  useOpenDrop();
  useIpcRequests(isStartupResolved);

  if (!isStartupResolved) {
    return null;
  }

  return (
    <>
      <WindowTitle />
      <AppLayout />
      <CommandPalette />
      <FeatureOverlays />
      <NoteTitleDialog />
      <TelemetryConsentDialog />
    </>
  );
}

export default App;
