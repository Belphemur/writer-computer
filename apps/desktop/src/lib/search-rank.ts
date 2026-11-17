// TypeScript twin of `src-tauri/src/index/rank.rs`: typo-tolerant fuzzy matching of file names
// and paths plus the recency boost. The formula is in SPECs/search-ranking-spec.md. Both sides
// assert `shared/search-rank-vectors.json`, so a change here must change the Rust file, and vice versa.
// The backend ranks the vault search; this twin ranks what only the frontend has (the compact
// window's global recents).

// ---- tunables: keep in sync with rank.rs ----
export const OPENED_HALF_LIFE_DAYS = 3;
export const MODIFIED_HALF_LIFE_DAYS = 5;
export const OPENED_WEIGHT = 0.5;
export const MODIFIED_WEIGHT = 0.3;

const MATCH = 16;
const CONSECUTIVE = 12;
const BOUNDARY = 14;
const NAME_START = 10;
const CAMEL = 10;
const GAP_OPEN = 6;
const GAP_EXTEND = 2;
const LEADING_GAP = 1;
const LEADING_GAP_CAP = 5;
const PATH_FACTOR = 0.5;
const EXACT_STEM = 120;
const PREFIX_STEM = 40;
const COVERAGE = 10;
const SUBSEQUENCE_MIN = 3;
const TYPO_CHAR = 10;
const TYPO_EDIT = 14;
const NEG = -1073741824;
const MS_PER_DAY = 86_400_000;

const MARK = /\p{M}/u;
const ALNUM = /[\p{L}\p{N}]/u;
const isAlnum = (c: string) => ALNUM.test(c);
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
const isMark = (c: string) => MARK.test(c);

export interface Prepared {
  chars: string[];
  bonus: number[];
  nameStart: number;
  stemEnd: number;
  words: [number, number][];
}

function fold(s: string): { prepared: Prepared; map: number[] } {
  const src = Array.from(s);
  const lastSlash = src.lastIndexOf("/");
  const nameOrig = lastSlash >= 0 ? lastSlash + 1 : 0;
  const lastDot = src.lastIndexOf(".");
  const stemOrig = lastDot > nameOrig ? lastDot : src.length;
  const p: Prepared = { chars: [], bonus: [], nameStart: -1, stemEnd: -1, words: [] };
  const map: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (p.nameStart < 0 && i >= nameOrig) p.nameStart = p.chars.length;
    if (p.stemEnd < 0 && i >= stemOrig) p.stemEnd = p.chars.length;
    let prev: string | undefined;
    for (let k = i - 1; k >= 0; k--) {
      if (!isMark(src[k])) {
        prev = src[k];
        break;
      }
    }
    const bonus = charBonus(prev, c);
    let first = true;
    for (const d of Array.from(c.normalize("NFD"))) {
      if (isMark(d)) continue;
      for (const l of Array.from(d.toLowerCase())) {
        p.chars.push(l === "_" || l === "-" ? " " : l);
        p.bonus.push(first ? bonus : 0);
        map.push(i);
        first = false;
      }
    }
  }
  if (p.nameStart < 0) p.nameStart = p.chars.length;
  if (p.stemEnd < 0) p.stemEnd = p.chars.length;
  let start = -1;
  for (let j = 0; j < p.chars.length; j++) {
    if (isAlnum(p.chars[j])) {
      if (start < 0) start = j;
    } else if (start >= 0) {
      p.words.push([start, j]);
      start = -1;
    }
  }
  if (start >= 0) p.words.push([start, p.chars.length]);
  return { prepared: p, map };
}

function charBonus(prev: string | undefined, c: string): number {
  if (!isAlnum(c)) return 0;
  if (prev === undefined) return BOUNDARY + NAME_START;
  if (!isAlnum(prev)) return BOUNDARY;
  if (isLower(prev) && isUpper(c)) return CAMEL;
  return 0;
}

/** Fold a vault-relative path (the file name follows the last `/`). */
export function prepare(path: string): Prepared {
  return fold(path).prepared;
}

export type PreparedQuery = string[][];

export function prepareQuery(query: string): PreparedQuery {
  const { prepared } = fold(query);
  const words: string[][] = [];
  let cur: string[] = [];
  for (const c of prepared.chars) {
    if (/\s/u.test(c)) {
      if (cur.length) words.push(cur);
      cur = [];
    } else cur.push(c);
  }
  if (cur.length) words.push(cur);
  return words;
}

