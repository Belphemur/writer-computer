// Note-content search (`index_search`): typed IPC wrappers and the pure helpers the
// palette's "Search in notes" mode renders with. Tests mock `@tauri-apps/api/*`.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** One matching line: `line` is 1-based on disk; `ranges` are `[start, end)` UTF-16 offsets into `text`. */
export interface ContentSnippet {
  line: number;
  text: string;
  ranges: [number, number][];
}

export interface ContentSearchHit {
  /** Vault-relative path. */
  path: string;
  title: string;
  folder: string;
  score: number;
  snippets: ContentSnippet[];
  /** The file changed since it was indexed; the line may have moved. */
  stale: boolean;
  /** Similar name, heading or tag found by the fuzzy fallback; it has no snippets. */
  fuzzy?: boolean;
}

export interface ContentSearchPage {
  total: number;
  hits: ContentSearchHit[];
  truncated: boolean;
}

export interface ContentSearchRequest {
  query: string;
  folder?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
  snippetLen?: number;
  maxSnippets?: number;
  /** Match the trailing word as a prefix while the user is still typing it. */
  asYouType?: boolean;
  /** Rank recently opened and modified notes higher (default off in the backend). */
  recency?: boolean;
  /** Append similar names, headings and tags when few notes match exactly. */
  fuzzy?: boolean;
}

export function indexSearch(request: ContentSearchRequest): Promise<ContentSearchPage> {
  return invoke("index_search", { request });
}

export interface IndexChangedPayload {
  full: boolean;
  paths: string[];
}

export function onIndexChanged(handler: (event: IndexChangedPayload) => void): Promise<UnlistenFn> {
  return listen<IndexChangedPayload>("index://changed", (event) => handler(event.payload));
}

/** The backend refuses to search a cold index (see `index_search`). */
export function isIndexBuildingError(error: unknown): boolean {
  return String(error).includes("still being built");
}

export interface TextPart {
  text: string;
  match: boolean;
}

/**
 * Split `text` into plain and matched parts. Ranges come from the backend and are clamped,
 * sorted and merged here, so a bad range can never throw or duplicate text. The parts are
 * rendered as React nodes (never as HTML), so note text cannot inject markup.
 */
export function splitByRanges(text: string, ranges: readonly [number, number][]): TextPart[] {
  const clean = ranges
    .map(([a, b]): [number, number] => [
      Math.max(0, Math.min(a, text.length)),
      Math.min(b, text.length),
    ])
    .filter(([a, b]) => a < b)
    .sort((x, y) => x[0] - y[0]);
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const [a, b] of clean) {
    const start = Math.max(a, cursor);
    if (b <= start) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), match: false });
    parts.push({ text: text.slice(start, b), match: true });
    cursor = b;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}
