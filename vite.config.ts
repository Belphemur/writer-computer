import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // The agent golden files are written by a Rust test (serde_json pretty); a formatter pass
    // would make that test fail.
    ignorePatterns: [
      "apps/website/src/routeTree.gen.ts",
      ".wrangler/**",
      "apps/desktop/shared/agent-golden/**",
      "apps/desktop/src-tauri/src/agent/fixtures/**",
      "apps/desktop/tests/fixtures/agent-chat-notes/**",
      "apps/desktop/tests/fixtures/excalidraw/**",
    ],
  },
  lint: {
    ignorePatterns: ["apps/website/src/routeTree.gen.ts", ".wrangler/**"],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
