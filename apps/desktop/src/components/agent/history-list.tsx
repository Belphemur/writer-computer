import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openFileInNewTab } from "@/hooks/editor-api";
import { useSetting } from "@/hooks/use-settings";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { regenerateAgentChatTitle } from "@/hooks/agent-api";
import {
  canRegenerateTitle,
  REGENERATE_REFUSAL_TEXT,
  type RegenerateOutcome,
} from "@/lib/agent/auto-title";
import { parseChatNote, transcriptMarkdown } from "@/lib/agent/chat-note";
import {
  chatNoteAbsPath,
  cleanupCandidates,
  filterChats,
  groupByProject,
  projectLabel,
  projectsOf,
  type HistorySort,
} from "@/lib/agent/chat-history";
import {
  chatHistoryClient,
  type ChatAction,
  type ChatHistoryClient,
} from "@/lib/agent/chat-history-client";
import type { ChatSummary } from "@/lib/agent/events";
import { formatRelativeTime } from "@/lib/relative-time";
import { ChatRowMenu, type RowMenuItem } from "./chat-row-menu";
import { Spinner } from "./agent-icon";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

const SMALL =
  "h-6 rounded-md px-1.5 text-[12px] text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]";
const FIELD =
  "h-8 rounded-lg border border-transparent bg-[var(--surface-input)] px-2 text-[13px] text-[var(--text-secondary)] outline-none focus:border-[var(--focus-border)]";

/** "Regenerate title" on one row: asking to replace a title of the user's, running, or failed. */
type RegenState = { phase: "confirm" } | { phase: "running" } | { phase: "error"; message: string };

