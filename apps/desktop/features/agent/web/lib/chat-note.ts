/**
 * The chat note format: serialise a chat to markdown and parse it back. Rust owns the files
 * (`src-tauri/src/agent/chat_store.rs`) and reads the same format; both sides are pinned by the
 * golden notes in `tests/fixtures/agent-chat-notes/`. Spec: `SPECs/native-agent-spec.md`
 * section 9.
 *
 * Pure: no IO, no Tauri. Notes hold text the user sent and the agent answered, a one-line list of
 * attached paths per message and a capped tool trail; never tool output or note contents.
 */
import { parse as parseYaml } from "yaml";
import { embedLine } from "@/lib/attachments";
import type {
  AgentEvent,
  ContextRef,
  TitleSource,
  ToolOutcome,
  FileChangeSummary,
  TurnChangesSummary,
  TurnFinishReason,
} from "./events";

export const ESCAPE = "\u200B";
export const MAX_TOOL_INPUT_CHARS = 500;
/** A sub-agent's final answer kept in the note, so a reopened chat shows the card's summary. */
export const MAX_SUBAGENT_SUMMARY_CHARS = 500;
export const DEFAULT_REPLAY_TOKENS = 8000;

export type ChatNoteUsage = { inputTokens: number; outputTokens: number; costUsd: number };

/** Frontmatter, in the wire names of the golden `*.parsed.json` files. */
export type ChatNoteMeta = {
  chatId: string;
  title: string;
  /** True once the user renamed the chat: saves then keep the title. */
  titleRenamed: boolean;
  /** True once an automatic title was applied: saves then keep it too. See `titleSourceOf`. */
  titleAuto: boolean;
  backend: string | null;
  sessionId: string | null;
  /** Project name or id, for humans. */
  project: string | null;
  /** Vault-relative project folder; null for a vault-root chat. Decides where the note lives. */
  projectPath: string | null;
  cliVersion: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  turns: number;
  pinned: boolean;
  archivedAt: number | null;
  usage: ChatNoteUsage | null;
  /** First user message on one line, for history search. */
  preview: string | null;
};

export type ChatNoteTool = {
  id: string;
  tool: string;
  /** The input when its JSON is at most 500 chars, else a truncated string. */
  input: unknown;
  outcome: ToolOutcome;
  /** The launch call of the sub-agent run that made this call (absent: the main agent). A note
   *  without it still opens: the rows are then listed flat. */
  parent?: string;
  /** On a launch call: who ran and its closing answer. Absent on notes written before cards. */
  sub?: ChatNoteSubagent;
};

export type ChatNoteSubagent = {
  /** The registry role id; null for a type Writer does not define. */
  role: string | null;
  /** The sub-agent type as the call named it. */
  name: string;
  model: string | null;
  /** How the run ended, as the backend reported it; absent: it never reported (a reopened chat
   *  shows it as interrupted, never done). */
  status?: "completed" | "failed" | "stopped";
  /** The run's final report, cut to 500 characters. */
  summary?: string;
};

/** Records a `subagent-status` on a note's sub-agent run: a final state once, then its report once.
 *  The one place that decides what the note keeps of a run's end. */
export function applySubagentStatus(
  sub: ChatNoteSubagent,
  ev: Extract<AgentEvent, { type: "subagent-status" }>,
): boolean {
  let changed = false;
  if (
    !sub.status &&
    (ev.status === "completed" || ev.status === "failed" || ev.status === "stopped")
  ) {
    sub.status = ev.status;
    changed = true;
  }
  if (ev.report && !sub.summary) {
    sub.summary = ev.report.slice(0, MAX_SUBAGENT_SUMMARY_CHARS);
    changed = true;
  }
  return changed;
}

