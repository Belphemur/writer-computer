/**
 * The composer's `/` menu: where the rows come from, how they merge and how typing filters them.
 * Pure; the composer owns the UI and the store owns the disk lookup.
 *
 * Sources, merged and de-duplicated by name (first wins):
 *  1. skills on disk in the chat's project and the vault (`.claude/skills`, `.agents/skills`),
 *     read by `agent_list_skills`, with their descriptions;
 *  2. what the CLI reports in `session-started`: `slashCommands` (built-ins such as /compact,
 *     plus skills and plugin commands) and `skills` (including user-level and plugin skills,
 *     which Writer never reads from disk itself). Only available once a session has started.
 *
 * Before a session exists there are no built-ins: none is verified to work in stream-json
 * mode, so none is listed (the CLI's own list appears after the first turn).
 */
import type { DiskSkill } from "./events";
import { prepare, prepareQuery, matchPath } from "@/lib/search-rank";

/** Where a skill on disk lives (`DiskSkill.scope`, a plain string on the wire). */
type DiskScope = "project" | "vault" | "global";
export type SlashSource = DiskScope | "cli";

export type SlashItem = {
  /** Without the leading slash. */
  name: string;
  /** One line; empty when unknown. */
  description: string;
  kind: "skill" | "command";
  /** `project` / `vault` / `global` for skills found on disk, `cli` for what only the session reported. */
  source: SlashSource;
  /** Where the `SKILL.md` is (vault-relative; absolute for `global`); null for CLI-only rows. */
  path: string | null;
  /** True when the CLI listed it in `session-started` (registered for this chat), false when it
   *  did not, null before any session has started (nothing to compare with). */
  loaded: boolean | null;
};

export const SOURCE_LABEL: Record<SlashSource, string> = {
  project: "project",
  vault: "vault",
  global: "global",
  cli: "from Claude",
};

/** Short, accurate status for a row (see the spec: "loaded" = in the CLI's init `skills` list). */
export function loadedLabel(item: Pick<SlashItem, "kind" | "loaded">): string {
  if (item.kind !== "skill" || item.loaded === null) return "";
  return item.loaded ? "loaded" : "not loaded";
}

export const SLASH_EMPTY_TEXT = "No skills found. Skills live in .claude/skills or .agents/skills.";

export type CliLists = { slashCommands: readonly string[]; skills: readonly string[] };

/**
 * `session` is this chat's own `session-started` lists (the CLI is then the authority on what is
 * loaded). `catalog` is the last lists any chat of this window received: the CLI only emits its
 * `system/init` after the first user message, so a new chat shows that cached list, marked
 * "from Claude" but with unknown loaded status, until its own session starts.
 */
export function mergeSlashItems(
  disk: readonly DiskSkill[],
  session: CliLists | null,
  catalog: CliLists | null = null,
): SlashItem[] {
  const own = session !== null;
  const lists = session ?? catalog;
  const out: SlashItem[] = [];
  const seen = new Set<string>();
  const reported = new Set(
    [...(lists?.skills ?? []), ...(lists?.slashCommands ?? [])].map((n) => n.toLowerCase()),
  );
  const loaded = (name: string): boolean | null => (own ? reported.has(name.toLowerCase()) : null);
  const add = (item: SlashItem) => {
    const key = item.name.toLowerCase();
    if (!item.name || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  // Precedence project > vault > global (the list arrives in that order, then by name).
  const rank: Record<DiskScope, number> = { project: 0, vault: 1, global: 2 };
  // The wire carries the scope as a plain string; an unknown one (a newer backend) is listed last as global.
  const scopeOf = (s: DiskSkill): DiskScope =>
    s.scope in rank ? (s.scope as DiskScope) : "global";
  for (const s of [...disk].sort((a, b) => rank[scopeOf(a)] - rank[scopeOf(b)]))
    add({
      name: s.name,
      description: s.description,
      kind: "skill",
      source: scopeOf(s),
      path: s.path,
      loaded: loaded(s.name),
    });
  if (lists) {
    const skills = new Set(lists.skills.map((n) => n.toLowerCase()));
    const cli = (name: string, kind: SlashItem["kind"]): SlashItem => ({
      name,
      description: "",
      kind,
      source: "cli",
      path: null,
      loaded: own ? true : null,
    });
    for (const n of lists.skills) add(cli(n, "skill"));
    for (const n of lists.slashCommands)
      add(cli(n, skills.has(n.toLowerCase()) ? "skill" : "command"));
  }
  return out;
}

/** Fuzzy filter on the name (the vault search ranker), then description word matches. */
export function filterSlash(items: readonly SlashItem[], query: string, limit = 12): SlashItem[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit);
  const pq = prepareQuery(q);
  const ranked: { item: SlashItem; score: number }[] = [];
  const rest: SlashItem[] = [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  for (const item of items) {
    const m = matchPath(pq, prepare(item.name));
    if (m) ranked.push({ item, score: m.score });
    else if (words.every((w) => item.description.toLowerCase().includes(w))) rest.push(item);
  }
  ranked.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return [...ranked.map((r) => r.item), ...rest].slice(0, limit);
}
