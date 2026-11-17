import { useId, useMemo, useRef, useState } from "react";
import {
  decideAgentPermission,
  hasPendingAgentPermission,
  loadAgentSkills,
  removeQueuedMessage,
  sendAgentMessage,
  setAgentDraft,
  stopAgent,
} from "@/hooks/agent-api";
import {
  useActiveNoteRelative,
  useAttachActiveNoteSetting,
  useCliCatalog,
  useDiskSkills,
  useFocusComposerTick,
  type Chat,
  type Draft,
} from "@/hooks/use-agent";
import type { ContextRef } from "@/lib/agent/events";
import {
  searchMentions,
  specialMentions,
  toContextRef,
  type MentionCandidate,
} from "@/lib/agent/mentions";
import { isBusy, isComposerDisabled } from "@/lib/agent/reduce";
import {
  SLASH_EMPTY_TEXT,
  SOURCE_LABEL,
  loadedLabel,
  applySlash,
  filterSlash,
  mergeSlashItems,
  slashQuery,
} from "@/lib/agent/slash-commands";
import { fuzzySearch } from "@/lib/tauri";
import { ComposerActions } from "./composer-actions";
import { ContextChips } from "./context-chips";
import { SuggestionMenu, type Suggestion } from "./suggestion-menu";
import { useFocusOnTick } from "./use-focus-on-tick";
import { useLoadSkillsOnMount } from "./use-load-skills";

const EMPTY: Draft = { text: "", mentions: [], activeNote: true };

type Menu =
  | { kind: "mention"; start: number; query: string; items: MentionCandidate[]; active: number }
  | { kind: "slash"; query: string; active: number };

const MENTION_TRIGGER = /(^|\s)@([^\s@]*)$/;

/** Text before the caret ends in `@query`: its start index (of the `@`) and the query. */
export function mentionTrigger(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = MENTION_TRIGGER.exec(before);
  return m ? { start: before.length - m[2]!.length - 1, query: m[2]! } : null;
}

function placeholder(chat: Chat): string {
  switch (chat.state) {
    case "cancelling":
      return "Stopping…";
    case "reconnecting":
      return "Reconnecting…";
    case "ended":
      return "This chat has ended";
    case "error":
      return isComposerDisabled(chat) ? "Fix the problem above to continue" : "Ask anything";
    default:
      return "Ask anything, @ to add context, / for commands";
  }
}

