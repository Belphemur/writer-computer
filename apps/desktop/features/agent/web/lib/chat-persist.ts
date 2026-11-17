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
  titleSourceOf,
} from "./chat-note";
import type { Chat } from "./transcript";

export type NoteState = {
  meta: ChatNoteMeta;
  messages: ChatNoteMessage[];
  trimmed: number;
  extraFrontmatter: string;
  /** Events of the turn in flight, folded into the assistant message at `turn-finished`. */
  pending: AgentEvent[];
  /** Steers sent into the turn in flight: they join the note after that turn's assistant message
   *  (the order they read in), when it closes. */
  steers?: ChatNoteMessage[];
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

type SentMessage = { messageId: string; text: string; context: ContextRef[]; ts: number };

function userNoteMessage(msg: SentMessage): ChatNoteMessage {
  const context = contextLine(msg.context);
  const images = msg.context.flatMap((r) => (r.kind === "image" ? [r.path] : []));
  return {
    role: "user",
    id: msg.messageId,
    at: msg.ts,
    text: msg.text,
    ...(context ? { context } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

export function recordSend(note: NoteState, msg: SentMessage): NoteState {
  return { ...note, messages: [...note.messages, userNoteMessage(msg)], pending: [] };
}

/** A message sent into the running turn: a user message marked `steer`, placed after the
 *  assistant message of the turn it cut short (the events in flight close into that one). */
export function recordSteer(note: NoteState, msg: SentMessage): NoteState {
  return { ...note, steers: [...(note.steers ?? []), { ...userNoteMessage(msg), steer: true }] };
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
    if (ev.type === "turn-changes") {
      // arrives right after `turn-finished` closed the assistant message: attach, write again
      const { type: _type, ...changes } = ev;
      const at = next.messages.map((m) => m.role).lastIndexOf("assistant");
      if (at >= 0 && !next.messages[at]!.changes) {
        const messages = next.messages.slice();
        messages[at] = { ...messages[at]!, changes };
        next = { ...next, messages };
        finished = true;
      }
      continue;
    }
    const pending = [...next.pending, ev];
    if (ev.type !== "turn-finished") {
      next = { ...next, pending };
      continue;
    }
    const fold = foldAssistantEvents(pending);
    const lastUser = [...next.messages].reverse().find((m) => m.role === "user");
    // a steer the CLI ran as its own turn gives a second assistant message after the same user
    const base = `${lastUser?.id ?? `m${next.messages.length}`}-a`;
    const taken = next.messages.filter((m) => m.id.startsWith(base)).length;
    const assistant: ChatNoteMessage = {
      role: "assistant",
      id: taken === 0 ? base : `${base}${taken + 1}`,
      at: now,
      text: fold.text,
      ...(fold.reason ? { reason: fold.reason } : {}),
      ...(fold.tools.length > 0 ? { tools: fold.tools } : {}),
    };
    const u = next.meta.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    next = {
      ...next,
      pending: [],
      steers: [],
      messages: [...next.messages, assistant, ...(next.steers ?? [])],
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
    title: titleSourceOf(note.meta) === "none" ? titleHint : note.meta.title,
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
