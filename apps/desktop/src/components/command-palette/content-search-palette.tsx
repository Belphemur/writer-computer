import { useRef, useState, type KeyboardEvent } from "react";
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList } from "cmdk";
import {
  useCloseCommandPalette,
  useCommandPaletteSearch,
  useIsCommandPaletteOpen,
  useSetCommandPaletteSearch,
} from "@/hooks/use-command-palette";
import { useWorkspace } from "@/hooks/use-workspace";
import { openFileAtLine } from "@/components/editor-area/reveal-line";
import { splitByRanges, type ContentSearchHit } from "@/lib/content-search";
import { NoteResultTitle } from "./note-result-title";
import { CONTENT_SEARCH_MIN_CHARS, useContentSearch } from "./use-content-search";

function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  return (
    <>
      {splitByRanges(text, ranges).map((part, i) =>
        part.match ? (
          <mark key={i} className="bg-transparent font-semibold text-link">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function hitValue(hit: ContentSearchHit) {
  return hit.path;
}

function StatusLine({ role, children }: { role: "status" | "alert"; children: string }) {
  return (
    <div role={role} className="px-4 py-6 text-center text-sm text-text-muted">
      {children}
    </div>
  );
}

/** "Search in notes": ranked full-text results with the matched lines, in the palette dialog. */
export function ContentSearchPalette() {
  const isOpen = useIsCommandPaletteOpen();
  const close = useCloseCommandPalette();
  const search = useCommandPaletteSearch();
  const setSearch = useSetCommandPaletteSearch();
  const { root } = useWorkspace();
  const result = useContentSearch(search, isOpen);
  const hits = result.status === "ready" || result.status === "loading" ? result.hits : [];

  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState("");
  // Keep the cmdk selection on a visible hit: the first one unless the user moved.
  const value = hits.some((h) => hitValue(h) === selected) ? selected : (hits[0]?.path ?? "");

  function open(hit: ContentSearchHit, newTab: boolean) {
    if (!root) return;
    const line = hit.snippets[0]?.line ?? null;
    close();
    void openFileAtLine(`${root}/${hit.path}`, line, { newTab }).catch((e: unknown) => {
      console.error("[content-search] open failed:", e);
    });
  }

  // cmdk's Enter selects; Cmd/Ctrl+Enter is claimed here (cmdk skips defaultPrevented keys).
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    const hit = hits.find((h) => hitValue(h) === value);
    if (hit) open(hit, true);
  }

  const trimmed = search.trim();
  return (
    <CommandDialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      label="Search in notes"
      shouldFilter={false}
      value={value}
      onValueChange={setSelected}
      onKeyDown={onKeyDown}
    >
      <CommandInput
        placeholder="Search in notes..."
        value={search}
        onValueChange={setSearch}
        aria-label="Search in notes"
      />
      <CommandList ref={listRef}>
        {trimmed.length < CONTENT_SEARCH_MIN_CHARS && (
          <StatusLine role="status">
            {`Type at least ${CONTENT_SEARCH_MIN_CHARS} characters to search note contents.`}
          </StatusLine>
        )}
        {result.status === "building" && (
          <StatusLine role="status">Index is being built…</StatusLine>
        )}
        {result.status === "error" && (
          <StatusLine role="alert">{`Search failed: ${result.message}`}</StatusLine>
        )}
        {result.status === "loading" && hits.length === 0 && (
          <StatusLine role="status">Searching…</StatusLine>
        )}
        {result.status === "ready" && hits.length === 0 && (
          <StatusLine role="status">No matches</StatusLine>
        )}
        {hits.length > 0 && (
          <CommandGroup
            heading={
              result.status === "ready"
                ? `${result.total} ${result.total === 1 ? "note" : "notes"}`
                : "Searching…"
            }
          >
            {hits.map((hit) => (
              <CommandItem key={hit.path} value={hitValue(hit)} onSelect={() => open(hit, false)}>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <NoteResultTitle path={hit.path} name={hit.title} override={hit.titleOverride} />
                  <span className="truncate text-[13px] text-text-muted">
                    {hit.folder || "Vault root"}
                    {hit.stale ? " · changed since indexed" : ""}
                    {hit.fuzzy ? " · similar name" : ""}
                  </span>
                  {hit.snippets.map((s) => (
                    <span key={s.line} className="truncate text-[13px] text-text-muted">
                      <span className="mr-2 tabular-nums opacity-60">{s.line}</span>
                      <Marked text={s.text} ranges={s.ranges} />
                    </span>
                  ))}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
