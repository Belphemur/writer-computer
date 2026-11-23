// `pnpm run build:app`: the e2e build (embedded WebDriver server, isolated identifier), per OS.
import { spawnSync } from "node:child_process";
import { E2E_CONFIG, buildArgs } from "./app-binary.mjs";

const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "desktop",
    "exec",
    "tauri",
    "build",
    "--features",
    "e2e",
    ...buildArgs(),
    "--config",
    E2E_CONFIG,
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
