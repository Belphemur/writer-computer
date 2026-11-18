import { useEffect, useMemo, useRef, useState } from "react";
import { scrollIntoScroller } from "@/lib/scroll-into";
import type { PageViewProps } from "@/lib/features/slots";
import type { SessionChangesLocation } from "@/components/editor-area/page-kinds";
import type { SessionFileChange } from "@features/agent/web/lib/events";
import { statusLabel } from "@features/agent/web/lib/diff-rows";
import { selectSessionChanges } from "@features/agent/web/lib/session-changes";
import { getAgentClient, useAgentStore } from "@features/agent/web/stores/agent-store";
import { logger } from "@/lib/logger";
import { Counts, FileDiffBody, FileName, OriginMarker } from "./change-parts";

const SINCE_RESTART = "since Writer restarted";

type Detail = { status: "loading" | "ready" | "error"; files: Map<string, SessionFileChange> };

/** The backend's diffs of the chat's changed notes, reloaded whenever the list changes. */
function useSessionDetail(chatId: string, signature: string): Detail {
  const [detail, setDetail] = useState<Detail>({ status: "loading", files: new Map() });
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const client = await getAgentClient();
        const data = await client.sessionChanges({ chatId });
        if (current)
          setDetail({
            status: "ready",
            files: new Map((data?.files ?? []).map((f) => [f.path, f])),
          });
      } catch {
        logger.warn("agent", "could not load session changes");
        if (current) setDetail({ status: "error", files: new Map() });
      }
    })();
    return () => {
      current = false;
    };
  }, [chatId, signature]);
  return detail;
}

/** The "Session changes" page: each note this chat changed against its first-touch version, one
 *  diff after the other, scrolled to the note the tray's "Diff" named. Reads the chat's one
 *  session-changes selector (the tray row reads the same). */
export function SessionChangesTab({ location }: PageViewProps<SessionChangesLocation>) {
  const chat = useAgentStore((s) => s.chats[location.chatId]);
  const sessionChanges = chat?.sessionChanges;
  const view = useMemo(() => selectSessionChanges({ sessionChanges }), [sessionChanges]);
  const signature = useMemo(() => JSON.stringify(sessionChanges?.live ?? []), [sessionChanges]);
  const detail = useSessionDetail(location.chatId, signature);
  const root = useRef<HTMLDivElement>(null);

  const ready = detail.status === "ready";
  useEffect(() => {
    if (!location.focus || !ready) return;
    const scroller = root.current;
    const row = scroller?.querySelector<HTMLElement>(
      `[data-session-change-file="${CSS.escape(location.focus)}"]`,
    );
    // This page's own scroller only: the DOM scrollIntoView would also move the window frame.
    if (row) scrollIntoScroller(row, { block: "start", scroller });
  }, [location.focus, ready]);

  if (!view) return <div className="p-6 text-[13px] text-text-muted">No changes</div>;
  return (
    <div
      ref={root}
      data-session-changes
      data-selectable
      className="h-full overflow-y-auto px-4 py-3"
    >
      <header className="mb-3 flex items-center gap-2 text-[13px]">
        <h1 className="font-medium text-text-primary">Session changes</h1>
        <Counts added={view.added} removed={view.removed} />
        {view.restored.size > 0 && (
          <span data-session-changes-restart className="text-[11px] text-text-muted">
            {SINCE_RESTART}
          </span>
        )}
      </header>
      <ul className="space-y-3">
        {view.files.map((f) => {
          const d = detail.files.get(f.path);
          return (
            <li
              key={f.path}
              data-session-change-file={f.path}
              className="rounded-lg border border-border"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1.5">
                <span className="shrink-0 text-[11px] text-text-muted">{statusLabel(f)}</span>
                <FileName f={f} />
                <OriginMarker f={f} />
                {!f.noDiff && <Counts added={f.added} removed={f.removed} />}
              </div>
              <div className="px-2 py-1.5">
                {view.restored.has(f.path) ? (
                  <p className="text-[11.5px] text-text-muted">{SINCE_RESTART}</p>
                ) : (
                  <FileDiffBody f={f} d={d} status={detail.status} error={null} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
