/**
 * The pane's side of chat persistence (spec section 9): what the note holds, kept next to the
 * transcript and folded from the same events. Pure: the store owns the state, `chat-saver.ts` owns
 * the debounced writes, `chat-note.ts` (lane 4) owns the format.
 */
import type { AgentEvent, ContextRef } from "./events";
import {
  type ChatNoteDoc,
  type ChatNoteMessage,
  type ChatNoteMeta,
  contextLine,
  emptyMeta,
  foldAssistantEvents,
  previewOf,
  serializeChatNote,
  titleFromMessage,
} from "./chat-note";
import type { Chat } from "./transcript";

export type NoteState = {
  meta: ChatNoteMeta;
  messages: ChatNoteMessage[];
  trimmed: number;
  extraFrontmatter: string;
  /** Events of the turn in flight, folded into the assistant message at `turn-finished`. */
  pending: AgentEvent[];
};

export function newNoteState(chatId: string, projectPath: string | null, now: number): NoteState {
  return {
    meta: { ...emptyMeta(chatId, now), projectPath },
    messages: [],
    trimmed: 0,
    extraFrontmatter: "",
    pending: [],
  };
}

export function noteStateFromDoc(doc: ChatNoteDoc): NoteState {
  return {
    meta: doc.meta,
    messages: doc.messages,
    trimmed: doc.trimmed,
    extraFrontmatter: doc.extraFrontmatter,
    pending: [],
  };
}

export function recordSend(
  note: NoteState,
  msg: { messageId: string; text: string; context: ContextRef[]; ts: number },
): NoteState {
  const context = contextLine(msg.context);
  const user: ChatNoteMessage = {
    role: "user",
    id: msg.messageId,
    at: msg.ts,
    text: msg.text,
    ...(context ? { context } : {}),
  };
  return { ...note, messages: [...note.messages, user], pending: [] };
}

/** Adds `events` to the turn in flight; a `turn-finished` closes it into an assistant message.
 *  `finished` says whether a note write is due. */
export function recordEvents(
  note: NoteState,
  events: readonly AgentEvent[],
  now: number,
): { note: NoteState; finished: boolean } {
  let next = note;
  let finished = false;
  for (const ev of events) {
    const pending = [...next.pending, ev];
    if (ev.type !== "turn-finished") {
      next = { ...next, pending };
      continue;
    }
    const fold = foldAssistantEvents(pending);
    const lastUser = [...next.messages].reverse().find((m) => m.role === "user");
    const assistant: ChatNoteMessage = {
      role: "assistant",
      id: `${lastUser?.id ?? `m${next.messages.length}`}-a`,
      at: now,
      text: fold.text,
      ...(fold.reason ? { reason: fold.reason } : {}),
      ...(fold.tools.length > 0 ? { tools: fold.tools } : {}),
    };
    const u = next.meta.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    next = {
      ...next,
      pending: [],
      messages: [...next.messages, assistant],
      meta: {
        ...next.meta,
        usage: {
          inputTokens: u.inputTokens + fold.usage.inputTokens,
          outputTokens: u.outputTokens + fold.usage.outputTokens,
          costUsd: u.costUsd + fold.usage.costUsd,
        },
      },
    };
    finished = true;
  }
  return { note: next, finished };
}

/** Drops the last user message and whatever followed it (a send that never reached a session). */
export function dropLastExchange(note: NoteState): NoteState {
  let i = note.messages.length - 1;
  while (i >= 0 && note.messages[i]!.role !== "user") i--;
  return { ...note, messages: i >= 0 ? note.messages.slice(0, i) : note.messages, pending: [] };
}

/** The whole note for `agent_save_chat`. */
export function buildNote(
  chat: Pick<Chat, "chatId" | "title" | "projectPath" | "session" | "resumeSessionId"> &
    Partial<Pick<Chat, "reportedModel">>,
  note: NoteState,
  now: number,
  /** The model the user picked in the composer; wins over what the CLI reported. */
  chosenModel?: string | null,
): { markdown: string; titleHint: string } {
  const firstUser = note.messages.find((m) => m.role === "user");
  const titleHint = titleFromMessage(firstUser?.text ?? chat.title);
  const meta: ChatNoteMeta = {
    ...note.meta,
    title: note.meta.titleRenamed ? note.meta.title : titleHint,
    projectPath: chat.projectPath,
    sessionId: chat.session?.sessionId ?? chat.resumeSessionId ?? note.meta.sessionId,
    cliVersion: chat.session?.cliVersion ?? note.meta.cliVersion,
    model: chosenModel ?? chat.reportedModel ?? chat.session?.model ?? note.meta.model,
    updatedAt: now,
    turns: note.messages.filter((m) => m.role === "user").length,
    preview: firstUser ? previewOf(firstUser.text) : null,
  };
  const doc: ChatNoteDoc = {
    meta,
    messages: note.messages,
    trimmed: note.trimmed,
    extraFrontmatter: note.extraFrontmatter,
  };
  return { markdown: serializeChatNote(doc), titleHint };
}

/** Does a CLI error text mean the session id is unknown to the CLI? Same loose rule as Rust
 *  `chat_store::is_session_missing`. */
export function isSessionMissing(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("no conversation found") ||
    m.includes("conversation not found") ||
    (m.includes("session") && (m.includes("not found") || m.includes("no such"))) ||
    m.includes("could not find session")
  );
}

/** Error texts carried by an event batch (error events and the turn's error list). */
export function eventErrorTexts(events: readonly AgentEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "error") out.push(e.message);
    else if (e.type === "turn-finished" && e.isError) out.push(...e.errors, e.result ?? "");
  }
  return out;
}
