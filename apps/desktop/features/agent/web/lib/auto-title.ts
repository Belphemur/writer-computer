/**
 * Automatic chat titles, the pane's side (spec "Automatic chat titles"): WHEN to ask for a title
 * and the words for "Regenerate title". Pure; the store owns the in-flight guard and the apply,
 * Rust (`agent/title.rs`) owns the title input (read from the saved note), the call, the prompt
 * cuts and the sanitising.
 */
import { type ChatNoteMessage, type ChatNoteMeta, titleSourceOf } from "./chat-note";
import { backendOrDefault } from "./backends";
import type { ChatSummary, RegenerateOutcome, RegenerateRefusal, TitleSource } from "./events";
import type { NoteState } from "./chat-persist";
import type { Chat } from "./transcript";

/** Completed user/assistant exchanges before the first automatic attempt. */
export const AUTO_TITLE_AFTER_EXCHANGES = 2;
/** A first user message at least this long is enough on its own: it already says what the chat is about. */
export const AUTO_TITLE_LONG_FIRST_MESSAGE_CHARS = 200;
/** Assistant replies that finished normally (an interrupted or failed turn is not an exchange). */
export function completedExchanges(messages: readonly ChatNoteMessage[]): number {
  return messages.filter(
    (m) => m.role === "assistant" && m.reason === "completed" && m.text.trim() !== "",
  ).length;
}

export type TitleTriggerInput = {
  /** `agent.auto-title-chats`. */
  enabled: boolean;
  meta: Pick<ChatNoteMeta, "titleRenamed" | "titleAuto">;
  messages: readonly ChatNoteMessage[];
  /** An attempt already started or finished for this chat in this window: one per chat. */
  attempted: boolean;
};

/** The trigger rule: setting on, nobody chose a title yet (a rename always wins), no earlier
 *  attempt, and two completed exchanges (one when the first message is long). */
export function shouldAutoTitle(i: TitleTriggerInput): boolean {
  if (!i.enabled || i.attempted) return false;
  const source: TitleSource = titleSourceOf(i.meta);
  if (source !== "none") return false;
  const exchanges = completedExchanges(i.messages);
  if (exchanges >= AUTO_TITLE_AFTER_EXCHANGES) return true;
  const firstUser = i.messages.find((m) => m.role === "user");
  return (
    exchanges >= 1 && (firstUser?.text.trim().length ?? 0) >= AUTO_TITLE_LONG_FIRST_MESSAGE_CHARS
  );
}

/** Adopt the summary Rust answered with: the tab title and the note's title flags. Rust decided
 *  (a rename made meanwhile comes back as `user` with the user's title), so the pane never
 *  guesses. `null` when there is nothing to adopt. */
export function applyTitleSummary(
  chat: Chat,
  note: NoteState | undefined,
  summary: Pick<ChatSummary, "title" | "titleSource">,
): { chat: Chat; note: NoteState | undefined } | null {
  // An absent `titleSource` is the wire's way of saying nobody chose a title (`none`).
  const source = summary.titleSource ?? "none";
  if (source === "none" || summary.title === "") return null;
  return {
    chat: chat.title === summary.title ? chat : { ...chat, title: summary.title },
    note: note && {
      ...note,
      meta: {
        ...note.meta,
        title: summary.title,
        titleAuto: source === "auto",
        titleRenamed: source === "user",
      },
    },
  };
}

export type { RegenerateOutcome, RegenerateRefusal };

/** What a refusal names when the caller does not know the chat's agent (the history list: a saved
 *  summary has no backend). */
const DEFAULT_PRODUCT = backendOrDefault(null).product;

/** The inline sentence for each refusal: the one place that words them. */
export const REGENERATE_REFUSAL_TEXT: Record<RegenerateRefusal, string> = {
  "no-binary": `${DEFAULT_PRODUCT} was not found. Check Settings > Agent.`,
  unavailable: `${DEFAULT_PRODUCT} is turned off. Turn it on in Settings > Features.`,
  "no-reply": "This chat has no reply to title yet.",
  failed: "Could not generate a title. The old one is kept.",
};

/** The sentence for a refusal, naming the chat's agent (`product` of its backend descriptor) when
 *  the caller knows it. */
export function refusalText(reason: RegenerateRefusal, product?: string): string {
  if (!product) return REGENERATE_REFUSAL_TEXT[reason];
  if (reason === "no-binary") return `${product} was not found. Check Settings > Agent.`;
  if (reason === "unavailable") {
    return `${product} is turned off. Turn it on in Settings > Features.`;
  }
  return REGENERATE_REFUSAL_TEXT[reason];
}

/** "Regenerate title" needs something to title: at least one user message (the saved note holds
 *  the assistant reply, which only Rust can check; it answers `no-reply` when there is none). */
export const canRegenerateTitle = (chat: Pick<ChatSummary, "turnCount">): boolean =>
  chat.turnCount > 0;

/** Why there is nothing to title: shown as the disabled hint in history and by `/regenerate-title`. */
export const NOTHING_TO_TITLE_TEXT = "Nothing to title yet: the chat has no reply";
