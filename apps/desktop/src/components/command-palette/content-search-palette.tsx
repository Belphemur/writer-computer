import { useRef, useState, type KeyboardEvent } from "react";
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList } from "cmdk";
import {
  useCloseCommandPalette,
  useCommandPaletteKind,
  useCommandPaletteSearch,
  useIsCommandPaletteOpen,
  useSetCommandPaletteKind,
  useSetCommandPaletteSearch,
} from "@/hooks/use-command-palette";
import { useWorkspace } from "@/hooks/use-workspace";
import { openFileAtLine } from "@/components/editor-area/reveal-line";
import {
  hitLocation,
  snippetPlace,
  splitByRanges,
  type ContentSearchHit,
} from "@/lib/content-search";
import { keyIntent, linkHandlers, openPathAtAnchor, type LinkIntent } from "@/lib/link-activation";
import { getFileName } from "@/lib/paths";
import { KindChips } from "./kind-chips";
import { cycleKindOnTab, kindChoices } from "./kind-choices";
import { NoteResultTitle } from "./note-result-title";
import { ResultIcon } from "./result-icon";
import { CONTENT_SEARCH_MIN_CHARS, useContentSearch } from "./use-content-search";
import { useSearchKinds } from "./use-search-kinds";

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

/** "Search in notes": ranked full-text results over every listed kind (notes, PDFs, code,
 *  drawings) with the matched lines, in the palette dialog. */
export function ContentSearchPalette() {
  const isOpen = useIsCommandPaletteOpen();
  const close = useCloseCommandPalette();
  const search = useCommandPaletteSearch();
  const setSearch = useSetCommandPaletteSearch();
  const { root } = useWorkspace();
  const kind = useCommandPaletteKind();
  const setKind = useSetCommandPaletteKind();
  const kinds = useSearchKinds(isOpen);
  const choices = kindChoices(kinds);
  const result = useContentSearch(search, isOpen, kind);
  const hits = result.status === "ready" || result.status === "loading" ? result.hits : [];

  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState("");
  // Keep the cmdk selection on a visible hit: the first one unless the user moved.
  const value = hits.some((h) => hitValue(h) === selected) ? selected : (hits[0]?.path ?? "");

  function open(hit: ContentSearchHit, intent: LinkIntent) {
    if (!root) return;
    const path = `${root}/${hit.path}`;
    // a PDF opens at the page of its first match, a note or code file at its line, the rest as is
    const where = hitLocation(hit.snippets[0]);
    close();
    const opened =
      where.kind === "page"
        ? openPathAtAnchor(path, `page=${where.page}`, intent)
        : openFileAtLine(path, where.kind === "line" ? where.line : null, { intent });
    void opened.catch((e: unknown) => {
      console.error("[content-search] open failed:", e);
    });
  }

  // A chip change starts the list over: the first hit is selected, as for a new query.
  function selectKind(next: string | null) {
    setSelected("");
    setKind(next);
  }

  // cmdk's Enter selects; Tab cycles the chips and Cmd/Ctrl+Enter is claimed here (cmdk skips
  // defaultPrevented keys).
  function onKeyDown(e: KeyboardEvent) {
    cycleKindOnTab(e, choices, kind, selectKind);
    const intent = keyIntent(e);
    if (!intent || intent === "current") return;
    e.preventDefault();
    const hit = hits.find((h) => hitValue(h) === value);
    if (hit) open(hit, intent);
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
      <KindChips choices={choices} selected={kind} onSelect={selectKind} />
      <CommandList ref={listRef}>
        {trimmed.length < CONTENT_SEARCH_MIN_CHARS && (
          <StatusLine role="status">
            {`Type at least ${CONTENT_SEARCH_MIN_CHARS} characters to search file contents.`}
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
                ? `${result.total} ${result.total === 1 ? "result" : "results"}`
                : "Searching…"
            }
          >
            {hits.map((hit) => (
              <CommandItem
                key={hit.path}
                value={hitValue(hit)}
                onSelect={() => open(hit, "current")}
                {...linkHandlers(
                  { kind: "custom", open: (intent) => open(hit, intent) },
                  { middleOnly: true },
                )}
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 flex">
                    <ResultIcon path={hit.path} kind={hit.kind} kinds={kinds} />
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <NoteResultTitle
                      path={hit.path}
                      name={hit.path.endsWith(".md") ? hit.title : getFileName(hit.path)}
                      override={hit.titleOverride}
                    />
                    <span className="truncate text-[13px] text-text-muted">
                      {hit.folder || "Vault root"}
                      {hit.stale ? " · changed since indexed" : ""}
                      {hit.fuzzy ? " · similar name" : ""}
                    </span>
                    {hit.snippets.map((s) => (
                      <span
                        key={`${s.page ?? ""}:${s.line}`}
                        className="truncate text-[13px] text-text-muted"
                      >
                        {snippetPlace(s) && (
                          <span className="mr-2 tabular-nums opacity-60">{snippetPlace(s)}</span>
                        )}
                        <Marked text={s.text} ranges={s.ranges} />
                      </span>
                    ))}
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