type RowProps = {
  chat: ChatSummary;
  now: number;
  renaming: boolean;
  confirmingDelete: boolean;
  regen: RegenState | undefined;
  menuOpen: boolean;
  onOpen: () => void;
  onAction: (action: ChatAction, title?: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onAskDelete: (on: boolean) => void;
  onReveal: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
  onConfirmRegenerate: () => void;
  onDismissRegen: () => void;
  onMenu: (open: boolean) => void;
};

type RowAction = RowMenuItem & {
  /** Also a button in the row (the frequent ones); every action is in the menu. */
  inline: boolean;
};

/** The ONE list of per-chat actions: the row's inline buttons and its menu both render it. */
function rowActions(p: RowProps): RowAction[] {
  const { chat } = p;
  const regenerating = p.regen?.phase === "running";
  const noTitleInput = !canRegenerateTitle(chat);
  return [
    { id: "resume", label: "Resume", onSelect: p.onOpen, inline: true },
    { id: "rename", label: "Rename", onSelect: p.onStartRename, inline: true },
    {
      id: "pin",
      label: chat.pinned ? "Unpin" : "Pin",
      onSelect: () => p.onAction(chat.pinned ? "unpin" : "pin"),
      inline: true,
    },
    {
      id: "archive",
      label: chat.archived ? "Unarchive" : "Archive",
      onSelect: () => p.onAction(chat.archived ? "unarchive" : "archive"),
      inline: true,
    },
    {
      id: "regenerate",
      label: "Regenerate title",
      onSelect: p.onRegenerate,
      disabled: regenerating || noTitleInput,
      hint: regenerating
        ? "Generating…"
        : noTitleInput
          ? "Nothing to title yet: the chat has no reply"
          : undefined,
      inline: false,
    },
    { id: "copy", label: "Copy as markdown", onSelect: p.onCopy, inline: true },
    { id: "reveal", label: "Reveal note", onSelect: p.onReveal, inline: true },
    { id: "delete", label: "Delete", onSelect: () => p.onAskDelete(true), inline: true },
  ];
}

function ChatRow(p: RowProps) {
  const { chat } = p;
  const [draft, setDraft] = useState(chat.title);
  const moreRef = useRef<HTMLButtonElement>(null);
  const when = formatRelativeTime(Math.floor(chat.updatedAt / 1000), Math.floor(p.now / 1000));
  const actions = rowActions(p);
  return (
    <li
      data-agent-history-row={chat.chatId}
      data-pinned={chat.pinned || undefined}
      data-archived={chat.archived || undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onMenu(true);
      }}
      className="group rounded-lg px-2 py-1.5 hover:bg-[var(--item-hover-bg)]"
    >
      {p.renaming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            p.onAction("rename", draft);
          }}
        >
          <input
            autoFocus
            aria-label="Chat title"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && p.onCancelRename()}
            className={`${FIELD} w-full`}
          />
        </form>
      ) : (
        <button type="button" onClick={p.onOpen} className="block w-full text-left">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
              {chat.pinned ? "\u{1F4CC} " : ""}
              {chat.title}
            </span>
            {when && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{when}</span>}
          </div>
          {chat.preview && (
            <div className="truncate text-[12px] text-[var(--text-muted)]">{chat.preview}</div>
          )}
        </button>
      )}
      {p.regen?.phase === "running" && (
        <div
          role="status"
          data-agent-history-regenerating
          className="mt-1 flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]"
        >
          <Spinner size={12} />
          Generating…
        </div>
      )}
      {p.regen?.phase === "error" && (
        <div className="mt-1 flex items-center gap-2 text-[12px]" role="alert">
          <span className="text-[var(--danger)]">{p.regen.message}</span>
          <button type="button" className={SMALL} onClick={p.onDismissRegen}>
            Dismiss
          </button>
        </div>
      )}
      {p.regen?.phase === "confirm" && (
        <div className="mt-1 flex items-center gap-2 text-[12px]" role="alert">
          <span className="text-[var(--text-muted)]">Replace your title?</span>
          <button type="button" className={SMALL} onClick={p.onConfirmRegenerate}>
            Replace
          </button>
          <button type="button" className={SMALL} onClick={p.onDismissRegen}>
            Cancel
          </button>
        </div>
      )}
      {p.confirmingDelete ? (
        <div className="mt-1 flex items-center gap-2 text-[12px]" role="alert">
          <span className="text-[var(--text-muted)]">Move this chat note to the Trash?</span>
          <button type="button" className={SMALL} onClick={() => p.onAction("delete")}>
            Move to Trash
          </button>
          <button type="button" className={SMALL} onClick={() => p.onAskDelete(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-0.5 flex flex-wrap gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {actions
            .filter((a) => a.inline)
            .map((a) => (
              <button key={a.id} type="button" className={SMALL} onClick={a.onSelect}>
                {a.label}
              </button>
            ))}
          <button
            ref={moreRef}
            type="button"
            className={SMALL}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={p.menuOpen}
            onClick={() => p.onMenu(!p.menuOpen)}
          >
            …
          </button>
        </div>
      )}
      {p.menuOpen && (
        <ChatRowMenu
          items={actions}
          anchorRef={moreRef}
          label={`Actions for ${chat.title}`}
          onClose={() => p.onMenu(false)}
        />
      )}
    </li>
  );
}

export type HistoryListProps = {
  /** Resume: the pane opens the chat from its note (and the CLI session when it still exists). */
  onOpen: (chat: ChatSummary) => void;
  client?: ChatHistoryClient;
  /** Start filtered to one project folder (`null` = no project); omit to show everything. */
  initialProject?: string | null;
  /** `agent.chats-keep-days`; 0 keeps forever and hides the clean-up row. */
  keepDays?: number;
  /** Absolute path of a chat note to a tab; defaults to the editor's new tab. */
  onReveal?: (chat: ChatSummary) => void;
  copyText?: (text: string) => Promise<void>;
  /** "Regenerate title" for a chat (open or not); defaults to the history client's call. */
  regenerateTitle?: (chatId: string) => Promise<RegenerateOutcome>;
  now?: () => number;
};

const ALL = "\u0000all";

