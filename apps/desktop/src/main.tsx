import "./wdyr";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppRoot } from "./components/app-root";
import { installGlobalLogging } from "./lib/logger";
import { detectPlatform, installPlatformAttribute } from "./lib/platform";
import { mark } from "./lib/startup-metrics";
import { oldWebviewMessage } from "./lib/webview-support";

mark("script-eval");
installGlobalLogging();
installPlatformAttribute();

const root = document.getElementById("root") as HTMLElement;
const oldWebview = oldWebviewMessage(detectPlatform());
if (oldWebview) {
  // The stylesheet cannot draw here, so say why in plain text instead of a broken window.
  root.setAttribute("role", "alert");
  root.style.cssText = "padding:48px;font:16px/1.5 system-ui,sans-serif;max-width:40em";
  root.textContent = oldWebview;
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AppRoot>
        <App />
      </AppRoot>
    </React.StrictMode>,
  );
}