export type ChatNoteMessage = {
  role: "user" | "assistant";
  id: string;
  /** Epoch ms. */
  at: number;
  /** How the turn ended (assistant only). */
  reason?: TurnFinishReason;
  text: string;
  /** What the user attached (paths and tags, never contents). */
  context?: string;
  /** Vault-relative paths of the images attached to a user message; written as `![[...]]` lines
   *  after the message comment (and listed in it), so a reopened chat shows them. */
  images?: string[];
  /** A user message sent into the running turn (a steer): `"steer":true` in its comment. Notes
   *  without the mark read as a plain message; an older Writer ignores the key. */
  steer?: boolean;
  tools?: ChatNoteTool[];
  /** The "Changes" card's summary (assistant only): paths and counts, never contents. */
  changes?: TurnChangesSummary;
};

export type ChatNoteDoc = {
  meta: ChatNoteMeta;
  messages: ChatNoteMessage[];
  /** Messages dropped by the size bound. */
  trimmed: number;
  /** The notes the chat changed (paths and counts, never text): `writer:session-changes`, before
   *  the first message. */
  sessionChanges?: FileChangeSummary[];
  /** Raw frontmatter blocks the user added; written back verbatim. */
  extraFrontmatter: string;
};

export const emptyMeta = (chatId: string, now: number): ChatNoteMeta => ({
  chatId,
  title: "New chat",
  titleRenamed: false,
  titleAuto: false,
  backend: "claude",
  sessionId: chatId,
  project: null,
  projectPath: null,
  cliVersion: null,
  model: null,
  createdAt: now,
  updatedAt: now,
  turns: 0,
  pinned: false,
  archivedAt: null,
  usage: null,
  preview: null,
});

// ---------------------------------------------------------------------------------------------
// Escaping

