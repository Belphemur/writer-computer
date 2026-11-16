#!/usr/bin/env node
/**
 * Check an ADR directory for consistency (no external deps).
 *
 * - every ADR has YAML front matter with `status` and `date`
 * - date-prefixed filenames: the prefix equals the front matter `date`
 * - the index (README.md) links every ADR, and a table row's date and status
 *   (when the index is a "| Date | Decision | Status | Links |" table) match the file
 * - the table is ordered by date
 *
 * Usage: node check_adr.js [--dir docs/decisions] [--repo-root .]
 * Exit code 1 when a problem is found.
 */

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const out = { repoRoot: ".", dir: "docs/decisions" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") out.dir = argv[++i];
    else if (a === "--repo-root") out.repoRoot = argv[++i];
    else {
      process.stderr.write(`Unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function frontMatter(text) {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

const args = parseArgs(process.argv);
const dir = path.resolve(process.cwd(), args.repoRoot, args.dir);
const problems = [];
const adrs = [];

for (const name of fs.readdirSync(dir).sort()) {
  if (!name.endsWith(".md") || name === "README.md" || name === "index.md") continue;
  const fm = frontMatter(fs.readFileSync(path.join(dir, name), "utf8"));
  if (!fm || !fm.status || !fm.date) {
    problems.push(`${name}: front matter needs status and date`);
    continue;
  }
  const prefix = name.match(/^(\d{4}-\d{2}-\d{2})-/);
  if (prefix && prefix[1] !== fm.date) {
    problems.push(`${name}: filename date ${prefix[1]} != front matter date ${fm.date}`);
  }
  adrs.push({ name, status: fm.status, date: fm.date });
}

const indexPath = ["README.md", "index.md"]
  .map((n) => path.join(dir, n))
  .find((p) => fs.existsSync(p));
if (!indexPath) {
  problems.push("no README.md or index.md index");
} else {
  const lines = fs.readFileSync(indexPath, "utf8").split("\n");
  const rows = [];
  for (const line of lines) {
    const m = line.match(
      /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*\[[^\]]*\]\(([^)]+)\)\s*\|\s*([^|]*?)\s*\|/,
    );
    if (m) rows.push({ date: m[1], link: m[2], status: m[3] });
  }
  for (const adr of adrs) {
    if (!lines.some((l) => l.includes(`(${adr.name})`))) {
      problems.push(`${adr.name}: not linked from the index`);
      continue;
    }
    const row = rows.find((r) => r.link === adr.name);
    if (rows.length > 0 && !row) problems.push(`${adr.name}: linked but not in the index table`);
    if (row && row.date !== adr.date)
      problems.push(`${adr.name}: index date ${row.date} != ${adr.date}`);
    if (
      row &&
      row.status.replace(/\[|\]\([^)]*\)/g, "") !== adr.status.replace(/\[|\]\([^)]*\)/g, "")
    ) {
      problems.push(`${adr.name}: index status "${row.status}" != "${adr.status}"`);
    }
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].date < rows[i - 1].date)
      problems.push(`index not ordered by date at ${rows[i].link}`);
  }
}

if (problems.length) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`ok: ${adrs.length} ADRs\n`);
