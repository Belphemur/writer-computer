import { isolateHistory } from "@codemirror/commands";
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
import { pillRanges, type PillContext } from "@/lib/agent/pill";
import { openVaultPath } from "./agent-links";
import { useComposerView } from "./use-composer-view";
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
  const listId = useId();
  const [menu, setMenu] = useState<Menu | null>(null);
  const searchSeq = useRef(0);
  const composing = useRef(false);
  const dismissed = useRef<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Tokens whose "not attached" hint the user closed (the hint never blocks sending). */
  const [hintClosed, setHintClosed] = useState<ReadonlySet<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
  const focusTick = useFocusComposerTick();

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

  /** What the pills of the draft are checked against: the attached refs (the active note's
   *  included) and the known skills (undefined until some are listed: nothing is judged). */
  const pills = useMemo<PillContext>(
    () => ({
      refs: [
        ...(activeNote ? [{ kind: "active-note" as const, path: activeNote, inline: false }] : []),
        ...draft.mentions,
      ],
      skills: allSlash.length > 0 ? new Set(allSlash.map((i) => i.name.toLowerCase())) : undefined,
    }),
    [activeNote, draft.mentions, allSlash],
  );

  /** Opens, updates or closes the menu for the token the caret is in. */
  function refresh(value: string, caret: number, isComposing = false) {
    // A pill the caret touches is a finished reference, not a token being typed: no menu for it.
    const onPill = pillRanges(value, pills).some(
      (p) => p.model.attached && caret >= p.from && caret <= p.to,
    );
    const trigger = onPill ? null : findTrigger(value, caret, composing.current || isComposing);
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

  /** Puts `replacement` in place of the token under the caret and the caret after it. One
   *  isolated history event, so Cmd+Z right after a pick gives the typed token back. The refs go
   *  to the store first; the editor's change then reconciles them with the new text. */
  function replaceToken(t: Trigger, replacement: string, extra: Partial<Draft> = {}) {
    const v = view.current;
    if (!v) return;
    const before = v.state.doc.toString();
    const next = applyTrigger(before, t, replacement);
    setAgentDraft(chatId, extra);
    searchSeq.current++;
    setMenu(null);
    v.dispatch({
      changes: { from: 0, to: before.length, insert: next.text },
      selection: { anchor: next.caret },
      userEvent: "input.complete",
      annotations: isolateHistory.of("full"),
    });
    v.focus();
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
  }

  /** Composer keys; true when consumed. Everything else reaches the editor's own keymap
   *  (arrows and Backspace over whole pills, undo, Shift+Enter for a newline). */
  function onKey(e: KeyboardEvent): boolean {
    const mod = e.metaKey || e.ctrlKey;

    // Permission shortcuts work from the composer while a card is showing (spec 3.6).
    if (mod && hasPendingAgentPermission()) {
      const req = chat.pendingPermissions[0];
      if (req && e.key === "Enter") {
        e.preventDefault();
        void decideAgentPermission(req.requestId, "allow", e.shiftKey ? "project" : undefined);
        return true;
      }
      if (req && e.key === "Backspace") {
        e.preventDefault();
        void decideAgentPermission(req.requestId, "deny");
        return true;
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
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickActive();
        return true;
      }
    }

    if (e.key === "Escape") {
      // In order: close an open menu, clear a queued chip, stop the turn, return to the editor.
      e.preventDefault();
      if (menu) {
        e.stopPropagation();
        closeMenu();
      } else if (hasQueued) {
        removeQueuedMessage(chatId);
      } else if (busy && chat.state !== "cancelling") {
        void stopAgent();
      } else {
        view.current?.contentDOM.blur();
        document.querySelector<HTMLElement>(".cm-content:not([data-agent-composer])")?.focus();
      }
      return true;
    }

    if (e.key === "Enter" && !e.shiftKey && !mod) {
      e.preventDefault();
      send();
      return true;
    }

    if (e.key === "ArrowUp" && text === "" && !mod) {
      const last = [...chat.turns].reverse().find((t) => t.user)?.user;
      if (last) {
        e.preventDefault();
        setAgentDraft(chatId, { text: last.text });
        return true;
      }
    }
    return false;
  }

  const { host, view, contentRef } = useComposerView({
    text,
    pills,
    disabled,
    placeholder: placeholder(chat),
    aria: {
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      ...(menu ? { "aria-controls": listId } : {}),
      ...(menu && suggestions.length
        ? { "aria-activedescendant": `${listId}-${menu.active}` }
        : {}),
    },
    handlers: {
      onKey,
      open: openVaultPath,
      onChange: (value, caret, isComposing) => {
        setAgentDraft(chatId, { text: value });
        refresh(value, caret, isComposing);
      },
      onCompositionStart: () => {
        composing.current = true;
        closeMenu();
      },
      onCompositionEnd: () => {
        composing.current = false;
        dismissed.current = null;
        const v = view.current;
        if (v) refresh(v.state.doc.toString(), v.state.selection.main.head);
      },
    },
  });
  useFocusOnTick(contentRef, focusTick);
  usePopoverDismiss(menuRef, contentRef, closeMenu, menu !== null);
  const placement = usePopoverPlacement(wrapRef, menu !== null, {
    width: 520,
    maxHeight: 224,
    side: "top",
    watch: menu?.trigger.start,
    anchorX: () => {
      const v = view.current;
      if (!v || !menu) return null;
      try {
        return v.coordsAtPos(menu.trigger.start)?.left ?? null;
      } catch {
        return null; // no layout (not rendered yet)
      }
    },
  });

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
        <div
          ref={host}
          data-agent-composer-editor
          data-disabled={disabled || undefined}
          className="agent-composer-editor"
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
