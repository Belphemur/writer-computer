import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  mentionToken,
  middleTruncate,
  pickLabel,
  unattachedMentions,
  toContextRef,
  type MentionCandidate,
} from "@/lib/agent/mentions";
import { isBusy, isComposerDisabled } from "@/lib/agent/reduce";
import {
  SLASH_EMPTY_TEXT,
  SOURCE_LABEL,
  loadedLabel,
  filterSlash,
  mergeSlashItems,
} from "@/lib/agent/slash-commands";
import { applyTrigger, findTrigger, type Trigger } from "@/lib/agent/trigger";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { usePopoverPlacement } from "@/hooks/use-popover-placement";
import { fuzzySearch } from "@/lib/tauri";
import { ComposerActions } from "./composer-actions";
import { ContextChips } from "./context-chips";
import { SuggestionMenu, type Suggestion } from "./suggestion-menu";
import { useFocusOnTick } from "./use-focus-on-tick";
import { useLoadSkillsOnMount } from "./use-load-skills";

const EMPTY: Draft = { text: "", mentions: [], activeNote: true };

type Menu =
  | { kind: "mention"; trigger: Trigger; items: MentionCandidate[]; active: number }
  | { kind: "slash"; trigger: Trigger; active: number };

/** Identifies a token, so a dismissed menu stays closed until the caret moves to another one. */
const tokenKey = (t: Trigger) => `${t.char}${t.start}:${t.query}`;

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
  const composing = useRef(false);
  const dismissed = useRef<string | null>(null);
  const pendingCaret = useRef<number | null>(null);
  /** The last pick, so Cmd+Z right after it restores the typed token. */
  const lastPick = useRef<{ before: string; caret: number; after: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Tokens whose "not attached" hint the user closed (the hint never blocks sending). */
  const [hintClosed, setHintClosed] = useState<ReadonlySet<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
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
    () => (menu?.kind === "slash" ? filterSlash(allSlash, menu.trigger.query) : []),
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

  /** Opens, updates or closes the menu for the token the caret is in. */
  function refresh(value: string, caret: number) {
    const trigger = findTrigger(value, caret, composing.current);
    if (!trigger || dismissed.current === tokenKey(trigger)) {
      if (!trigger) dismissed.current = null;
      searchSeq.current++;
      setMenu(null);
      return;
    }
    if (
      menu &&
      menu.trigger.char === trigger.char &&
      tokenKey(menu.trigger) === tokenKey(trigger)
    ) {
      if (menu.trigger.end !== trigger.end) setMenu({ ...menu, trigger } as Menu);
      return;
    }
    if (trigger.char === "@") {
      const seq = ++searchSeq.current;
      setMenu({ kind: "mention", trigger, items: [], active: 0 });
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
    // Opening the menu re-reads the skills on disk (they may have changed); the cache shows meanwhile.
    if (menu?.kind !== "slash") void loadAgentSkills(chat.projectPath);
    setMenu({ kind: "slash", trigger, active: 0 });
  }

  function closeMenu() {
    if (menu) dismissed.current = tokenKey(menu.trigger);
    searchSeq.current++;
    setMenu(null);
  }

  /** Puts `replacement` in place of the token under the caret and the caret after it. */
  function replaceToken(t: Trigger, replacement: string, extra: Partial<Draft> = {}) {
    const next = applyTrigger(text, t, replacement);
    lastPick.current = { before: text, caret: t.start + 1 + t.query.length, after: next.text };
    pendingCaret.current = next.caret;
    setAgentDraft(chatId, { text: next.text, ...extra });
    searchSeq.current++;
    setMenu(null);
    area.current?.focus();
  }

  function pickMention(c: MentionCandidate) {
    if (menu?.kind !== "mention") return;
    const label = c.kind === "active-note" ? undefined : pickLabel(c, draft.mentions);
    const ref = toContextRef(c, label);
    if (c.kind === "active-note") {
      // The same chip the pane attaches by default; picking brings it back after it was removed.
      // With the default off there is no automatic chip, so the pick adds an explicit one.
      const mentions: ContextRef[] = attachByDefault
        ? draft.mentions
        : [...draft.mentions.filter((m) => m.kind !== "active-note"), ref];
      replaceToken(menu.trigger, "@activenote", { mentions, activeNote: true });
      return;
    }
    const exists = draft.mentions.some(
      (m) => m.kind === ref.kind && "path" in m && "path" in ref && m.path === ref.path,
    );
    const mentions: ContextRef[] = exists ? draft.mentions : [...draft.mentions, ref];
    replaceToken(menu.trigger, mentionToken(label ?? c.path), { mentions });
  }

  function pickSlash(s: Suggestion) {
    if (menu?.kind !== "slash") return;
    replaceToken(menu.trigger, `/${s.id}`);
  }

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret !== null && area.current) {
      area.current.setSelectionRange(caret, caret);
      pendingCaret.current = null;
    }
  });

  usePopoverDismiss(menuRef, area, closeMenu, menu !== null);
  const placement = usePopoverPlacement(wrapRef, menu !== null, {
    width: 520,
    maxHeight: 224,
    side: "top",
  });

  // Shortcuts (`@activenote`) come first, then folders and notes from the search.
  const mentionCandidates: MentionCandidate[] =
    menu?.kind === "mention"
      ? [...specialMentions(menu.trigger.query, activeNote), ...menu.items]
      : [];
  const mentionSuggestions: Suggestion[] =
    menu?.kind === "mention"
      ? mentionCandidates.map((c) => ({
          id: `${c.kind}:${c.path}`,
          label: c.label,
          detail: middleTruncate(c.detail),
          title: c.path,
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

  const unattached =
    menu?.kind === "mention"
      ? []
      : unattachedMentions(text, draft.mentions).filter((t) => !hintClosed.has(t));

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

    // Cmd+Z right after a pick gives the typed token back (a programmatic edit has no native undo).
    if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
      const pick = lastPick.current;
      if (pick && pick.after === text) {
        e.preventDefault();
        lastPick.current = null;
        pendingCaret.current = pick.caret;
        setAgentDraft(chatId, { text: pick.before });
        refresh(pick.before, pick.caret);
        return;
      }
    }

    if (e.key === "Escape") {
      // In order: close an open menu, clear a queued chip, stop the turn, return to the editor.
      if (menu) {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
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
    <div ref={wrapRef} className="relative">
      {menu && (
        <SuggestionMenu
          id={listId}
          menuRef={menuRef}
          style={placement}
          hint={
            menu.kind === "slash" && !menu.trigger.atStart
              ? "Mid-message: referenced by name"
              : undefined
          }
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
            setAgentDraft(chatId, { text: e.currentTarget.value });
            refresh(e.currentTarget.value, e.currentTarget.selectionStart);
          }}
          onSelect={(e) => refresh(e.currentTarget.value, e.currentTarget.selectionStart)}
          onCompositionStart={() => {
            composing.current = true;
            closeMenu();
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            dismissed.current = null;
            refresh(e.currentTarget.value, e.currentTarget.selectionStart);
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
      {unattached.length > 0 && (
        <p
          role="status"
          data-agent-unattached-hint
          className="mx-3 -mt-1 mb-2 flex items-start gap-2 text-[11.5px] text-text-muted"
        >
          <span className="min-w-0 flex-1">
            {unattached[0]} is not attached: pick a note from the menu
            {unattached.length > 1 ? ` (and ${unattached.length - 1} more)` : ""}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 rounded px-1 hover:bg-[var(--item-hover-bg)] hover:text-text-primary"
            onClick={() => setHintClosed(new Set([...hintClosed, ...unattached]))}
          >
            ×
          </button>
        </p>
      )}
    </div>
  );
}