const STRUCTURAL = /^(## user ·|## assistant ·|> context:|<!-- writer:)/;

/** Prefix every line that would read as note structure with a zero-width space. */
export function escapeText(text: string): string {
  return text
    .split("\n")
    .map((l) => (STRUCTURAL.test(l.replace(/^\u200B+/, "")) ? ESCAPE + l : l))
    .join("\n");
}

export function unescapeLine(line: string): string {
  return line.startsWith(ESCAPE) && STRUCTURAL.test(line.replace(/^\u200B+/, ""))
    ? line.slice(1)
    : line;
}

/** Message text as stored: LF endings, no leading or trailing blank lines. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

// ---------------------------------------------------------------------------------------------
// Frontmatter

const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9 ._/()-]*$/;
const NUMBERISH = /^[-+.]?\d[\d_.eE+:-]*$/;

function scalar(s: string): string {
  if (PLAIN.test(s) && !RESERVED.test(s) && !NUMBERISH.test(s) && !s.endsWith(" ")) return s;
  return JSON.stringify(s);
}

function fmLines(meta: ChatNoteMeta): string[] {
  const out: string[] = [];
  const str = (k: string, v: string | null) =>
    v !== null && v !== "" && out.push(`${k}: ${scalar(v)}`);
  str("writer-chat-id", meta.chatId);
  str("writer-chat-title", meta.title);
  if (meta.titleRenamed) out.push("writer-chat-renamed: true");
  if (meta.titleAuto) out.push("writer-chat-title-auto: true");
  str("writer-chat-backend", meta.backend);
  str("writer-chat-session-id", meta.sessionId);
  str("writer-chat-project", meta.project);
  str("writer-chat-project-path", meta.projectPath);
  str("writer-chat-cli-version", meta.cliVersion);
  str("writer-chat-model", meta.model);
  out.push(`writer-chat-created: ${meta.createdAt}`);
  out.push(`writer-chat-updated: ${meta.updatedAt}`);
  out.push(`writer-chat-turns: ${meta.turns}`);
  out.push(`writer-chat-pinned: ${meta.pinned}`);
  if (meta.archivedAt !== null) out.push(`writer-chat-archived-at: ${meta.archivedAt}`);
  if (meta.usage) {
    out.push("writer-chat-usage:");
    out.push(`  inputTokens: ${meta.usage.inputTokens}`);
    out.push(`  outputTokens: ${meta.usage.outputTokens}`);
    out.push(`  costUsd: ${meta.usage.costUsd}`);
  }
  str("writer-chat-preview", meta.preview);
  return out;
}

/** Split frontmatter text into top-level `key` blocks (the key and its continuation lines). */
function splitBlocks(fm: string): { key: string; raw: string }[] {
  const blocks: { key: string; raw: string }[] = [];
  for (const line of fm.split("\n")) {
    const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:-][^:]*?)\s*:(?:\s|$)/.exec(line);
    if (m) blocks.push({ key: m[1].replace(/^["']|["']$/g, ""), raw: line });
    else if (blocks.length > 0) blocks[blocks.length - 1].raw += `\n${line}`;
  }
  return blocks;
}

const isOurs = (key: string) => key.startsWith("writer-chat-");

// ---------------------------------------------------------------------------------------------
// Time

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:mm`, UTC (deterministic across machines; the exact time is in `writer:msg`). */
export function headerTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function parseHeaderTime(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : 0;
}

// ---------------------------------------------------------------------------------------------
// Serialise

/** JSON that is safe inside an HTML comment: `<` and `>` become unicode escapes. */
function commentJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

export function capToolInput(input: unknown): unknown {
  const json = JSON.stringify(input);
  if (json === undefined || json.length <= MAX_TOOL_INPUT_CHARS) return input;
  return `${json.slice(0, MAX_TOOL_INPUT_CHARS - 1)}…`;
}

function serializeMessage(m: ChatNoteMessage): string {
  const msg: Record<string, unknown> = { id: m.id, at: m.at };
  if (m.reason) msg.reason = m.reason;
  if (m.steer) msg.steer = true;
  const images = m.images ?? [];
  if (images.length > 0) msg.images = images;
  const blocks = [`## ${m.role} · ${headerTime(m.at)}\n<!-- writer:msg ${commentJson(msg)} -->`];
  if (images.length > 0) blocks.push(images.map((p) => embedLine(p, "")).join("\n"));
  const text = normalizeText(m.text);
  if (text) blocks.push(escapeText(text));
  if (m.context) blocks.push(`> context: ${m.context.replace(/\s+/g, " ").trim()}`);
  if (m.tools && m.tools.length > 0) blocks.push(`<!-- writer:tools ${commentJson(m.tools)} -->`);
  // always the last comment of a message (the Rust parser reads it first)
  if (m.changes && m.changes.files.length > 0)
    blocks.push(`<!-- writer:changes ${commentJson(m.changes)} -->`);
  return blocks.join("\n\n");
}

export function serializeChatNote(doc: ChatNoteDoc): string {
  const lines = fmLines(doc.meta);
  if (doc.extraFrontmatter) lines.push(doc.extraFrontmatter.replace(/\n+$/, ""));
  const parts: string[] = [];
  if (doc.trimmed > 0)
    parts.push(`<!-- writer:trimmed ${commentJson({ messages: doc.trimmed })} -->`);
  if (doc.sessionChanges && doc.sessionChanges.length > 0)
    parts.push(`<!-- writer:session-changes ${commentJson({ files: doc.sessionChanges })} -->`);
  for (const m of doc.messages) parts.push(serializeMessage(m));
  const head = `---\n${lines.join("\n")}\n---\n`;
  return parts.length > 0 ? `${head}\n${parts.join("\n\n")}\n` : head;
}

// ---------------------------------------------------------------------------------------------
// Parse

const FM_RE = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number") return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v);
  return null;
}

export class ChatNoteError extends Error {}

function parseMeta(fm: Record<string, unknown>): ChatNoteMeta {
  const chatId = str(fm["writer-chat-id"]);
  if (!chatId) throw new ChatNoteError("not a chat note (no writer-chat-id)");
  const u = fm["writer-chat-usage"];
  const usage =
    u && typeof u === "object" && !Array.isArray(u) && Object.keys(u).length > 0
      ? {
          inputTokens: num((u as Record<string, unknown>).inputTokens) ?? 0,
          outputTokens: num((u as Record<string, unknown>).outputTokens) ?? 0,
          costUsd: Number((u as Record<string, unknown>).costUsd) || 0,
        }
      : null;
  const bool = (v: unknown) => v === true || (typeof v === "string" && v.toLowerCase() === "true");
  return {
    chatId,
    title: str(fm["writer-chat-title"]) ?? "New chat",
    titleRenamed: bool(fm["writer-chat-renamed"]),
    titleAuto: bool(fm["writer-chat-title-auto"]),
    backend: str(fm["writer-chat-backend"]),
    sessionId: str(fm["writer-chat-session-id"]),
    project: str(fm["writer-chat-project"]),
    projectPath: str(fm["writer-chat-project-path"]),
    cliVersion: str(fm["writer-chat-cli-version"]),
    model: str(fm["writer-chat-model"]),
    createdAt: num(fm["writer-chat-created"]) ?? 0,
    updatedAt: num(fm["writer-chat-updated"]) ?? 0,
    turns: Math.max(0, num(fm["writer-chat-turns"]) ?? 0),
    pinned: bool(fm["writer-chat-pinned"]),
    archivedAt: num(fm["writer-chat-archived-at"]),
    usage,
    preview: str(fm["writer-chat-preview"]),
  };
}

function payload(line: string, name: string): string | null {
  const prefix = `<!-- writer:${name} `;
  if (!line.startsWith(prefix)) return null;
  const rest = line.trimEnd();
  return rest.endsWith("-->") ? rest.slice(prefix.length, -3).trim() : null;
}

function jsonOr<T>(s: string | null): T | null {
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function trimEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b);
}

