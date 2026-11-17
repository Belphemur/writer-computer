// Usage: node setup.mjs <out-vault-dir> <plugin-id,plugin-id,...|none>
// Builds a synthetic vault and seeds ONLY the e2e app data dir's recent_workspaces/plugins_trust.
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const plugins = require("./plugins.cjs");

const [, , outArg, listArg = "none"] = process.argv;
rmSync(outArg, { recursive: true, force: true });
mkdirSync(outArg, { recursive: true });
const vault = realpathSync(outArg);
const ids = listArg === "none" ? [] : listArg.split(",");
mkdirSync(join(vault, ".obsidian/plugins"), { recursive: true });
for (const id of ids) {
  const dir = join(vault, ".obsidian/plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.js"), plugins[id]);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      minAppVersion: "1.0.0",
      author: "x",
      description: "fixture",
    }),
  );
}
writeFileSync(join(vault, ".obsidian/community-plugins.json"), JSON.stringify(ids));
writeFileSync(
  join(vault, "note.md"),
  [
    "---",
    "title: Synthetic",
    "tags: [a, b]",
    "---",
    "Intro paragraph with **bold words** and a [[Other]] link.",
    "",
    "## Second heading",
    "",
    "> [!note] A callout",
    "> body of the callout",
    "",
    "- item with *italic*",
    "",
    ...(process.env.BIG
      ? Array.from({ length: Number(process.env.BIG) }, (_, i) =>
          i % 7 === 0
            ? `## Section ${i}`
            : `Line ${i} with **bold** and [[Other]] and \`code\` and *em*\n`,
        )
      : []),
  ].join("\n"),
);
writeFileSync(join(vault, "Other.md"), "# Other\n\ntext\n");
const data = join(homedir(), "Library/Application Support/com.writer-computer.e2e");
mkdirSync(data, { recursive: true });
rmSync(join(data, "plugins_proc_consent.json"), { force: true });
writeFileSync(join(data, "recent_workspaces.json"), JSON.stringify([vault]));
writeFileSync(join(data, "plugins_trust.json"), JSON.stringify({ [vault]: true }));
console.log(vault);