export interface TextMatch {
  score: number;
  /** Folded char positions, ascending and unique. */
  folded: number[];
}

type Scored = { score: number; idx: number[] };

export function matchPath(q: PreparedQuery, c: Prepared): TextMatch | null {
  if (q.length === 0) return null;
  let total = 0;
  const hit: number[] = [];
  let qlen = 0;
  for (const w of q) {
    const r = bestWord(w, c);
    if (!r) return null;
    total += r.score;
    hit.push(...r.idx);
    qlen += w.length;
  }
  const stem = c.chars.slice(c.nameStart, c.stemEnd);
  const joined = q.flatMap((w, i) => (i === 0 ? w : [" ", ...w]));
  if (stem.length === joined.length && stem.every((ch, i) => ch === joined[i])) {
    total += EXACT_STEM;
  } else if (stem.length >= joined.length && joined.every((ch, i) => stem[i] === ch)) {
    total += PREFIX_STEM;
  }
  total += COVERAGE * Math.min(1, qlen / Math.max(1, stem.length));
  const folded = [...new Set(hit)].sort((a, b) => a - b);
  return { score: total, folded };
}

function bestWord(w: string[], c: Prepared): Scored | null {
  const contiguous = w.length < SUBSEQUENCE_MIN;
  const pathOnly = w.includes("/");
  const name = pathOnly ? null : dp(w, c, c.nameStart, c.stemEnd, contiguous);
  const pathRaw = dp(w, c, 0, c.chars.length, contiguous);
  const path = pathRaw ? { score: pathRaw.score * PATH_FACTOR, idx: pathRaw.idx } : null;
  let best: Scored | null = null;
  if (name && path) best = name.score >= path.score ? name : path;
  else best = name ?? path;
  if (best) return best;
  return pathOnly ? null : typo(w, c);
}

function dp(q: string[], c: Prepared, lo: number, hi: number, contiguous: boolean): Scored | null {
  const m = q.length;
  if (m === 0 || hi <= lo || hi - lo < m) return null;
  const text = c.chars.slice(lo, hi);
  const n = text.length;
  if (contiguous) {
    let found = false;
    for (let s = 0; s + m <= n && !found; s++) {
      found = q.every((ch, k) => text[s + k] === ch);
    }
    if (!found) return null;
  } else {
    let qi = 0;
    for (const ch of text) if (qi < m && ch === q[qi]) qi++;
    if (qi < m) return null;
  }
  const h = Array.from<number>({ length: m * n }).fill(NEG);
  for (let i = 0; i < m; i++) {
    let runBest = NEG;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2) {
        const v = h[(i - 1) * n + j - 2];
        if (v > NEG) runBest = Math.max(runBest, v + GAP_EXTEND * (j - 2));
      }
      if (text[j] !== q[i]) continue;
      const cs = MATCH + c.bonus[lo + j];
      let val: number;
      if (i === 0) {
        val = cs - LEADING_GAP * Math.min(j, LEADING_GAP_CAP);
      } else {
        let best = NEG;
        if (j >= 1) {
          const p = h[(i - 1) * n + j - 1];
          if (p > NEG) best = p + CONSECUTIVE;
        }
        if (!contiguous && runBest > NEG) {
          best = Math.max(best, runBest - GAP_EXTEND * (j - 2) - GAP_OPEN);
        }
        if (best === NEG) continue;
        val = cs + best;
      }
      h[i * n + j] = val;
    }
  }
  const last = (m - 1) * n;
  let end = -1;
  let score = NEG;
  for (let j = 0; j < n; j++) {
    const v = h[last + j];
    if (v > NEG && (end < 0 || v > score)) {
      end = j;
      score = v;
    }
  }
  if (end < 0) return null;
  let j = end;
  const idx = Array.from<number>({ length: m }).fill(0);
  for (let i = m - 1; i >= 0; i--) {
    idx[i] = lo + j;
    if (i === 0) break;
    const prev = h[i * n + j] - (MATCH + c.bonus[lo + j]);
    const diag = j >= 1 ? h[(i - 1) * n + j - 1] : NEG;
    if (diag > NEG && diag + CONSECUTIVE === prev) {
      j -= 1;
      continue;
    }
    let found = -1;
    if (j >= 2) {
      for (let k = j - 2; k >= 0; k--) {
        const hk = h[(i - 1) * n + k];
        if (hk > NEG && hk - GAP_OPEN - GAP_EXTEND * (j - k - 2) === prev) {
          found = k;
          break;
        }
      }
    }
    if (found < 0) return null;
    j = found;
  }
  return { score, idx };
}

