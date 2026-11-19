#!/usr/bin/env node
// Builds apps/desktop/src/lib/icon-picker/emoji.json for the icon picker's Emoji tab from the
// Unicode Consortium's emoji-test.txt (Unicode License v3: a data file, not a dependency).
//
//   node scripts/build-emoji-json.mjs [path/to/emoji-test.txt]
//
// Without a path the file is fetched once from unicode.org into a temp directory (removed after).
// Only fully-qualified emoji are kept, skin-tone variants are left out (the base emoji stands for
// them). Each entry: emoji, name (the CLDR short name), keywords (the words of its subgroup the
// name does not already hold), group (an index into `groups`).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_LATEST = "https://unicode.org/Public/emoji/latest/emoji-test.txt";
const OUT = new URL("../apps/desktop/src/lib/icon-picker/emoji.json", import.meta.url);
const TONES = /^(?:light|medium-light|medium|medium-dark|dark) skin tone$/;

async function source() {
  const given = process.argv[2];
  if (given) return { text: await readFile(given, "utf8"), cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), "emoji-test-"));
  const res = await fetch(URL_LATEST);
  if (!res.ok) throw new Error(`could not fetch emoji-test.txt: HTTP ${res.status}`);
  const file = join(dir, "emoji-test.txt");
  await writeFile(file, await res.text());
  return { text: await readFile(file, "utf8"), cleanup: () => rm(dir, { recursive: true }) };
}

export function parse(text) {
  const groups = [];
  const entries = [];
  let subgroup = "";
  for (const line of text.split("\n")) {
    const g = /^# group: (.+)$/.exec(line);
    if (g) {
      groups.push(g[1].trim());
      continue;
    }
    const sg = /^# subgroup: (.+)$/.exec(line);
    if (sg) {
      subgroup = sg[1].trim();
      continue;
    }
    const m = /^([0-9A-F ]+?)\s*; fully-qualified\s+# (\S+) E[0-9.]+ (.+)$/.exec(line);
    if (!m) continue;
    const name = m[3].trim();
    if (
      name
        .split(": ")
        .slice(1)
        .some((p) => p.split(", ").every((t) => TONES.test(t)))
    )
      continue;
    const emoji = m[1]
      .split(" ")
      .map((h) => String.fromCodePoint(parseInt(h, 16)))
      .join("");
    const words = new Set(
      name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    const keywords = subgroup.split(/[^a-z0-9]+/).filter((w) => w && !words.has(w));
    entries.push({ emoji, name, keywords, group: groups.length - 1 });
  }
  return { groups, emoji: entries };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { text, cleanup } = await source();
  try {
    const data = parse(text);
    await writeFile(OUT, `${JSON.stringify(data)}\n`);
    console.log(`${data.emoji.length} emoji in ${data.groups.length} groups -> ${OUT.pathname}`);
  } finally {
    await cleanup();
  }
}
