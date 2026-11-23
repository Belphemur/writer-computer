import "./wdyr";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppRoot } from "./components/app-root";
import { installGlobalLogging } from "./lib/logger";
import { installPlatformAttribute } from "./lib/platform";
import { mark } from "./lib/startup-metrics";

mark("script-eval");
installGlobalLogging();
installPlatformAttribute();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppRoot>
      <App />
    </AppRoot>
  </React.StrictMode>,
);