function allowedEdits(len: number): number {
  if (len <= 4) return 0;
  if (len <= 7) return 1;
  return 2;
}

function osa(a: string[], b: string[], max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  let prev2 = Array.from<number>({ length: m + 1 }).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let cur = Array.from<number>({ length: m + 1 }).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] !== b[j - 1] ? 1 : 0;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[m];
}

function typo(w: string[], c: Prepared): Scored | null {
  const max = allowedEdits(w.length);
  if (max === 0) return null;
  let best: Scored | null = null;
  for (const [ws, we] of c.words) {
    const weight = ws >= c.nameStart && we <= c.stemEnd ? 1 : PATH_FACTOR;
    const word = c.chars.slice(ws, we);
    const targets = [word];
    if (word.length > w.length) targets.push(word.slice(0, w.length));
    for (const t of targets) {
      const d = osa(w, t, max);
      if (d === 0 || d > max) continue;
      const score = (TYPO_CHAR * w.length - TYPO_EDIT * d + c.bonus[ws]) * weight;
      if (best === null || score > best.score) {
        best = { score, idx: Array.from({ length: t.length }, (_, k) => ws + k) };
      }
    }
  }
  return best;
}

/** Map folded positions back to char (code point) indices of the original string. */
export function originalIndices(path: string, folded: readonly number[]): number[] {
  const { map } = fold(path);
  const out = new Set<number>();
  for (const f of folded) if (f < map.length) out.add(map[f]);
  return [...out].sort((a, b) => a - b);
}

// ---- recency ----

export interface Recency {
  /** Last opened, unix ms. */
  openedMs?: number | null;
  /** Last modified, unix ms (0 or missing: unknown). */
  mtimeMs?: number | null;
}

function decay(ageMs: number, halfLifeDays: number): number {
  return Math.pow(0.5, Math.max(0, ageMs) / MS_PER_DAY / halfLifeDays);
}

export function recencyBoost(nowMs: number, r: Recency): number {
  const opened = r.openedMs ? OPENED_WEIGHT * decay(nowMs - r.openedMs, OPENED_HALF_LIFE_DAYS) : 0;
  const modified =
    r.mtimeMs && r.mtimeMs > 0
      ? MODIFIED_WEIGHT * decay(nowMs - r.mtimeMs, MODIFIED_HALF_LIFE_DAYS)
      : 0;
  return opened + modified;
}

export function combine(text: number, boost: number): number {
  return text * (1 + boost);
}

export interface Candidate<T> {
  item: T;
  /** Vault-relative (or absolute) path; the file name follows the last `/`. */
  path: string;
  recency: Recency;
  prepared?: Prepared;
}

export interface RankOptions {
  nowMs: number;
  recency: boolean;
}

/**
 * Rank candidates for `query`, best first, ties by path. An empty query lists
 * by recency: opened files newest first, then newest modified.
 */
export function rankCandidates<T>(
  candidates: readonly Candidate<T>[],
  query: string,
  opts: RankOptions,
): { item: T; score: number }[] {
  const q = prepareQuery(query);
  const out: { item: T; score: number; path: string; opened: number; mtime: number }[] = [];
  for (const c of candidates) {
    const opened = c.recency.openedMs ?? 0;
    const mtime = c.recency.mtimeMs ?? 0;
    if (q.length === 0) {
      out.push({ item: c.item, score: 0, path: c.path, opened, mtime });
      continue;
    }
    const m = matchPath(q, c.prepared ?? prepare(c.path));
    if (!m) continue;
    const boost = opts.recency ? recencyBoost(opts.nowMs, c.recency) : 0;
    out.push({ item: c.item, score: combine(m.score, boost), path: c.path, opened, mtime });
  }
  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  if (q.length === 0) {
    out.sort((a, b) => b.opened - a.opened || b.mtime - a.mtime || byPath(a, b));
  } else {
    out.sort((a, b) => b.score - a.score || byPath(a, b));
  }
  return out.map(({ item, score }) => ({ item, score }));
}
