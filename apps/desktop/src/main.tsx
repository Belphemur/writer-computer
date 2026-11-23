import "./wdyr";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { installGlobalLogging } from "./lib/logger";
import { installPlatformAttribute } from "./lib/platform";
import { mark } from "./lib/startup-metrics";

mark("script-eval");
installGlobalLogging();
installPlatformAttribute();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