function parseSection(index: number, role: "user" | "assistant", when: string, raw: string[]) {
  let rest = trimEdges(raw);
  let id = `m${index + 1}`;
  let at = parseHeaderTime(when);
  let reason: TurnFinishReason | undefined;
  let images: string[] | undefined;
  let steer = false;
  const msg = rest.length > 0 ? jsonOr<Record<string, unknown>>(payload(rest[0], "msg")) : null;
  if (rest.length > 0 && payload(rest[0], "msg") !== null) {
    if (msg) {
      if (typeof msg.id === "string") id = msg.id;
      if (typeof msg.at === "number") at = msg.at;
      if (typeof msg.reason === "string") reason = msg.reason as TurnFinishReason;
      steer = msg.steer === true;
      if (Array.isArray(msg.images)) {
        const paths = msg.images.filter((p): p is string => typeof p === "string");
        if (paths.length > 0) images = paths;
      }
    }
    rest = trimEdges(rest.slice(1));
    // one embed line per image comes first; the message comment lists the paths (authoritative)
    if (images) {
      let embeds = 0;
      while (embeds < images.length && rest[embeds]?.startsWith("![")) embeds++;
      rest = trimEdges(rest.slice(embeds));
    }
  }
  let changes: TurnChangesSummary | undefined;
  if (rest.length > 0) {
    const p = payload(rest[rest.length - 1], "changes");
    if (p !== null) {
      changes = jsonOr<TurnChangesSummary>(p) ?? undefined;
      rest = trimEdges(rest.slice(0, -1));
    }
  }
  let tools: ChatNoteTool[] | undefined;
  if (rest.length > 0) {
    const p = payload(rest[rest.length - 1], "tools");
    if (p !== null) {
      tools = jsonOr<ChatNoteTool[]>(p) ?? undefined;
      rest = trimEdges(rest.slice(0, -1));
    }
  }
  let context: string | undefined;
  if (rest.length > 0 && rest[rest.length - 1].startsWith("> context: ")) {
    context = rest[rest.length - 1].slice("> context: ".length).trim();
    rest = trimEdges(rest.slice(0, -1));
  }
  const message: ChatNoteMessage = { role, id, at, text: rest.map(unescapeLine).join("\n") };
  if (reason) message.reason = reason;
  if (context !== undefined) message.context = context;
  if (images) message.images = images;
  if (steer) message.steer = true;
  if (tools) message.tools = tools;
  if (changes && Array.isArray(changes.files)) message.changes = changes;
  return message;
}

