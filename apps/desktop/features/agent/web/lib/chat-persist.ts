/**
 * The pane's side of chat persistence (spec section 9): what the note holds, kept next to the
 * transcript and folded from the same events. Pure: the store owns the state, `chat-saver.ts` owns
 * the debounced writes, `chat-note.ts` (lane 4) owns the format.
 */
import { chatIdIsSession, DEFAULT_BACKEND_ID } from "./backends";
import { isChatFileRef } from "./chat-files";
import type { AgentEvent, ContextRef } from "./events";
import {
  foldSessionChanges,
  restoreSessionChanges,
  sessionChangesFiles,
  type SessionChangesState,
} from "./session-changes";
import {
  type ChatNoteDoc,
  type ChatNoteMessage,
  type ChatNoteMeta,
  applySubagentEvent,
  callsOfRun,
  contextLine,
  emptyMeta,
  foldAssistantEvents,
  previewOf,
  serializeChatNote,
  titleFromMessage,
  titleSourceOf,
} from "./chat-note";
import type { LineLookup } from "./reduce";
import type { Chat } from "./transcript";

export type NoteState = {
  meta: ChatNoteMeta;
  messages: ChatNoteMessage[];
  trimmed: number;
  extraFrontmatter: string;
  /** The notes the chat changed (paths and counts), written before the first message. */
  sessionChanges?: SessionChangesState;
  /** Events of the turn in flight, folded into the assistant message at `turn-finished`. */
  pending: AgentEvent[];
  /** Steers sent into the turn in flight: they join the note after that turn's assistant message
   *  (the order they read in), when it closes. */
  steers?: ChatNoteMessage[];
};

export function newNoteState(
  chatId: string,
  projectPath: string | null,
  now: number,
  backendId: string = DEFAULT_BACKEND_ID,
): NoteState {
  return {
    meta: {
      ...emptyMeta(chatId, now, { id: backendId, chatIdIsSession: chatIdIsSession(backendId) }),
      projectPath,
    },
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
    ...(doc.sessionChanges ? { sessionChanges: restoreSessionChanges(doc.sessionChanges) } : {}),
    pending: [],
  };
}

type SentMessage = { messageId: string; text: string; context: ContextRef[]; ts: number };

function userNoteMessage(msg: SentMessage): ChatNoteMessage {
  const context = contextLine(msg.context);
  // the note's `images` list holds every attached file (images and PDFs); the extension tells them apart
  const images = msg.context.flatMap((r) => (isChatFileRef(r) ? [r.path] : []));
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

/** The turn in flight (its pending events) closed into an assistant message of the note, with
 *  its usage counted. A part with nothing to say (no text, no tool) is not written. */
function closeAssistant(note: NoteState, now: number): NoteState {
  const fold = foldAssistantEvents(note.pending, note.messages);
  const lastUser = [...note.messages].reverse().find((m) => m.role === "user");
  // a steer the CLI ran as its own turn, or a message injected mid-turn, gives another
  // assistant message after the same user message
  const base = `${lastUser?.id ?? `m${note.messages.length}`}-a`;
  const taken = note.messages.filter((m) => m.id.startsWith(base)).length;
  const assistant: ChatNoteMessage = {
    role: "assistant",
    id: taken === 0 ? base : `${base}${taken + 1}`,
    at: now,
    text: fold.text,
    ...(fold.reason ? { reason: fold.reason } : {}),
    ...(fold.tools.length > 0 ? { tools: fold.tools } : {}),
  };
  const u = note.meta.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  return {
    ...note,
    pending: [],
    messages:
      fold.text || fold.tools.length > 0 || fold.reason
        ? [...note.messages, assistant]
        : note.messages,
    meta: {
      ...note.meta,
      usage: {
        inputTokens: u.inputTokens + fold.usage.inputTokens,
        outputTokens: u.outputTokens + fold.usage.outputTokens,
        costUsd: u.costUsd + fold.usage.costUsd,
      },
    },
  };
}

/** A message the CLI took while a turn ran (`message-received`): the turn in flight is closed
 *  into an assistant message (no `reason`: it goes on after the message) and the user message
 *  follows it, where it landed. After a turn that already ended it is simply the next user message. */
export function recordReceived(note: NoteState, msg: SentMessage, now: number): NoteState {
  const closed = note.pending.length > 0 ? closeAssistant(note, now) : note;
  return { ...closed, messages: [...closed.messages, userNoteMessage(msg)] };
}

/** Adds `events` to the turn in flight; a `turn-finished` closes it into an assistant message.
 *  `finished` says whether a note write is due. `lines` finds the message a receipt names. */
export function recordEvents(
  note: NoteState,
  events: readonly AgentEvent[],
  now: number,
  lines?: LineLookup,
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
    if (ev.type === "session-changes") {
      // not part of a message: the list the note keeps before the first one. A write is due
      // only between turns (the turn's own end writes the note when one is in flight)
      next = { ...next, sessionChanges: foldSessionChanges(next.sessionChanges, ev) };
      if (next.pending.length === 0) finished = true;
      continue;
    }
    if (ev.type === "message-received") {
      const line = lines?.(ev.messageId);
      // not a note write by itself: the turn's own end (or the store's save) writes it
      if (line) next = recordReceived(next, { messageId: ev.messageId, ...line, ts: now }, now);
      continue;
    }
    if (ev.type === "subagent-status" || ev.type === "subagent-model") {
      // a background run that ends after its turn was written: its message is updated in place
      const late = lateSubagent(next.messages, ev.toolCallId);
      if (late) {
        const inFlight = foldAssistantEvents(next.pending, next.messages).tools;
        if (applySubagentEvent(late.sub, ev, callsOfRun(next.messages, inFlight, ev.toolCallId))) {
          const messages = next.messages.slice();
          messages[late.at] = late.message;
          next = { ...next, messages };
          finished = true;
        }
        continue;
      }
    }
    const pending = [...next.pending, ev];
    if (ev.type !== "turn-finished") {
      next = { ...next, pending };
      continue;
    }
    const closed = closeAssistant({ ...next, pending }, now);
    // steers the turn cut short read after its assistant message
    next = { ...closed, steers: [], messages: [...closed.messages, ...(next.steers ?? [])] };
    finished = true;
  }
  return { note: next, finished };
}

/** The note's assistant message holding the sub-agent run launched by `callId` (a copy to edit). */
function lateSubagent(messages: readonly ChatNoteMessage[], callId: string) {
  for (let at = messages.length - 1; at >= 0; at--) {
    const m = messages[at]!;
    const i = m.tools?.findIndex((t) => t.id === callId && t.sub) ?? -1;
    if (i < 0) continue;
    const sub = { ...m.tools![i]!.sub! };
    const tools = m.tools!.slice();
    tools[i] = { ...tools[i]!, sub };
    return { at, message: { ...m, tools }, sub };
  }
  return null;
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
    Partial<Pick<Chat, "reportedModel" | "backendId">>,
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
    backend: chat.backendId ?? note.meta.backend,
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
    sessionChanges: note.sessionChanges ? sessionChangesFiles(note.sessionChanges) : undefined,
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
