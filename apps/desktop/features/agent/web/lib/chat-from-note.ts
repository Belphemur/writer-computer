/**
 * A saved chat note as a pane transcript (spec section 9: "the transcript rendered in the pane
 * comes from the note alone"). Tool rows come back collapsed with their input and outcome; tool
 * output is never stored, so it is absent.
 */
import type { ChatNoteDoc, ChatNoteMessage } from "./chat-note";
import { chatFileRef } from "./chat-files";
import type { ChatSummary } from "./events";
import { createChat } from "./reduce";
import type { Chat, SubagentMeta, ToolBlock, Turn, UserMessage } from "./transcript";
import { restoreSessionChanges } from "./session-changes";

function toolBlocks(m: ChatNoteMessage): ToolBlock[] {
  return (m.tools ?? []).map((t) => ({
    kind: "tool",
    id: t.id,
    messageId: m.id,
    tool: t.tool,
    parentToolCallId: t.parent ?? null,
    inputText: "",
    input: t.input,
    hasInput: true,
    status: t.outcome,
    output: null,
    truncated: false,
    permission: null,
    ...(t.ask
      ? {
          question: {
            requestId: null,
            questions: [],
            status: t.ask.status,
            answers: t.ask.answers,
          },
        }
      : {}),
  }));
}

/** The sub-agent runs a note kept (who, which model, how it ended, the report). The time is not
 *  stored; a run the note never saw end is `interrupted`, never done. */
function subagentsOf(m: ChatNoteMessage): Record<string, SubagentMeta> | null {
  const runs = (m.tools ?? []).filter((t) => t.sub);
  if (runs.length === 0) return null;
  return Object.fromEntries(
    runs.map((t) => [
      t.id,
      {
        ...t.sub!,
        status: t.sub!.status ?? "interrupted",
        startedAt: null,
        endedAt: null,
      } satisfies SubagentMeta,
    ]),
  );
}

function userMessage(m: ChatNoteMessage): UserMessage {
  return {
    messageId: m.id,
    text: m.text,
    // the attached files come back as refs (thumbnails, PDF chips); the other attachments only as the label
    context: (m.images ?? []).map(chatFileRef),
    ...(m.context ? { contextLabel: m.context } : {}),
    ts: m.at,
  };
}

export function chatFromNote(doc: ChatNoteDoc, summary: Pick<ChatSummary, "projectPath">): Chat {
  const turns: Turn[] = [];
  const open = (m: ChatNoteMessage | null, at: number): Turn => ({
    id: `turn-${turns.length}`,
    user: m && userMessage(m),
    blocks: [],
    status: "completed",
    startedAt: at,
    finishedAt: at,
    durationMs: null,
    usage: null,
    liveOutputTokens: 0,
    errors: [],
  });
  let current: Turn | null = null;
  // the turn a mid-turn message went into: the assistant message after it goes on in that turn
  let resumed: Turn | null = null;
  for (const [index, m] of doc.messages.entries()) {
    const last = turns[turns.length - 1];
    if (m.role === "user" && m.steer && last) {
      // a steer sits in the timeline of the turn it cut short; its answer is the next turn
      last.blocks.push({ kind: "steer", id: `steer:${m.id}`, message: userMessage(m) });
      current = null;
      continue;
    }
    const before = doc.messages[index - 1];
    if (m.role === "user" && last && before?.role === "assistant" && !before.reason) {
      // a message the CLI injected mid-turn: the assistant part before it did not end the turn
      // (no `reason`), so the message sits in that turn's timeline and the answer goes on there
      last.blocks.push({
        kind: "steer",
        id: `steer:${m.id}`,
        message: userMessage(m),
        injected: true,
      });
      resumed = last;
      continue;
    }
    if (m.role === "user") {
      resumed = null;
      current = open(m, m.at);
      turns.push(current);
      continue;
    }
    if (resumed) {
      current = resumed;
      resumed = null;
    } else if (!current || current.blocks.length > 0) {
      current = open(null, m.at);
      turns.push(current);
    }
    current.blocks.push(...toolBlocks(m));
    const subagents = subagentsOf(m);
    if (subagents) current.subagents = { ...current.subagents, ...subagents };
    if (m.text.trim()) {
      current.blocks.push({
        kind: "text",
        id: `text:${m.id}:0`,
        messageId: m.id,
        blockIndex: 0,
        text: m.text,
        final: true,
      });
    }
    if (m.changes) current.changes = m.changes;
    current.status = m.reason ?? "completed";
    current.finishedAt = m.at;
    // An assistant message closes its turn: the next user message opens a new one.
    current = null;
  }
  const base = createChat(doc.meta.chatId, { projectPath: summary.projectPath });
  return {
    ...base,
    title: doc.meta.title,
    turns,
    resumeSessionId: doc.meta.sessionId ?? doc.meta.chatId,
    totalCostUsd: doc.meta.usage?.costUsd ?? 0,
    ...(doc.sessionChanges ? { sessionChanges: restoreSessionChanges(doc.sessionChanges) } : {}),
  };
}