export function Composer({
  chat,
  draft = EMPTY,
  hasQueued = false,
}: {
  chat: Chat;
  draft?: Draft;
  hasQueued?: boolean;
}) {
  const chatId = chat.chatId;
  const area = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [menu, setMenu] = useState<Menu | null>(null);
  const searchSeq = useRef(0);
  const focusTick = useFocusComposerTick();
  useFocusOnTick(area, focusTick);

  const activeNote = useActiveNoteRelative();
  const attachByDefault = useAttachActiveNoteSetting();
  const disk = useDiskSkills(chat.projectPath);
  const catalog = useCliCatalog();
  useLoadSkillsOnMount(chat.projectPath);
  const allSlash = useMemo(
    () => mergeSlashItems(disk?.items ?? [], chat.session, catalog),
    [disk?.items, chat.session, catalog],
  );
  const slashItems = useMemo(
    () => (menu?.kind === "slash" ? filterSlash(allSlash, menu.query) : []),
    [allSlash, menu],
  );
  const slashSuggestions: Suggestion[] = slashItems.map((i) => ({
    id: i.name,
    label: `/${i.name}`,
    detail: i.description || (i.kind === "skill" ? "Skill" : "Command"),
    icon: "/",
    tag: SOURCE_LABEL[i.source],
    status: loadedLabel(i) || undefined,
  }));
  const slashEmpty =
    allSlash.length > 0
      ? "No matching commands"
      : disk?.status === "loading"
        ? "Loading skills…"
        : SLASH_EMPTY_TEXT;

  const disabled = isComposerDisabled(chat);
  const busy = isBusy(chat);
  const text = draft.text;

  function grow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  function setText(value: string, caret: number) {
    setAgentDraft(chatId, { text: value });
    const trigger = mentionTrigger(value, caret);
    if (trigger) {
      const seq = ++searchSeq.current;
      setMenu({
        kind: "mention",
        start: trigger.start,
        query: trigger.query,
        items: [],
        active: 0,
      });
      void searchMentions(trigger.query, fuzzySearch)
        .then((items) => {
          if (seq === searchSeq.current)
            setMenu((m) => (m?.kind === "mention" ? { ...m, items, active: 0 } : m));
        })
        .catch(() => {
          if (seq === searchSeq.current) setMenu(null);
        });
      return;
    }
    searchSeq.current++;
    const slash = slashQuery(value);
    if (slash !== null) {
      // Opening the menu re-reads the skills on disk (they may have changed); the cache shows meanwhile.
      if (menu?.kind !== "slash") void loadAgentSkills(chat.projectPath);
      setMenu({ kind: "slash", query: slash, active: 0 });
      return;
    }
    setMenu(null);
  }

  function pickMention(c: MentionCandidate) {
    const el = area.current;
    if (!el || menu?.kind !== "mention") return;
    const caret = el.selectionStart;
    const next = `${text.slice(0, menu.start)}${text.slice(caret)}`.replace(/^ /, "");
    const ref = toContextRef(c);
    if (c.kind === "active-note") {
      // The same chip the pane attaches by default; picking brings it back after it was removed.
      // With the default off there is no automatic chip, so the pick adds an explicit one.
      const mentions: ContextRef[] = attachByDefault
        ? draft.mentions
        : [...draft.mentions.filter((m) => m.kind !== "active-note"), ref];
      setAgentDraft(chatId, { text: next, mentions, activeNote: true });
      setMenu(null);
      el.focus();
      return;
    }
    const exists = draft.mentions.some(
      (m) => m.kind === ref.kind && "path" in m && "path" in ref && m.path === ref.path,
    );
    const mentions: ContextRef[] = exists ? draft.mentions : [...draft.mentions, ref];
    setAgentDraft(chatId, { text: next, mentions });
    setMenu(null);
    el.focus();
  }

  function pickSlash(s: Suggestion) {
    setAgentDraft(chatId, { text: applySlash(text, s.id) });
    setMenu(null);
    area.current?.focus();
  }

  // Shortcuts (`@activenote`) come first, then folders and notes from the search.
  const mentionCandidates: MentionCandidate[] =
    menu?.kind === "mention" ? [...specialMentions(menu.query, activeNote), ...menu.items] : [];
  const mentionSuggestions: Suggestion[] =
    menu?.kind === "mention"
      ? mentionCandidates.map((c) => ({
          id: `${c.kind}:${c.path}`,
          label: c.label,
          detail: c.detail,
          icon: c.kind === "folder" ? "▸" : c.kind === "active-note" ? "@" : "·",
        }))
      : [];
  const suggestions = menu?.kind === "slash" ? slashSuggestions : mentionSuggestions;

  function pickActive() {
    if (!menu) return;
    if (menu.kind === "mention") {
      const c = mentionCandidates[menu.active];
      if (c) pickMention(c);
    } else {
      const s = slashSuggestions[menu.active];
      if (s) pickSlash(s);
    }
  }

  function send() {
    if (!text.trim() || disabled) return;
    setMenu(null);
    void sendAgentMessage(text);
    if (area.current) area.current.style.height = "auto";
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;

    // Permission shortcuts work from the composer while a card is showing (spec 3.6).
    if (mod && hasPendingAgentPermission()) {
      const req = chat.pendingPermissions[0];
      if (req && e.key === "Enter") {
        e.preventDefault();
        void decideAgentPermission(req.requestId, "allow", e.shiftKey ? "project" : undefined);
        return;
      }
      if (req && e.key === "Backspace") {
        e.preventDefault();
        void decideAgentPermission(req.requestId, "deny");
        return;
      }
    }

    if (menu && suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setMenu({
          ...menu,
          active: (menu.active + d + suggestions.length) % suggestions.length,
        } as Menu);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickActive();
        return;
      }
    }

    if (e.key === "Escape") {
      // In order: close an open menu, clear a queued chip, stop the turn, return to the editor.
      if (menu) {
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
      } else if (hasQueued) {
        e.preventDefault();
        removeQueuedMessage(chatId);
      } else if (busy && chat.state !== "cancelling") {
        e.preventDefault();
        void stopAgent();
      } else {
        e.currentTarget.blur();
        document.querySelector<HTMLElement>(".cm-content")?.focus();
      }
      return;
    }

    if (e.key === "Enter" && !e.shiftKey && !mod) {
      e.preventDefault();
      send();
      return;
    }

    if (e.key === "ArrowUp" && text === "" && !mod) {
      const last = [...chat.turns].reverse().find((t) => t.user)?.user;
      if (last) {
        e.preventDefault();
        setAgentDraft(chatId, { text: last.text });
      }
    }
  }

  return (
    <div className="relative">
      {menu && (
        <SuggestionMenu
          id={listId}
          label={menu.kind === "mention" ? "Add context" : "Commands"}
          items={suggestions}
          emptyText={menu.kind === "slash" ? slashEmpty : undefined}
          activeIndex={menu.active}
          onPick={(s) => {
            if (menu.kind === "slash") pickSlash(s);
            else {
              const c = mentionCandidates.find((i) => `${i.kind}:${i.path}` === s.id);
              if (c) pickMention(c);
            }
          }}
        />
      )}
      <div className="m-3 mt-2 rounded-xl border border-[var(--line-subtle)] bg-[var(--surface-input)] focus-within:border-[var(--focus-border)]">
        <ContextChips chatId={chatId} draft={draft} />
        <textarea
          ref={area}
          value={text}
          disabled={disabled}
          rows={2}
          aria-label="Message the agent"
          aria-autocomplete="list"
          aria-expanded={menu !== null}
          aria-controls={menu ? listId : undefined}
          aria-activedescendant={
            menu && suggestions.length ? `${listId}-${menu.active}` : undefined
          }
          role="combobox"
          placeholder={placeholder(chat)}
          onChange={(e) => {
            grow(e.currentTarget);
            setText(e.currentTarget.value, e.currentTarget.selectionStart);
          }}
          onKeyDown={onKeyDown}
          className="block max-h-[40vh] w-full resize-none bg-transparent px-3 py-2.5 text-[14px] leading-snug text-text-primary outline-none placeholder:text-text-muted disabled:opacity-60"
        />
        <ComposerActions
          chat={chat}
          chatId={chatId}
          busy={busy}
          stopping={chat.state === "cancelling"}
          canSend={text.trim() !== "" && !disabled}
          onSend={send}
        />
      </div>
    </div>
  );
}