/** Searchable chat history grouped by project (spec section 9): resume, rename, pin, archive,
 *  regenerate the title, copy as markdown, reveal the note, delete to the Trash (buttons on the
 *  row and a "..." / right-click menu with the same actions), and the keep-days clean-up. */
export function HistoryList({
  onOpen,
  client = chatHistoryClient,
  initialProject,
  keepDays = 0,
  onReveal,
  copyText = (t) => navigator.clipboard.writeText(t),
  regenerateTitle = (chatId) => client.regenerateTitle(chatId, null),
  now = Date.now,
}: HistoryListProps) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<HistorySort>("updated");
  const [project, setProject] = useState<string>(
    initialProject === undefined ? ALL : (initialProject ?? ""),
  );
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [regen, setRegen] = useState<Record<string, RegenState>>({});
  // the double-click guard: one title call per chat at a time, whatever the clicks do
  const regenerating = useRef(new Set<string>());

  const reload = useCallback(async () => {
    try {
      const list = await client.list({ projectPath: null, all: true, includeArchived: true });
      setChats(list);
      setError(null);
    } catch (e) {
      setError(describe(e));
    }
  }, [client]);

  useEffect(() => {
    let live = true;
    client
      .list({ projectPath: null, all: true, includeArchived: true })
      .then((list) => {
        if (live) setChats(list);
      })
      .catch((e) => {
        if (live) setError(describe(e));
      });
    return () => {
      live = false;
    };
  }, [client]);

  const visible = useMemo(() => {
    let list = chats ?? [];
    if (!showArchived) list = list.filter((c) => !c.archived);
    if (project !== ALL)
      list = list.filter((c) => c.projectPath === (project === "" ? null : project));
    return filterChats(list, query);
  }, [chats, showArchived, project, query]);
  const groups = useMemo(() => groupByProject(visible, sort), [visible, sort]);
  const projects = useMemo(() => projectsOf(chats ?? []), [chats]);
  const stale = useMemo(
    () => cleanupCandidates(chats ?? [], keepDays, now()),
    [chats, keepDays, now],
  );

  async function run(chat: ChatSummary, action: ChatAction, title?: string) {
    try {
      await client.action(chat.chatId, action, title);
      setRenaming(null);
      setDeleting(null);
      await reload();
    } catch (e) {
      setError(describe(e));
    }
  }

  const setRegenFor = (chatId: string, state: RegenState | undefined) =>
    setRegen((all) => {
      const { [chatId]: _old, ...rest } = all;
      return state ? { ...rest, [chatId]: state } : rest;
    });

  async function regenerate(chat: ChatSummary) {
    const id = chat.chatId;
    if (regenerating.current.has(id)) return;
    regenerating.current.add(id);
    setRegenFor(id, { phase: "running" });
    try {
      const outcome = await regenerateTitle(id);
      if (outcome.status === "done") {
        setRegenFor(id, undefined);
        await reload();
      } else {
        setRegenFor(id, { phase: "error", message: REGENERATE_REFUSAL_TEXT[outcome.reason] });
      }
    } catch (e) {
      setRegenFor(id, {
        phase: "error",
        message: `Could not regenerate the title: ${describe(e)}`,
      });
    } finally {
      regenerating.current.delete(id);
    }
  }

  /** A title the user chose is replaced only after one small confirmation. */
  function askRegenerate(chat: ChatSummary) {
    if (regenerating.current.has(chat.chatId)) return;
    if (chat.titleSource === "user") setRegenFor(chat.chatId, { phase: "confirm" });
    else void regenerate(chat);
  }

  async function copy(chat: ChatSummary) {
    try {
      const loaded = await client.load(chat.chatId);
      await copyText(transcriptMarkdown(parseChatNote(loaded.markdown)));
      setNotice("Copied the chat as markdown.");
    } catch (e) {
      setError(describe(e));
    }
  }

  async function cleanUp() {
    try {
      for (const c of stale) await client.action(c.chatId, "delete");
      setNotice(`Moved ${stale.length} old chat${stale.length === 1 ? "" : "s"} to the Trash.`);
      setCleaning(false);
      await reload();
    } catch (e) {
      setError(describe(e));
      await reload();
    }
  }

  return (
    <div data-agent-history className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line-subtler)] p-3">
        <input
          type="search"
          aria-label="Search chats"
          placeholder="Search chats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <select
          aria-label="Project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          className={FIELD}
        >
          <option value={ALL}>All projects</option>
          {projects.map((p) => (
            <option key={p ?? ""} value={p ?? ""}>
              {projectLabel(p)}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as HistorySort)}
          className={FIELD}
        >
          <option value="updated">Last updated</option>
          <option value="created">Created</option>
        </select>
        <label className="flex items-center gap-1 text-[12px] text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Archived
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error && (
          <div role="alert" className="px-2 py-1 text-[12px] text-[var(--danger)]">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="px-2 py-1 text-[12px] text-[var(--text-muted)]">
            {notice}
          </div>
        )}
        {chats === null && !error && (
          <div className="px-2 py-3 text-[13px] text-[var(--text-muted)]">Loading chats…</div>
        )}
        {chats !== null && groups.length === 0 && (
          <div data-agent-history-empty className="px-2 py-3 text-[13px] text-[var(--text-muted)]">
            {query ? "No chats match your search." : "No saved chats yet."}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.projectPath ?? ""} data-agent-history-group={g.projectPath ?? ""}>
            <h2 className="px-2 pt-2 pb-1 text-[11px] font-medium text-[var(--text-muted)] uppercase">
              {g.label}
            </h2>
            <ul>
              {g.chats.map((c) => (
                <ChatRow
                  key={c.chatId}
                  chat={c}
                  now={now()}
                  renaming={renaming === c.chatId}
                  confirmingDelete={deleting === c.chatId}
                  regen={regen[c.chatId]}
                  menuOpen={menuFor === c.chatId}
                  onMenu={(open) => setMenuFor(open ? c.chatId : null)}
                  onRegenerate={() => askRegenerate(c)}
                  onConfirmRegenerate={() => void regenerate(c)}
                  onDismissRegen={() => setRegenFor(c.chatId, undefined)}
                  onOpen={() => onOpen(c)}
                  onAction={(a, t) => void run(c, a, t)}
                  onStartRename={() => setRenaming(c.chatId)}
                  onCancelRename={() => setRenaming(null)}
                  onAskDelete={(on) => setDeleting(on ? c.chatId : null)}
                  onReveal={() => onReveal?.(c)}
                  onCopy={() => void copy(c)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {keepDays > 0 && stale.length > 0 && (
        <div
          data-agent-history-cleanup
          className="flex items-center gap-2 border-t border-[var(--line-subtler)] px-3 py-2 text-[12px]"
        >
          <span className="flex-1 text-[var(--text-muted)]">
            {stale.length} chat{stale.length === 1 ? "" : "s"} not touched for {keepDays} days.
          </span>
          {cleaning ? (
            <>
              <button type="button" className={SMALL} onClick={() => void cleanUp()}>
                Move {stale.length} to Trash
              </button>
              <button type="button" className={SMALL} onClick={() => setCleaning(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className={SMALL} onClick={() => setCleaning(true)}>
              Clean up
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The history view of the pane: `HistoryList` wired to the settings, the workspace and the
 *  editor. The pane's `HistorySlot` renders this with its own `onOpen`. */
export function HistoryPane({ onOpen }: { onOpen: (chat: ChatSummary) => void }) {
  const root = useWorkspaceRoot();
  const keepDays = Number(useSetting("agent.chats-keep-days") ?? 0);
  return (
    <HistoryList
      onOpen={onOpen}
      regenerateTitle={regenerateAgentChatTitle}
      keepDays={keepDays}
      onReveal={(c) => root && void openFileInNewTab(chatNoteAbsPath(root, c))}
    />
  );
}
