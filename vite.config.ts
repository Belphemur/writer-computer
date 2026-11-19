import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // The agent golden files are written by a Rust test (serde_json pretty), and a feature's
    // `web/bindings.ts` by tauri-specta; a formatter pass would make those tests fail.
    ignorePatterns: [
      "apps/website/src/routeTree.gen.ts",
      ".wrangler/**",
      "apps/desktop/shared/agent-golden/**",
      "apps/desktop/features/*/web/bindings.ts",
      "apps/desktop/src-tauri/src/agent/fixtures/**",
      "apps/desktop/tests/fixtures/agent-chat-notes/**",
      "apps/desktop/features/obsidian-host/tests/fixtures/**",
      // Drawing files whose bytes the codec tests compare (trailing spaces, line endings).
      "apps/desktop/shared/excalidraw-fixtures/**",
    ],
  },
  lint: {
    ignorePatterns: [
      "apps/website/src/routeTree.gen.ts",
      ".wrangler/**",
      "apps/desktop/features/*/web/bindings.ts",
    ],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