export function parseBody(body: string): {
  trimmed: number;
  sessionChanges?: FileChangeSummary[];
  messages: ChatNoteMessage[];
} {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let trimmed = 0;
  let sessionChanges: FileChangeSummary[] | undefined;
  const sections: { role: "user" | "assistant"; when: string; lines: string[] }[] = [];
  for (const line of lines) {
    const h = /^## (user|assistant) ·(.*)$/.exec(line);
    if (h) {
      sections.push({ role: h[1] as "user" | "assistant", when: h[2].trim(), lines: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
    } else {
      const t = jsonOr<{ messages?: number }>(payload(line, "trimmed"));
      if (t && typeof t.messages === "number") trimmed = t.messages;
      const c = jsonOr<{ files?: unknown }>(payload(line, "session-changes"));
      if (c && Array.isArray(c.files)) sessionChanges = c.files as FileChangeSummary[];
    }
  }
  return {
    trimmed,
    ...(sessionChanges ? { sessionChanges } : {}),
    messages: sections.map((s, i) => parseSection(i, s.role, s.when, s.lines)),
  };
}

export function parseChatNote(text: string): ChatNoteDoc {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = FM_RE.exec(normalized);
  if (!m) throw new ChatNoteError("a chat note needs frontmatter");
  let fm: unknown;
  try {
    fm = parseYaml(m[1]);
  } catch (e) {
    throw new ChatNoteError(`frontmatter is not valid YAML: ${String(e)}`);
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
    throw new ChatNoteError("frontmatter is not a mapping");
  }
  const meta = parseMeta(fm as Record<string, unknown>);
  const extra = splitBlocks(m[1])
    .filter((b) => !isOurs(b.key))
    .map((b) => b.raw)
    .join("\n");
  const { trimmed, sessionChanges, messages } = parseBody(normalized.slice(m[0].length));
  return {
    meta,
    messages,
    trimmed,
    ...(sessionChanges ? { sessionChanges } : {}),
    extraFrontmatter: extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Building messages

/** One line for the note's `> context:` quote: what was attached, never contents. */
export function contextLine(refs: readonly ContextRef[]): string {
  const items: string[] = [];
  let sources = 0;
  const link = (p: string) => `[[${p.replace(/\.md$/i, "")}]]`;
  for (const r of refs) {
    switch (r.kind) {
      case "active-note":
      case "note":
        items.push(link(r.path));
        break;
      case "selection":
        items.push(`selection of ${link(r.path)} (lines ${r.fromLine}-${r.toLine})`);
        break;
      case "folder":
        items.push(`${r.path}/`);
        break;
      case "tag":
        items.push(r.tag.startsWith("#") ? r.tag : `#${r.tag}`);
        break;
      case "property":
        items.push(r.value === null ? `property ${r.name}` : `${r.name}: ${r.value}`);
        break;
      case "image": // shown as thumbnails (the message's images), not named here
      case "project-instructions":
        break;
      case "project-source":
        sources++;
        break;
    }
  }
  if (sources > 0) items.push(`project sources (${sources})`);
  return items.join(", ");
}

export function previewOf(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 159)}…` : one;
}

/** Who chose the title (twin of Rust `ChatMeta::title_source`): a rename always wins. */
export function titleSourceOf(meta: Pick<ChatNoteMeta, "titleRenamed" | "titleAuto">): TitleSource {
  return meta.titleRenamed ? "user" : meta.titleAuto ? "auto" : "none";
}

/** Default title: the first user message cut to 60 characters (spec section 9). */
export function titleFromMessage(text: string): string {
  const one = previewOf(text);
  return one.length > 60 ? `${one.slice(0, 59).trimEnd()}…` : one || "New chat";
}

export type AssistantFold = {
  text: string;
  tools: ChatNoteTool[];
  reason: TurnFinishReason | undefined;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
};

/** Fold the events of one turn into the assistant message of the note: the final text of each
 *  block (a `text` event replaces its deltas), the tool trail and how the turn ended. */
export function foldAssistantEvents(events: readonly AgentEvent[]): AssistantFold {
  const blocks = new Map<string, string>();
  const tools = new Map<string, ChatNoteTool>();
  // messages a sub-agent made: its text belongs to its run, not to the assistant's answer
  const subMessages = new Set<string>();
  let reason: TurnFinishReason | undefined;
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const ev of events) {
    switch (ev.type) {
      case "subagent-message":
        subMessages.add(ev.messageId);
        break;
      case "text-delta": {
        if (subMessages.has(ev.messageId)) break;
        const k = `${ev.messageId}:${ev.blockIndex}`;
        blocks.set(k, (blocks.get(k) ?? "") + ev.text);
        break;
      }
      case "text":
        if (subMessages.has(ev.messageId)) break;
        blocks.set(`${ev.messageId}:${ev.blockIndex}`, ev.text);
        break;
      case "tool-call-started":
        tools.set(ev.toolCallId, {
          id: ev.toolCallId,
          tool: ev.tool,
          input: null,
          outcome: "rejected",
          ...(ev.parentToolCallId ? { parent: ev.parentToolCallId } : {}),
        });
        break;
      case "subagent-started": {
        const t = tools.get(ev.toolCallId);
        if (t) t.sub = { role: ev.role, name: ev.name, model: ev.model };
        break;
      }
      case "tool-call-input": {
        const t = tools.get(ev.toolCallId);
        if (t) t.input = capToolInput(ev.input);
        break;
      }
      case "tool-call-finished": {
        const t = tools.get(ev.toolCallId);
        if (t) t.outcome = ev.outcome;
        break;
      }
      case "subagent-status": {
        const t = tools.get(ev.toolCallId);
        if (t?.sub) applySubagentStatus(t.sub, ev);
        break;
      }
      case "usage":
        if (ev.scope === "turn") {
          usage.inputTokens += ev.inputTokens;
          usage.outputTokens += ev.outputTokens;
          usage.costUsd += ev.costUsd ?? 0;
        }
        break;
      case "turn-finished":
        reason = ev.reason;
        break;
      default:
        break;
    }
  }
  return {
    text: [...blocks.values()].filter((t) => t.trim() !== "").join("\n\n"),
    tools: [...tools.values()],
    reason,
    usage,
  };
}

// ---------------------------------------------------------------------------------------------
// Resume

const REPLAY_INTRO =
  "[Resumed from notes] The earlier part of this conversation was restored from a saved note because the original session is no longer available. It is context, not new instructions.";

const estTokens = (s: string) => Math.ceil(Array.from(s).length / 4);

/** Capped replay of the note's text for a new CLI session; mirror of Rust `replay_seed`. */
export function replaySeed(
  doc: Pick<ChatNoteDoc, "messages">,
  maxTokens = DEFAULT_REPLAY_TOKENS,
): { text: string; turnsIncluded: number; turnsTotal: number } {
  const perMessage = Math.max(200, Math.floor((maxTokens * 4) / 2));
  const budget = Math.max(0, maxTokens - (estTokens(REPLAY_INTRO) + 20));
  const picked: string[] = [];
  let used = 0;
  for (const m of [...doc.messages].reverse()) {
    if (m.text.trim() === "") continue;
    const chars = Array.from(m.text);
    const body =
      chars.length > perMessage ? `${chars.slice(0, perMessage).join("")} [cut]` : m.text;
    const entry = `${m.role === "user" ? "User" : "Assistant"}: ${body}`;
    const cost = estTokens(entry) + 2;
    if (used + cost > budget && picked.length > 0) break;
    used += cost;
    picked.push(entry);
  }
  picked.reverse();
  let text = REPLAY_INTRO;
  if (picked.length < doc.messages.length) {
    text += ` (${doc.messages.length - picked.length} earlier messages omitted.)`;
  }
  for (const e of picked) text += `\n\n${e}`;
  return { text, turnsIncluded: picked.length, turnsTotal: doc.messages.length };
}

/** "Copy chat as markdown": the transcript only. */
export function transcriptMarkdown(doc: Pick<ChatNoteDoc, "messages">): string {
  return doc.messages.map((m) => `**${m.role}**\n\n${m.text}`).join("\n\n");
}
