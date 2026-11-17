/**
 * Pure view logic of the history list: search, sort, group by project, clean-up candidates.
 * No React, no IO (`web/components/history-list.tsx` renders it).
 */
import type { ChatSummary } from "./events";

export type HistorySort = "updated" | "created";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every whitespace-separated word must occur in the title or the first message (the same rule as
 *  the Rust `list` query). */
export function filterChats(chats: readonly ChatSummary[], query: string): ChatSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...chats];
  return chats.filter((c) => {
    const hay = `${c.title}\n${c.preview ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Pinned first, then newest by the chosen date, ties by id so the order is stable. */
export function sortChats(chats: readonly ChatSummary[], by: HistorySort): ChatSummary[] {
  const key = (c: ChatSummary) => (by === "created" ? c.createdAt : c.updatedAt);
  return [...chats].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) || key(b) - key(a) || a.chatId.localeCompare(b.chatId),
  );
}

export type ChatGroup = {
  /** Vault-relative project folder; null for chats without a project. */
  projectPath: string | null;
  label: string;
  chats: ChatSummary[];
};

export const VAULT_GROUP_LABEL = "No project";

export function projectLabel(path: string | null): string {
  if (path === null) return VAULT_GROUP_LABEL;
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Groups in order of their most recent chat; the vault's own chats are one group. Within a group
 *  the chats keep `sortChats` order. */
export function groupByProject(chats: readonly ChatSummary[], by: HistorySort): ChatGroup[] {
  const sorted = sortChats(chats, by);
  const groups = new Map<string | null, ChatGroup>();
  for (const c of sorted) {
    const g = groups.get(c.projectPath) ?? {
      projectPath: c.projectPath,
      label: projectLabel(c.projectPath),
      chats: [],
    };
    g.chats.push(c);
    groups.set(c.projectPath, g);
  }
  return [...groups.values()];
}

/** Projects present in the list, for the filter menu. */
export function projectsOf(chats: readonly ChatSummary[]): (string | null)[] {
  return [...new Set(chats.map((c) => c.projectPath))].sort((a, b) =>
    projectLabel(a).localeCompare(projectLabel(b)),
  );
}

/** Chats untouched for `keepDays` days. 0 (keep forever) or less returns nothing; pinned chats
 *  are never offered. */
export function cleanupCandidates(
  chats: readonly ChatSummary[],
  keepDays: number,
  now: number,
): ChatSummary[] {
  if (!(keepDays > 0)) return [];
  const cutoff = now - keepDays * DAY_MS;
  return chats.filter((c) => !c.pinned && c.updatedAt > 0 && c.updatedAt < cutoff);
}

/** Absolute path of a chat note for `openFileInNewTab` ("Reveal chat note"). */
export function chatNoteAbsPath(root: string, summary: Pick<ChatSummary, "path">): string {
  return `${root.replace(/\/+$/, "")}/${summary.path}`;
}
