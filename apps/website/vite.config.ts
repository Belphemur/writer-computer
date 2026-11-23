import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";

import { writerDocs } from "./docs-plugin";

const tauriConfPath = fileURLToPath(
  new URL("../desktop/src-tauri/tauri.conf.json", import.meta.url),
);
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf-8")) as {
  version: string;
};

// The repository releases are published to: one file for the site, the release workflow and the app.
const releaseConf = JSON.parse(
  readFileSync(fileURLToPath(new URL("../desktop/shared/release.json", import.meta.url)), "utf-8"),
) as { repo: string };

const RELEASE_REPO = releaseConf.repo;
const VERSION = tauriConf.version;
const REPO_URL = `https://github.com/${RELEASE_REPO}`;
const RELEASES_URL = `${REPO_URL}/releases`;

export default defineConfig({
  plugins: [
    devtools(),
    tanstackStart({
      prerender: {
        enabled: true,
        crawlLinks: true,
      },
    }),
    react(),
    writerDocs(),
  ],
  server: {
    port: 5173,
  },
  define: {
    __WRITER_RELEASE_REPO__: JSON.stringify(RELEASE_REPO),
    __WRITER_VERSION__: JSON.stringify(VERSION),
    __WRITER_RELEASES_URL__: JSON.stringify(RELEASES_URL),
    __WRITER_REPO_URL__: JSON.stringify(REPO_URL),
    // The site shares the desktop app's PostHog project, whose key lives in the
    // repo-root `.env` as `WRITER_POSTHOG_KEY`. That name has no `VITE_` prefix,
    // so Vite will not expose it — these two lines are the bridge.
    //
    // Bridged one variable at a time, by name, and nothing else. That `.env`
    // also holds the Apple credentials and the Tauri updater signing key, so
    // widening `envDir` to the repo root, calling `loadEnv` with an empty
    // prefix, or forwarding `process.env` wholesale would put signing secrets
    // in a public bundle. Adding a name here is the only way in, and it should
    // stay that way. Absent variables become `""`, which
    // `resolveAnalyticsConfig` reads as unconfigured.
    __WRITER_POSTHOG_KEY__: JSON.stringify(process.env.WRITER_POSTHOG_KEY ?? ""),
    __WRITER_POSTHOG_HOST__: JSON.stringify(process.env.WRITER_POSTHOG_HOST ?? ""),
  },
});
