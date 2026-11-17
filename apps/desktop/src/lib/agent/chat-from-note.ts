/**
 * A saved chat note as a pane transcript (spec section 9: "the transcript rendered in the pane
 * comes from the note alone"). Tool rows come back collapsed with their input and outcome; tool
 * output is never stored, so it is absent.
 */
import type { ChatNoteDoc, ChatNoteMessage } from "./chat-note";
import type { ChatSummary } from "./events";
import { createChat } from "./reduce";
import type { Chat, ToolBlock, Turn } from "./transcript";

function toolBlocks(m: ChatNoteMessage): ToolBlock[] {
  return (m.tools ?? []).map((t) => ({
    kind: "tool",
    id: t.id,
    messageId: m.id,
    tool: t.tool,
    parentToolCallId: null,
    inputText: "",
    input: t.input,
    hasInput: true,
    status: t.outcome,
    output: null,
    truncated: false,
    permission: null,
  }));
}

export function chatFromNote(doc: ChatNoteDoc, summary: Pick<ChatSummary, "projectPath">): Chat {
  const turns: Turn[] = [];
  const open = (m: ChatNoteMessage | null, at: number): Turn => ({
    id: `turn-${turns.length}`,
    user: m && {
      messageId: m.id,
      text: m.text,
      context: [],
      ...(m.context ? { contextLabel: m.context } : {}),
      ts: m.at,
    },
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
  for (const m of doc.messages) {
    if (m.role === "user") {
      current = open(m, m.at);
      turns.push(current);
      continue;
    }
    if (!current || current.blocks.length > 0) {
      current = open(null, m.at);
      turns.push(current);
    }
    current.blocks.push(...toolBlocks(m));
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
  };
}
