// No escape hatches (ADR 2026-11-20, guardrail 1): a feature's web code must not hold a timer, an
// event listener or a store subscription outside its `ctx` (`ctx.setTimeout`, `ctx.setInterval`,
// `ctx.listen`, `ctx.subscribe`, `ctx.onDispose`), because the feature host releases only what
// went through it when the feature turns off. The scan covers the non-component modules of
// `features/*/web` (`.ts`; a `.tsx` component owns its effects with hooks and cleanup). Today's
// offenders are named in ALLOWED with a reason each; an entry that no longer matches fails the
// test, so the list only shrinks.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FEATURES = join(ROOT, "features");

const PATTERNS: [string, RegExp][] = [
  ["setTimeout", /(?<![.\w])setTimeout\(/],
  ["setInterval", /(?<![.\w])setInterval\(/],
  ["listen", /(?<![.\w])listen(<[^>(]*>)?\(/],
  ["subscribe", /\buse[A-Z]\w*\.subscribe\(/],
];

/** `[path suffix or folder, pattern, reason]`: what still escapes ctx today. */
const DEBOUNCE =
  "one-shot debounce or deferral of a non-component module: ends by itself in a moment and holds nothing across a turn-off";
const OBSIDIAN_API =
  "the Obsidian API shim re-implements timers and events for community plugins: their lifetime is the plugin's, torn down by the host's plugin unload (`lifecycle.ts`)";
const DOCK =
  "contribution callback: the owning registry (docks) keeps the returned unsubscribe and calls it when the feature is removed";
const MIGRATE =
  "not yet moved onto ctx: the next step of ADR 2026-11-20 migrates the remaining features one by one";
const ALLOWED: [string, string, string][] = [
  // agent: the lingering ones (the `agent:event` listener, the store subscriptions) are on ctx now
  [
    "agent/web/components/composer-extensions.ts",
    "setTimeout",
    "a CodeMirror event handler's zero-delay deferral",
  ],
  ["agent/web/index.ts", "subscribe", DOCK],
  [
    "agent/web/lib/chat-saver.ts",
    "setTimeout",
    "the debounced chat save: `resetAgentStore` flushes it when the feature turns off, so no word is lost",
  ],
  ["agent/web/lib/client.ts", "setTimeout", "the 16 ms event-batch flush of the pump"],
  ["agent/web/lib/mock-client.ts", "setTimeout", "the mock backend of the playground and tests"],
  [
    "agent/web/stores/agent-store.ts",
    "setTimeout",
    "the debounced open-chats save: `resetAgentStore` flushes and clears it",
  ],
  ["bases/web/ipc.ts", "listen", MIGRATE],
  ["bases/web/view/use-base-query.ts", "setTimeout", DEBOUNCE],
  ["excalidraw/web/disk-sync.ts", "setTimeout", DEBOUNCE],
  ["excalidraw/web/lib/export-svg.ts", "setTimeout", DEBOUNCE],
  ["excalidraw/web/lib/session.ts", "setTimeout", DEBOUNCE],
  ["excalidraw/web/lib/sessions.ts", "subscribe", MIGRATE],
  ["graph/web/layout.ts", "setTimeout", DEBOUNCE],
  ["graph/web/store.ts", "setTimeout", DEBOUNCE],
  ["graph/web/use-graph-data.ts", "setTimeout", DEBOUNCE],
  ["icons/web/sync.ts", "subscribe", MIGRATE],
  ["images/web/disk-sync.ts", "setTimeout", DEBOUNCE],
  ["lint/web/editor/linter.ts", "subscribe", MIGRATE],
  ["lint/web/lib/fix.ts", "setTimeout", DEBOUNCE],
  ["spellcheck/web/editor/linter.ts", "subscribe", MIGRATE],
  ["tables/web/table-commands.ts", "setTimeout", DEBOUNCE],
  ["obsidian-host/web/host/", "setTimeout", OBSIDIAN_API],
  ["obsidian-host/web/host/", "listen", OBSIDIAN_API],
  ["obsidian-host/web/index.ts", "setTimeout", DEBOUNCE],
  ["obsidian-host/web/index.ts", "subscribe", DOCK],
  ["obsidian-host/web/plugin-markdown-decorations.ts", "setTimeout", DEBOUNCE],
  ["obsidian-host/web/running-plugins.ts", "subscribe", MIGRATE],
  ["obsidian-host/web/settings-pages.ts", "subscribe", MIGRATE],
  ["obsidian-host/web/stores/plugin-updates-store.ts", "setTimeout", MIGRATE],
  ["obsidian-host/web/stores/plugin-updates-store.ts", "setInterval", MIGRATE],
  ["obsidian-host/web/stores/plugins-store.ts", "setTimeout", MIGRATE],
  ["obsidian-host/web/stores/plugins-store.ts", "subscribe", MIGRATE],
];

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
}

function hits(): [string, string][] {
  const found: [string, string][] = [];
  for (const feature of readdirSync(FEATURES)) {
    const web = join(FEATURES, feature, "web");
    try {
      if (!statSync(web).isDirectory()) continue;
    } catch {
      continue;
    }
    const files: string[] = [];
    walk(web, files);
    for (const file of files) {
      const rel = relative(ROOT, file);
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
        for (const [name, re] of PATTERNS) if (re.test(code)) found.push([rel, name]);
      }
    }
  }
  return found;
}

describe("feature web code holds no timer, listener or store subscription outside ctx", () => {
  it("has no unlisted escape, and every allowlist entry still matches", () => {
    const found = hits();
    const allowed = (f: string, p: string) =>
      ALLOWED.some(([s, ap]) => (f.endsWith(s) || f.includes(s)) && ap === p);
    const unlisted = found.filter(([f, p]) => !allowed(f, p)).map(([f, p]) => `${f}: ${p}`);
    expect([...new Set(unlisted)]).toEqual([]);
    for (const [suffix, pattern, reason] of ALLOWED) {
      expect(reason, `${suffix} needs a reason`).not.toBe("");
      expect(
        found.some(([f, p]) => (f.endsWith(suffix) || f.includes(suffix)) && p === pattern),
        `${suffix} no longer uses ${pattern}: remove it from the allowlist`,
      ).toBe(true);
    }
  });
});
