import { reportedMatches } from "@features/agent/web/lib/model-label";
import { RELOAD_NOT_STARTED_TEXT, reloadNoticeFor } from "@features/agent/web/lib/session-reload";
import { parseWriterCommand } from "@features/agent/web/lib/writer-commands";
import { create } from "zustand";
import { getPreference, setPreference } from "@/lib/preferences";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";
import {
  createEventPump,
  createTauriAgentClient,
  type AgentClient,
  type EventPump,
  type Unsubscribe,
} from "@features/agent/web/lib/client";
import { claudeTierSettingKey } from "@features/agent/web/lib/agent-roles";
import { agentSettingsFrom, type ChatModelChoice } from "@features/agent/web/lib/agent-settings";
import type {
  AgentBinaryInfo,
  AgentEvent,
  AgentErrorKind,
  AgentPermissionMode,
  ChatId,
  ChatSummary,
  ContextRef,
  DiskSkill,
  PermissionPersist,
  QuestionAnswer,
} from "@features/agent/web/lib/events";
import {
  appendSteer,
  appendUserTurn,
  canSteer,
  createChat,
  failSend,
  isBusy,
  isComposerDisabled,
  markCancelling,
  reduceEvents,
} from "@features/agent/web/lib/reduce";
import type { Chat } from "@features/agent/web/lib/transcript";
import {
  buildNote,
  dropLastExchange,
  eventErrorTexts,
  isSessionMissing,
  newNoteState,
  noteStateFromDoc,
  recordEvents,
  recordSend,
  recordSteer,
  type NoteState,
} from "@features/agent/web/lib/chat-persist";
import {
  applyTitleSummary,
  shouldAutoTitle,
  type RegenerateOutcome,
} from "@features/agent/web/lib/auto-title";
import { buildPrompt, relativeToCwd } from "@features/agent/web/lib/context-text";
import { mentionsActiveNote } from "@features/agent/web/lib/mentions";
import { openTabsBlock, openTabsFrom, type OpenTab } from "@features/agent/web/lib/open-tabs";
import { propertyTypeInfo } from "@/stores/property-types-store";
import { reconcileRefs } from "@features/agent/web/lib/draft-refs";
import { createRefIo, prepareRefs, type RefIo } from "@features/agent/web/lib/ref-resolve";
import { chatFromNote } from "@features/agent/web/lib/chat-from-note";
import { parseChatNote } from "@features/agent/web/lib/chat-note";
import { hideSessionChanges } from "@features/agent/web/lib/session-changes";
import { createChatSaver, type ChatSaver } from "@features/agent/web/lib/chat-saver";
import {
  chatHistoryClient,
  type ChatHistoryClient,
} from "@features/agent/web/lib/chat-history-client";
import { reloadChatNoteIfOpen } from "@features/agent/web/lib/chat-editor-sync";
import { logger } from "@/lib/logger";
import { loadAgentChats, saveAgentChats, type AgentChatsSession } from "@/lib/session";
import { useEditorStore } from "@/stores/editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { usePaneStore } from "@features/agent/web/stores/pane-store";
import type { FeatureContext } from "@/lib/features/types";
import {
  attachAgentStoreForTests,
  registerAgentStore,
} from "@features/agent/web/lib/store-lifecycle";

/** Skills on disk per project (`""` = the vault root): what the `/` menu lists before and next to the CLI's own list. */
export type SkillsEntry = {
  status: "loading" | "ready" | "error";
  items: DiskSkill[];
  error: string | null;
};
export const skillsKey = (projectPath: string | null) => projectPath ?? "";

export type AgentView = "chat" | "history" | "projects" | "project";
export type AgentBackend = "tauri" | "mock";

/** What the user typed and attached but has not sent; kept per chat so tab switches lose nothing. */
export type Draft = {
  text: string;
  /** Explicit `@` mentions shown as chips. */
  mentions: ContextRef[];
  /** False once the user removed the active-note chip for this chat. */
  activeNote: boolean;
  /** Refs whose last token left the text (`draft-refs.ts`); undo or a paste brings them back. */
  parked?: ContextRef[];
};

/** The message waiting behind the running turn (the "Queued" chip, one merged message). `id` null:
 *  held in Writer until the chat is idle. Otherwise it was written to the CLI under that id (the
 *  receipt id of `message-received`) and waits there for the next tool call, or for the end of
 *  the turn. */
export type QueuedMessage = {
  text: string;
  context: ContextRef[];
  id: string | null;
  /** The part of `text` (the end of it) not written to the CLI yet: a later Enter shows at once
   *  and is merged into the written line by `reconcileLine`. Absent: `text` is what the CLI has. */
  tail?: PendingText;
};

/** Text (and its context) the user sent that is not written to the CLI yet. */
type PendingText = { text: string; context: ContextRef[] };

/** A message written to the CLI that it has not echoed yet: what the receipt turns into a card. */
export type WrittenLine = { chatId: ChatId; text: string; context: ContextRef[] };

const EMPTY_DRAFT: Draft = { text: "", mentions: [], activeNote: true };

interface AgentState {
  chats: Record<ChatId, Chat>;
  /** Tab order. */
  order: ChatId[];
  activeChatId: ChatId | null;
  drafts: Record<ChatId, Draft>;
  queued: Record<ChatId, QueuedMessage>;
  /** Every message written to the CLI and not echoed yet, by message id: the chip shows the
   *  latest, but one the CLI took while it was being merged still needs its text for its card. */
  written: Record<string, WrittenLine>;
  /** Per-chat permission mode chosen in the composer; the setting is the default. */
  modes: Record<ChatId, AgentPermissionMode>;
  /** Per-chat model (and effort) chosen in the composer; null model is "Agent default". Absent:
   *  the `agent.model` / `agent.effort` settings. Also restored from a saved chat's note. */
  chatModels: Record<ChatId, ChatModelChoice>;
  /** Chats whose model or effort was changed in a running session and not yet confirmed by the
   *  CLI (a `session-started` or turn `usage` naming the model, or `model-refused`). The chip
   *  shows the selected choice with a pending hint until then. */
  modelPending: Record<ChatId, true>;
  /** What each chat's note holds (see `chat-persist.ts`); saved after a send and a turn end. */
  notes: Record<ChatId, NoteState>;
  /** Chats that started with `--resume`: a "session not found" answer triggers the replay path. */
  resuming: Record<ChatId, boolean>;
  skills: Record<string, SkillsEntry>;
  /** The CLI's last reported lists in this window (it reports only after a first message). */
  cliCatalog: { slashCommands: string[]; skills: string[] } | null;
  /** Why the last attempt to open a saved chat failed. */
  historyError: string | null;
  view: AgentView;
  backend: AgentBackend;
  binary: AgentBinaryInfo | null;
  /** Project (vault-relative folder) new chats start in; Lane 3 sets it from the switcher. */
  currentProjectPath: string | null;
  /** Bumped to ask the composer to take focus. */
  focusComposerTick: number;
  /** Lane 3 renders the dialog from this; lane 2 only opens and closes it. */
  newProjectDialog: { open: boolean; folder: string | null };

  /** Shows the pane on a chat tab (makes one when there is none). The pane's visibility and width
   *  are in `pane-store.ts`. */
  openPane: () => void;
  closePane: () => void;
  togglePane: () => void;
  /** Brings back the chats that were open in this vault (`agent.restore-chats`): transcripts from
   *  their notes, no CLI process; the session resumes on the next send. Once per vault. */
  restoreChats: (root: string) => Promise<void>;
  /** Opens a saved chat in a tab: transcript from its note, resumes its CLI session on send. */
  openSavedChat: (chatId: ChatId) => Promise<void>;
  /** Reads the skills on disk for a project (cached entry stays visible while it refreshes). */
  loadSkills: (projectPath: string | null) => Promise<void>;
  /** Switches the active chat's model (and effort): live when a session runs (`set_model`), else
   *  at the next start. `effort` undefined keeps the current one. */
  setChatModel: (model: string | null, effort?: ChatModelChoice["effort"]) => Promise<void>;
  /** Reloads the active chat's session (header action, palette, `/reload`). */
  reloadSession: () => Promise<void>;
  setView: (view: AgentView) => void;
  setBackend: (backend: AgentBackend) => void;
  newChat: (projectPath?: string | null) => ChatId;
  closeChat: (chatId: ChatId) => void;
  selectChat: (chatId: ChatId) => void;
  cycleChat: (delta: 1 | -1) => void;
  setDraft: (chatId: ChatId, patch: Partial<Draft>) => void;
  /** Adds image refs to the draft (read at call time, so a save that finished after more typing
   *  never overwrites it); an image already attached is not added twice. */
  addDraftImages: (chatId: ChatId, refs: readonly ContextRef[]) => void;
  /** Enter: sends; while a turn runs the message is written to the CLI at once (it lands after
   *  the next tool call, or runs after the turn) and shows as the "Queued" chip, several of them
   *  merged into one message. `steer` (Cmd+Enter) cuts the current step instead (a normal send
   *  when idle). */
  sendMessage: (text: string, opts?: { steer?: boolean }) => Promise<void>;
  /** Cmd+Enter and the chip's "Send now": the text in the composer is steered; with none, the
   *  queued messages are (one merged message, the chip clears). */
  sendNow: (text: string) => Promise<void>;
  /** The chip's x and Esc: drops the message, and takes it back out of the CLI when it was
   *  written there (nothing happens when the CLI has already taken it). */
  removeQueued: (chatId: ChatId) => Promise<void>;
  /** The x of the changed-notes row: hidden until the list changes again. */
  hideSessionChanges: (chatId: ChatId) => void;
  stop: () => Promise<void>;
  decidePermission: (
    requestId: string,
    decision: "allow" | "deny",
    persist?: PermissionPersist,
    message?: string,
    rules?: string[],
  ) => Promise<void>;
  /** Answers the open question card; `answers` null skips it. */
  answerQuestion: (requestId: string, answers: QuestionAnswer[] | null) => Promise<void>;
  setPermissionMode: (mode: AgentPermissionMode) => Promise<void>;
  retry: () => Promise<void>;
  detectBinary: (override?: string | null) => Promise<void>;
  openNewProjectDialog: (opts?: { folder?: string | null }) => void;
  closeNewProjectDialog: () => void;
  /** Applies a batch from the event pump (also the test seam). */
  ingest: (chatId: ChatId, events: AgentEvent[], lastSeq: number) => void;
}

// ---------------------------------------------------------------------------------------------
// Runtime: the one client + pump, created lazily so opening the pane costs nothing

type Runtime = { client: AgentClient; pump: EventPump; unsubscribe: Unsubscribe };
let runtime: Runtime | null = null;
let runtimeStarting: Promise<Runtime> | null = null;
let testClient: { client: AgentClient; schedule?: (flush: () => void) => void } | null = null;

async function makeClient(backend: AgentBackend): Promise<AgentClient> {
  if (testClient) return testClient.client;
  if (backend === "mock") {
    const { createMockAgentClient, loadGoldens } =
      await import("@features/agent/web/lib/mock-client");
    return createMockAgentClient({ goldens: await loadGoldens(), delayMs: 45 });
  }
  return createTauriAgentClient();
}

async function ensureRuntime(): Promise<Runtime> {
  if (runtime) return runtime;
  runtimeStarting ??= (async () => {
    const client = await makeClient(useAgentStore.getState().backend);
    const pump = createEventPump({
      snapshot: (a) => client.snapshot(a),
      schedule: testClient?.schedule,
      onBatch: (id, events, last) => useAgentStore.getState().ingest(id, events, last),
      onResync: (id, state) =>
        useAgentStore.setState((s) => {
          const chat = s.chats[id];
          return chat && chat.state !== state && chat.state !== "starting"
            ? { chats: { ...s.chats, [id]: { ...chat, state } } }
            : s;
        }),
    });
    const unsubscribe = await client.subscribe((e) => pump.push(e));
    runtime = { client, pump, unsubscribe };
    return runtime;
  })().finally(() => {
    runtimeStarting = null;
  });
  return runtimeStarting;
}

/** The one client, for the stores that call agent commands outside this one (turn changes). */
export async function getAgentClient(): Promise<AgentClient> {
  return (await ensureRuntime()).client;
}

function teardownRuntime() {
  runtime?.unsubscribe();
  runtime = null;
}

/** Test seam: route the store through `client` and flush batches with `schedule` (default: now). */
export function configureAgentRuntimeForTests(
  client: AgentClient | null,
  schedule: (flush: () => void) => void = (f) => f(),
) {
  attachAgentStoreForTests();
  teardownRuntime();
  testClient = client ? { client, schedule } : null;
}

// ---------------------------------------------------------------------------------------------
// Helpers

const newId = () => crypto.randomUUID();

/** Vault-relative form of an absolute path; null when it is outside the vault. */
export function toVaultRelative(path: string, root: string | null): string | null {
  if (!root) return null;
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : null;
}

/** Maps what a failed start/send throws (an `AppError` or a string) to an error kind. */
export function classifyStartError(e: unknown): { kind: AgentErrorKind; message: string } {
  const raw =
    typeof e === "string"
      ? e
      : e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
  const kindField =
    e && typeof e === "object" && "kind" in e ? String((e as { kind: unknown }).kind) : "";
  const lower = `${kindField} ${raw}`.toLowerCase();
  if (/binary.?not.?found|not installed|could not find .*claude/.test(lower))
    return { kind: "binary-not-found", message: raw };
  if (/denied|consent|declined/.test(lower)) return { kind: "spawn-denied", message: raw };
  if (/command .* not found|unknown command/.test(lower))
    return { kind: "unknown", message: "The agent backend is not available in this build." };
  return { kind: "spawn-failed", message: raw };
}

let refIoOverride: RefIo | null = null;
/** Test seam: the I/O behind send-time reference resolution (default: the real index). */
export function configureRefIoForTests(io: RefIo | null) {
  refIoOverride = io;
}

/** Follows renames of picked notes and resolves hand-typed exact paths; on any failure the refs
 *  stay as they were (the message must still go out). */
async function resolveRefs(text: string, refs: ContextRef[]): Promise<ContextRef[]> {
  try {
    const root = useWorkspaceStore.getState().root;
    const io = refIoOverride ?? (root ? createRefIo(root) : null);
    return io ? await prepareRefs(text, refs, io) : refs;
  } catch (e) {
    logger.log("debug", "agent", `could not resolve references: ${String(e)}`);
    return refs;
  }
}

/** Skill names this chat can use: its session's, the window's last CLI lists, the disk scan. */
function knownSkillNames(s: AgentState, chat: Chat): string[] {
  const disk = s.skills[skillsKey(chat.projectPath)]?.items ?? [];
  return [...disk.map((d) => d.name), ...(chat.session?.skills ?? s.cliCatalog?.skills ?? [])];
}

function activeNoteRef(): ContextRef | null {
  const path = useEditorStore.getState().activeFilePath;
  const rel = path ? toVaultRelative(path, useWorkspaceStore.getState().root) : null;
  return rel ? { kind: "active-note", path: rel, inline: false } : null;
}

function attachActiveNoteDefault(): boolean {
  return useSettingsStore.getState().settings["agent.attach-active-note"] !== false;
}

function shareOpenTabsSetting(): boolean {
  return useSettingsStore.getState().settings["agent.share-open-tabs"] !== false;
}

/** Vault-file editor tabs right now (`agent.share-open-tabs`), empty when the setting is off. */
function currentOpenTabs(cwd: string | null): OpenTab[] {
  if (!shareOpenTabsSetting()) return [];
  const { tabs, activeTabId, openFiles } = useEditorStore.getState();
  const root = useWorkspaceStore.getState().root;
  return openTabsFrom({
    tabs,
    activeTabId,
    toSentPath: (p) => {
      const rel = toVaultRelative(p, root);
      return rel ? relativeToCwd(rel, cwd) : null;
    },
    frontmatterOf: (p) => openFiles.get(p)?.frontmatter,
    typeOf: (key) => propertyTypeInfo(key)?.type,
  });
}

/** Signature of the `<open-tabs>` block last sent per chat; a turn repeats it only when it changed. */
const lastOpenTabsSent = new Map<ChatId, string>();

/** The refs sent with a message: the active note unless removed, then the explicit mentions. */
export function contextForSend(draft: Draft, text = ""): ContextRef[] {
  const refs: ContextRef[] = [];
  // `@activenote` typed in the text attaches the note even when its chip was removed.
  const wanted = mentionsActiveNote(text) || (draft.activeNote && attachActiveNoteDefault());
  const note = wanted ? activeNoteRef() : null;
  if (note) refs.push(note);
  const seen = new Set(refs.map((r) => `${r.kind}:${"path" in r ? r.path : ""}`));
  for (const m of draft.mentions) {
    const key = `${m.kind}:${"path" in m ? m.path : JSON.stringify(m)}`;
    if (!seen.has(key)) refs.push(m);
    seen.add(key);
  }
  return refs;
}

/** A refused model switch in a batch: the chat falls back to what the CLI says it uses. */
function refusedModelFrom(events: readonly AgentEvent[]): { using: string | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "model-refused") return { using: e.using };
  }
  return null;
}

/** Does a batch confirm the chat's pending model? The CLI refusing it settles it too; otherwise a
 *  `session-started` or turn `usage` naming a model that matches the choice does. */
function confirmsModel(events: readonly AgentEvent[], choice: ChatModelChoice | undefined) {
  return events.some(
    (e) =>
      e.type === "model-refused" ||
      ((e.type === "session-started" || e.type === "usage") &&
        !!e.model &&
        reportedMatches(choice?.model ?? null, e.model)),
  );
}

/** The slash commands and skills of the newest `session-started` in a batch. */
function catalogFrom(events: readonly AgentEvent[]): AgentState["cliCatalog"] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "session-started")
      return { slashCommands: e.slashCommands, skills: e.skills ?? [] };
  }
  return null;
}

function omitKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = map;
  return rest;
}

function withChat(s: AgentState, id: ChatId, next: Chat): Pick<AgentState, "chats"> {
  return { chats: { ...s.chats, [id]: next } };
}

// ---------------------------------------------------------------------------------------------
// Persistence glue: the note is built from the store's state and written by the debounced saver

/** A chat nothing happened in: no turns, no CLI session, nothing typed or attached. */
function isUntouchedChat(chat: Chat, draft: Draft | undefined): boolean {
  return (
    chat.turns.length === 0 &&
    !chat.session &&
    !chat.resumeSessionId &&
    chat.state === "idle" &&
    !draft?.text.trim() &&
    !(draft?.mentions.length ?? 0)
  );
}

const persistence = {
  history: chatHistoryClient as ChatHistoryClient,
  delayMs: 500,
  reload: reloadChatNoteIfOpen as (relativePath: string) => Promise<unknown>,
  instance: null as ChatSaver | null,
  /** Chats that already had their one automatic title attempt in this window. */
  titleAttempts: new Set<ChatId>(),
  saver(): ChatSaver {
    this.instance ??= createChatSaver({
      delayMs: this.delayMs,
      save: (chatId, req) =>
        this.history.save({ chatId, markdown: req.markdown, titleHint: req.titleHint }),
      onSaved: (chatId, summary) => {
        useAgentStore.setState((s) =>
          s.chats[chatId]?.saveError
            ? { chats: { ...s.chats, [chatId]: { ...s.chats[chatId]!, saveError: null } } }
            : s,
        );
        // Hidden folders are not watched: reload the note if an editor tab shows it.
        this.reload(summary.path).catch((e: unknown) =>
          logger.warn("agent", `could not reload the open chat note: ${String(e)}`),
        );
      },
      onError: (chatId, e) => {
        logger.warn("agent", `chat save failed: ${String(e)}`);
        useAgentStore.setState((s) =>
          s.chats[chatId]
            ? {
                chats: {
                  ...s.chats,
                  [chatId]: { ...s.chats[chatId]!, saveError: classifyStartError(e).message },
                },
              }
            : s,
        );
      },
    });
    return this.instance;
  },
};

/** Test seam: swap the history client, the debounce and the editor reload, dropping pending saves. */
export function configureChatPersistenceForTests(opts: {
  history?: ChatHistoryClient;
  delayMs?: number;
  reload?: (relativePath: string) => Promise<unknown>;
  chatsIo?: ChatsIo;
}) {
  attachAgentStoreForTests();
  chatRestore.reset(opts.chatsIo, opts.delayMs);
  lastProject.root = null;
  persistence.instance = null;
  persistence.titleAttempts = new Set();
  persistence.history = opts.history ?? chatHistoryClient;
  persistence.delayMs = opts.delayMs ?? 500;
  persistence.reload = opts.reload ?? reloadChatNoteIfOpen;
}

// ---------------------------------------------------------------------------------------------
// The last used project, per vault: the project of the chat the user last worked in. One rule:
// `currentProjectPath` follows the active chat's project (the subscription at the end of this
// file), and is saved under the vault's key from there. Picking a project, switching tabs and
// changing a chat's project all end in a change of the active chat, so no call site updates it.

const lastProject = {
  /** Vault whose value is loaded: writes are allowed. */
  root: null as string | null,
};

export const lastProjectPreferenceKey = (root: string) => `workspace:${root}:agent-last-project`;

async function loadLastProject(root: string) {
  lastProject.root = null;
  const saved = await getPreference<unknown>(lastProjectPreferenceKey(root), null);
  if (useWorkspaceStore.getState().root !== root) return;
  useAgentStore.setState({ currentProjectPath: typeof saved === "string" && saved ? saved : null });
  lastProject.root = root;
}

/** The project a new chat starts in: the last used one, unless the project list (once loaded for
 *  this vault) no longer has it (archived, deleted or moved): then the vault root. */
function defaultProjectPath(): string | null {
  const path = useAgentStore.getState().currentProjectPath;
  if (!path) return null;
  const projects = useProjectsStore.getState();
  const loaded =
    projects.loadedRoot !== null && projects.loadedRoot === useWorkspaceStore.getState().root;
  return loaded && !projects.projects.some((p) => p.path === path) ? null : path;
}

// ---------------------------------------------------------------------------------------------
// The open chats of the pane, saved with the editor session of the vault (`lib/session.ts`) and
// restored from their chat notes. Nothing is saved until the restore for the vault has finished,
// or the empty first chat would overwrite the saved list.

type ChatsIo = {
  load: (root: string) => Promise<AgentChatsSession | null>;
  save: (root: string, s: AgentChatsSession) => Promise<void>;
};

const chatRestore = {
  io: { load: loadAgentChats, save: saveAgentChats } as ChatsIo,
  delayMs: 500,
  /** Vault whose restore is running or done. */
  root: null as string | null,
  /** Restore finished for `root`: saving is allowed. */
  ready: false,
  lastKey: null as string | null,
  timer: null as ReturnType<typeof setTimeout> | null,
  reset(io?: ChatsIo, delayMs?: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.root = null;
    this.ready = false;
    this.lastKey = null;
    this.io = io ?? { load: loadAgentChats, save: saveAgentChats };
    this.delayMs = delayMs ?? 500;
  },
};

/** The chats worth restoring (those with a message, so a note exists) in tab order. */
function openChatsSnapshot(s: AgentState): AgentChatsSession {
  const chats = s.order
    .filter((id) => (s.notes[id]?.messages.length ?? 0) > 0)
    .map((id) => ({
      chatId: id,
      sessionId:
        s.chats[id]?.session?.sessionId ??
        s.chats[id]?.resumeSessionId ??
        s.notes[id]?.meta.sessionId ??
        null,
    }));
  const active = s.activeChatId;
  return {
    chats,
    activeChatId: active && chats.some((c) => c.chatId === active) ? active : null,
  };
}

function flushOpenChats() {
  if (chatRestore.timer) clearTimeout(chatRestore.timer);
  chatRestore.timer = null;
  const root = useWorkspaceStore.getState().root;
  const state = useAgentStore.getState();
  if (!chatRestore.ready || !root || root !== chatRestore.root || state.backend !== "tauri") return;
  const snap = openChatsSnapshot(state);
  const key = JSON.stringify(snap);
  if (key === chatRestore.lastKey) return;
  chatRestore.lastKey = key;
  void chatRestore.io.save(root, snap);
}

function scheduleOpenChatsSave() {
  if (!chatRestore.ready) return;
  if (chatRestore.timer) clearTimeout(chatRestore.timer);
  chatRestore.timer = setTimeout(flushOpenChats, chatRestore.delayMs);
}

function scheduleSave(chatId: ChatId) {
  persistence.saver().schedule(chatId, () => {
    const { chats, notes, chatModels } = useAgentStore.getState();
    const chat = chats[chatId];
    const note = notes[chatId];
    if (!chat || !note || note.messages.length === 0) return null;
    return buildNote(chat, note, Date.now(), chatModels[chatId]?.model);
  });
}

/** Automatic chat title (spec "Automatic chat titles"): at most one attempt per chat, started by
 *  a finished turn. A failure, a refusal or a chat closed meanwhile leaves the placeholder; the
 *  user's own rename always wins (Rust refuses to overwrite it and says so in the summary). */
async function maybeAutoTitle(chatId: ChatId) {
  const { chats, notes, chatModels } = useAgentStore.getState();
  const chat = chats[chatId];
  const note = notes[chatId];
  if (!chat || !note) return;
  const settings = useSettingsStore.getState().settings;
  const enabled = settings["agent.auto-title-chats"] !== false;
  const attempted = persistence.titleAttempts.has(chatId);
  if (!shouldAutoTitle({ enabled, meta: note.meta, messages: note.messages, attempted })) return;
  persistence.titleAttempts.add(chatId);
  try {
    // the note must be on disk: Rust reads the title input from it
    await persistence.saver().flush(chatId);
    const summary = await persistence.history.autoTitle({
      chatId,
      titleModel: titleModelSetting(),
      chatModel: chatModels[chatId]?.model ?? chat.reportedModel ?? null,
    });
    if (summary) adoptTitleSummary(chatId, summary);
  } catch (e) {
    logger.log("debug", "agent", `automatic title failed: ${String(e)}`);
  }
}

/** The title call runs on the cheap tier: `agent.claude.model-cheap`, `null` when blank (Rust then
 *  uses the tier's default). */
function titleModelSetting(): string | null {
  const m = useSettingsStore.getState().settings[claudeTierSettingKey("cheap")];
  return typeof m === "string" ? m : null;
}

/** "Reload session" for one chat: restarts its idle process with `--resume`. Resolves to the
 *  notice to show now (refused while a turn or permission card is open, nothing to reload yet, a
 *  failure), or `null` when it started: the `session-reloaded` event brings the notice. */
export async function reloadChatSession(chatId: ChatId): Promise<string | null> {
  const chat = useAgentStore.getState().chats[chatId];
  if (!chat?.session || chat.state === "ended") return RELOAD_NOT_STARTED_TEXT;
  try {
    const { client } = await ensureRuntime();
    return reloadNoticeFor(await client.reload({ chatId }));
  } catch (e) {
    return `Could not reload the session: ${classifyStartError(e).message}`;
  }
}

/** Show a title Rust applied to the note: the tab title and the note's flags, with no focus
 *  change. A chat that is not open in the pane changes nothing here (its note is the truth). */
function adoptTitleSummary(chatId: ChatId, summary: ChatSummary) {
  useAgentStore.setState((s) => {
    const current = s.chats[chatId];
    const applied = current && applyTitleSummary(current, s.notes[chatId], summary);
    if (!applied) return s;
    return {
      chats: { ...s.chats, [chatId]: applied.chat },
      notes: applied.note ? { ...s.notes, [chatId]: applied.note } : s.notes,
    };
  });
}

/** History "Regenerate title" for any chat, open or not. An open chat's pending save is flushed
 *  first (the note is the input, and a stale save must not race the title); the result is adopted
 *  live. Never throws for a refusal: the outcome says why. */
export async function regenerateChatTitle(chatId: ChatId): Promise<RegenerateOutcome> {
  await persistence.saver().flush(chatId);
  const outcome = await persistence.history.regenerateTitle(chatId, titleModelSetting());
  if (outcome.status === "done") adoptTitleSummary(chatId, outcome.summary);
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Store

export const useAgentStore = create<AgentState>((set, get) => {
  /** Answers an open card (permission or question) of the active chat. A refusal means it was
   *  already resolved elsewhere (cancelled by the CLI): the event clears the card, the error is
   *  shown. */
  async function answerOpenRequest(
    call: (client: AgentClient, chatId: ChatId) => Promise<void>,
  ): Promise<void> {
    const chatId = get().activeChatId;
    if (!chatId) return;
    try {
      const { client } = await ensureRuntime();
      await call(client, chatId);
    } catch (e) {
      const { message: m } = classifyStartError(e);
      set((s) =>
        s.chats[chatId]
          ? withChat(s, chatId, {
              ...s.chats[chatId]!,
              error: { kind: "unknown", message: m, retryable: true, at: Date.now() },
            })
          : s,
      );
    }
  }

  /** Writes the user card and talks to the backend; the caller checked the chat is free.
   *  `replay`: start a fresh session seeded with the note's text (the CLI lost the old one).
   *  `steer`: the chat is mid-turn; the card joins that turn's timeline and the message goes into
   *  the running turn. `queue`: the chat is mid-turn and the message (this id) is written as a
   *  plain line the CLI takes at its next tool call: no card yet, the receipt places it. */
  async function deliver(
    chatId: ChatId,
    text: string,
    context: ContextRef[],
    opts: { replay?: boolean; steer?: boolean; queue?: string } = {},
  ) {
    const before = get().chats[chatId];
    if (!before) return;
    const live = before.session !== null && before.state !== "ended" && before.state !== "error";
    const messageId = opts.queue ?? newId();
    const resumeSessionId = opts.replay
      ? null
      : (before.session?.sessionId ?? before.resumeSessionId);
    const now = Date.now();
    // a queued line has no card yet: the receipt places it (`message-received`)
    if (!opts.queue)
      set((s) => {
        const msg = { messageId, text, context };
        const chat = opts.steer
          ? appendSteer(s.chats[chatId]!, msg, now)
          : appendUserTurn(s.chats[chatId]!, msg, now, live);
        const note = s.notes[chatId];
        const record = opts.steer ? recordSteer : recordSend;
        return {
          ...withChat(s, chatId, chat),
          notes: note ? { ...s.notes, [chatId]: record(note, { ...msg, ts: now }) } : s.notes,
          resuming: { ...s.resuming, [chatId]: !live && resumeSessionId !== null },
        };
      });
    if (!opts.queue) scheduleSave(chatId);
    try {
      const { client } = await ensureRuntime();
      if (!live) {
        const settings = agentSettingsFrom(useSettingsStore.getState().settings);
        await client.start({
          chatId,
          projectPath: before.projectPath,
          resumeSessionId,
          settings: {
            ...settings,
            permissionMode: get().modes[chatId] ?? settings.permissionMode,
            ...get().chatModels[chatId],
          },
          appendSystemPrompt: null,
        });
      }
      // What claude receives is built at send time (the active note resolves now); the card and
      // the chat note keep `text` as the user saw it.
      const refs = await resolveRefs(text, context);
      const tabs = currentOpenTabs(before.projectPath);
      const tabsBlock = openTabsBlock(tabs);
      // a fresh session (replay) never saw the previous footer
      const unchanged =
        !opts.replay && tabsBlock !== null && lastOpenTabsSent.get(chatId) === tabsBlock;
      let sendText = buildPrompt({
        text,
        refs,
        cwd: before.projectPath,
        skills: knownSkillNames(get(), before),
        openTabs: unchanged ? [] : tabs,
      });
      if (tabsBlock === null) lastOpenTabsSent.delete(chatId);
      if (opts.replay) {
        const seed = await persistence.history.replay(chatId);
        sendText = `${seed.text}\n\n${sendText}`;
      }
      const message = { chatId, messageId, text: sendText, context: refs };
      if (opts.steer) await client.steer(message);
      else if (opts.queue) await client.queue(message);
      else await client.send(message);
      if (tabsBlock !== null && sendText.includes(tabsBlock))
        lastOpenTabsSent.set(chatId, tabsBlock);
    } catch (e) {
      const { kind, message } = classifyStartError(e);
      if (opts.queue) {
        // the running turn is fine: the message goes back to waiting in Writer
        revertLine(chatId, messageId);
        return;
      }
      if (!opts.replay && !live && resumeSessionId !== null && isSessionMissing(message)) {
        await recoverMissingSession(chatId);
        return;
      }
      set((s) =>
        s.chats[chatId]
          ? withChat(s, chatId, failSend(s.chats[chatId]!, message, kind, Date.now()))
          : s,
      );
    }
  }

  /** The CLI no longer has this chat's session: forget the failed exchange and send the same
   *  message to a new session, prefixed with the capped replay of the note (spec section 9). */
  async function recoverMissingSession(chatId: ChatId) {
    const chat = get().chats[chatId];
    const last = chat?.turns[chat.turns.length - 1];
    if (!chat || !last?.user) return;
    const { text, context } = last.user;
    set((s) => {
      const c = s.chats[chatId]!;
      const note = s.notes[chatId];
      return {
        ...withChat(s, chatId, {
          ...c,
          turns: c.turns.slice(0, -1),
          error: null,
          state: "idle",
          session: null,
          resumeSessionId: null,
        }),
        notes: note ? { ...s.notes, [chatId]: dropLastExchange(note) } : s.notes,
        resuming: { ...s.resuming, [chatId]: false },
      };
    });
    await deliver(chatId, text, context, { replay: true });
  }

  // ---- messages sent while a turn runs (Enter): the chip, and the line written to the CLI ----

  /** The chip, and the written line behind it (when `id` names one): gone. */
  function dropChip(chatId: ChatId) {
    set((s) => {
      const { [chatId]: chip, ...queued } = s.queued;
      if (!chip) return s;
      return { queued, written: chip.id === null ? s.written : omitKey(s.written, chip.id) };
    });
  }

  /** A written line the CLI no longer holds (its write failed, it was lost or stopped): the chip
   *  waits in Writer again, and goes out as an ordinary message once the chat is idle. */
  function revertLine(chatId: ChatId, messageId: string) {
    set((s) => {
      const chip = s.queued[chatId];
      return {
        written: omitKey(s.written, messageId),
        queued:
          chip?.id === messageId ? { ...s.queued, [chatId]: { ...chip, id: null } } : s.queued,
      };
    });
    flushHeld(chatId);
  }

  /** The chip held in Writer goes out as an ordinary message once the chat is idle. */
  function flushHeld(chatId: ChatId) {
    const chip = get().queued[chatId];
    if (!chip || chip.id !== null || get().chats[chatId]?.state !== "idle") return;
    dropChip(chatId);
    void deliver(chatId, chip.text, chip.context);
  }

  async function unqueueLine(chatId: ChatId, messageId: string): Promise<boolean> {
    const { client } = await ensureRuntime();
    return client.unqueue({ chatId, messageId });
  }

  /** Writes the message to the CLI now and shows it as the chip until the receipt. */
  async function writeLine(chatId: ChatId, text: string, context: ContextRef[]) {
    const id = newId();
    set((s) => ({
      queued: { ...s.queued, [chatId]: { text, context, id } },
      written: { ...s.written, [id]: { chatId, text, context } },
    }));
    await deliver(chatId, text, context, { queue: id });
  }

  /** Bumped by every removal of the chip: a merge started before it must not write anything. */
  const removals = new Map<ChatId, number>();

  /** One chip operation at a time per chat: a second Enter waits for the answer of the first. */
  const lineOps = new Map<ChatId, Promise<void>>();
  function inOrder(chatId: ChatId, op: () => Promise<void>): Promise<void> {
    const run = (lineOps.get(chatId) ?? Promise.resolve()).then(op);
    lineOps.set(
      chatId,
      run.catch(() => undefined),
    );
    return run;
  }

  /** Enter while a turn runs (or a message already waits). Several messages become one: the chip
   *  shows the merged text at once (`appendTail`), then `reconcileLine` takes the line still
   *  waiting in the CLI back and writes it again joined; one the CLI took in the meantime stays
   *  what it is (its card) and the new text waits as its own chip. */
  function queueMessage(chatId: ChatId, text: string, context: ContextRef[]): Promise<void> {
    const gen = removals.get(chatId) ?? 0;
    if (get().queued[chatId]?.id) {
      appendTail(chatId, { text, context });
      return inOrder(chatId, () => reconcileLine(chatId, gen));
    }
    return inOrder(chatId, async () => {
      const chat = get().chats[chatId];
      const chip = get().queued[chatId];
      if (!chat) return;
      if (chip?.id === null) {
        // held in Writer (the chat was starting or stopping): the same merge as ever
        set((s) => ({
          queued: {
            ...s.queued,
            [chatId]: {
              ...chip,
              text: `${chip.text}\n\n${text}`,
              context: [...chip.context, ...context],
            },
          },
        }));
      } else if (chip) {
        appendTail(chatId, { text, context });
        await reconcileLine(chatId, gen);
      } else if (canSteer(chat)) await writeLine(chatId, text, context);
      else if (isBusy(chat)) {
        set((s) => ({ queued: { ...s.queued, [chatId]: { text, context, id: null } } }));
      } else await deliver(chatId, text, context);
    });
  }

  /** The chip shows `more` after its text right now, before the CLI has been asked anything. */
  function appendTail(chatId: ChatId, more: PendingText) {
    set((s) => {
      const chip = s.queued[chatId];
      if (!chip) return s;
      const tail = chip.tail
        ? {
            text: `${chip.tail.text}\n\n${more.text}`,
            context: [...chip.tail.context, ...more.context],
          }
        : more;
      const joined = {
        text: `${chip.text}\n\n${more.text}`,
        context: [...chip.context, ...more.context],
      };
      return { queued: { ...s.queued, [chatId]: { ...chip, ...joined, tail } } };
    });
  }

  /** Writes what the chip shows but the CLI does not have yet. The line waiting there is taken
   *  back first: gone, the whole text is written as one line; already taken (its receipt is on
   *  its way), it keeps its own card and only the tail is written, as the new chip. The chip
   *  never shows less than what will be delivered. */
  async function reconcileLine(chatId: ChatId, gen: number) {
    const chip = get().queued[chatId];
    if (!chip?.tail || chip.id === null || (removals.get(chatId) ?? 0) !== gen) return;
    const id = chip.id;
    let gone = false;
    try {
      gone = await unqueueLine(chatId, id);
    } catch {
      // no answer: it stays where it is, the tail waits on its own
    }
    // the receipt may have come while waiting: the chip is then the tail alone, held in Writer
    const now = get().queued[chatId];
    if (!now || now.id !== id || !now.tail) return;
    if ((removals.get(chatId) ?? 0) !== gen) {
      // the user removed the chip meanwhile: nothing is written or shown again; a line the CLI
      // gave up is gone for good, one it took keeps its card (the removal settles the chip)
      if (gone) dropChip(chatId);
      return;
    }
    if (gone) {
      set((s) => ({ written: omitKey(s.written, id) }));
      await writeLine(chatId, now.text, now.context);
    } else await writeLine(chatId, now.tail.text, now.tail.context);
  }

  return {
    chats: {},
    order: [],
    activeChatId: null,
    drafts: {},
    queued: {},
    written: {},
    modes: {},
    chatModels: {},
    modelPending: {},
    notes: {},
    resuming: {},
    historyError: null,
    skills: {},
    cliCatalog: null,
    view: "chat",
    backend: "tauri",
    binary: null,
    currentProjectPath: null,
    focusComposerTick: 0,
    newProjectDialog: { open: false, folder: null },

    openPane: () => {
      if (get().order.length === 0) get().newChat();
      set((s) => ({ view: "chat", focusComposerTick: s.focusComposerTick + 1 }));
      usePaneStore.getState().setOpen(true);
    },
    closePane: () => usePaneStore.getState().setOpen(false),
    togglePane: () => (usePaneStore.getState().open ? get().closePane() : get().openPane()),
    setView: (view) => set({ view }),
    setBackend: (backend) => {
      if (get().backend === backend) return;
      teardownRuntime();
      set({
        backend,
        chats: {},
        order: [],
        activeChatId: null,
        queued: {},
        written: {},
        drafts: {},
        modes: {},
        chatModels: {},
        modelPending: {},
        notes: {},
        resuming: {},
        skills: {},
        cliCatalog: null,
        binary: null,
      });
      get().newChat();
    },

    newChat: (projectPath) => {
      // Switching project while the active chat is untouched reuses it instead of stacking
      // another empty "New chat": only its project changes (nothing to carry over). A plain
      // new chat (no project given) always adds a tab.
      const activeId = get().activeChatId;
      const active = activeId ? get().chats[activeId] : undefined;
      if (
        projectPath !== undefined &&
        active &&
        isUntouchedChat(active, get().drafts[active.chatId])
      ) {
        const target = projectPath ?? defaultProjectPath();
        set((s) => ({
          chats: { ...s.chats, [active.chatId]: { ...active, projectPath: target } },
          notes: s.notes[active.chatId]
            ? {
                ...s.notes,
                [active.chatId]: {
                  ...s.notes[active.chatId],
                  meta: { ...s.notes[active.chatId].meta, projectPath: target },
                },
              }
            : s.notes,
          view: "chat",
          focusComposerTick: s.focusComposerTick + 1,
        }));
        return active.chatId;
      }
      const chatId = newId();
      const chat = createChat(chatId, { projectPath: projectPath ?? defaultProjectPath() });
      set((s) => ({
        chats: { ...s.chats, [chatId]: chat },
        notes: { ...s.notes, [chatId]: newNoteState(chatId, chat.projectPath, Date.now()) },
        order: [...s.order, chatId],
        activeChatId: chatId,
        view: "chat",
        focusComposerTick: s.focusComposerTick + 1,
      }));
      return chatId;
    },
    closeChat: (chatId) => {
      const chat = get().chats[chatId];
      if (!chat) return;
      if (chat.session)
        void ensureRuntime()
          .then((r) => r.client.close({ chatId }))
          .catch(() => {});
      runtime?.pump.forget(chatId);
      void persistence.saver().flush(chatId);
      set((s) => {
        const order = s.order.filter((id) => id !== chatId);
        const { [chatId]: _c, ...chats } = s.chats;
        const { [chatId]: _d, ...drafts } = s.drafts;
        const { [chatId]: _q, ...queued } = s.queued;
        const written = Object.fromEntries(
          Object.entries(s.written).filter(([, line]) => line.chatId !== chatId),
        );
        const { [chatId]: _m, ...modes } = s.modes;
        const { [chatId]: _cm, ...chatModels } = s.chatModels;
        const { [chatId]: _mp, ...modelPending } = s.modelPending;
        const { [chatId]: _n, ...notes } = s.notes;
        const { [chatId]: _r, ...resuming } = s.resuming;
        const idx = s.order.indexOf(chatId);
        const activeChatId =
          s.activeChatId === chatId
            ? (order[Math.min(idx, order.length - 1)] ?? null)
            : s.activeChatId;
        return {
          chats,
          order,
          drafts,
          queued,
          written,
          modes,
          chatModels,
          modelPending,
          notes,
          resuming,
          activeChatId,
        };
      });
      if (get().order.length === 0) get().newChat();
    },
    selectChat: (chatId) => {
      if (get().chats[chatId])
        set((s) => ({
          activeChatId: chatId,
          view: "chat",
          focusComposerTick: s.focusComposerTick + 1,
        }));
    },
    cycleChat: (delta) => {
      const { order, activeChatId } = get();
      if (order.length < 2 || !activeChatId) return;
      const i = order.indexOf(activeChatId);
      get().selectChat(order[(i + delta + order.length) % order.length]!);
    },
    setDraft: (chatId, patch) =>
      set((s) => {
        const next = { ...(s.drafts[chatId] ?? EMPTY_DRAFT), ...patch };
        // Refs follow the text: the one place a text change attaches or detaches a ref.
        if ("text" in patch) {
          const refs = reconcileRefs(next.text, next.mentions, next.parked ?? []);
          next.mentions = refs.mentions;
          next.parked = refs.parked;
        }
        return { drafts: { ...s.drafts, [chatId]: next } };
      }),

    addDraftImages: (chatId, refs) =>
      set((s) => {
        const draft = s.drafts[chatId] ?? EMPTY_DRAFT;
        const has = (r: ContextRef) =>
          draft.mentions.some(
            (m) => m.kind === r.kind && "path" in m && "path" in r && m.path === r.path,
          );
        const fresh = refs.filter((r) => !has(r));
        if (fresh.length === 0) return s;
        return {
          drafts: { ...s.drafts, [chatId]: { ...draft, mentions: [...draft.mentions, ...fresh] } },
        };
      }),

    sendMessage: async (rawText, opts = {}) => {
      const chatId = get().activeChatId;
      const chat = chatId ? get().chats[chatId] : null;
      const text = rawText.trim();
      if (!chatId || !chat || !text || isComposerDisabled(chat)) return;
      const writer = parseWriterCommand(text);
      if (writer) {
        // Writer's own command: runs here, never reaches Claude, adds no user turn or note entry.
        get().setDraft(chatId, { text: "", mentions: [], parked: [] });
        const notice = await writer.command.run({
          chatId,
          chat,
          args: writer.args,
          regenerateTitle: regenerateChatTitle,
          reloadSession: reloadChatSession,
        });
        // `null`: the command's own event shows the notice
        if (notice !== null) {
          set((s) =>
            s.chats[chatId] ? withChat(s, chatId, { ...s.chats[chatId]!, localNotice: notice }) : s,
          );
        }
        return;
      }
      const context = contextForSend(get().drafts[chatId] ?? EMPTY_DRAFT, text);
      // Clear the draft now; the mentions are consumed, the active-note choice persists.
      get().setDraft(chatId, { text: "", mentions: [], parked: [] });
      if (opts.steer && canSteer(chat)) {
        await deliver(chatId, text, context, { steer: true });
        return;
      }
      // a message already waiting, or a turn that runs: the chip (see `queueMessage`)
      if (isBusy(chat) || get().queued[chatId]) {
        await queueMessage(chatId, text, context);
        return;
      }
      await deliver(chatId, text, context);
    },
    sendNow: async (rawText) => {
      if (rawText.trim()) return get().sendMessage(rawText, { steer: true });
      const chatId = get().activeChatId;
      const chat = chatId ? get().chats[chatId] : null;
      const queued = chatId ? get().queued[chatId] : undefined;
      if (!chatId || !chat || !queued || !(canSteer(chat) || !isBusy(chat))) return;
      if (queued.id !== null) {
        // written to the CLI: take it back first; one the CLI already took is on its way anyway
        let gone = false;
        try {
          gone = await unqueueLine(chatId, queued.id);
        } catch {
          return;
        }
        if (!gone) return;
      }
      dropChip(chatId);
      await deliver(chatId, queued.text, queued.context, { steer: canSteer(chat) });
    },
    hideSessionChanges: (chatId) =>
      set((s) => {
        const chat = s.chats[chatId];
        if (!chat?.sessionChanges) return s;
        return withChat(s, chatId, {
          ...chat,
          sessionChanges: hideSessionChanges(chat.sessionChanges),
        });
      }),
    removeQueued: async (chatId) => {
      if (!get().queued[chatId]) return;
      // a removal wins over a merge in flight (`reconcileLine` checks it), and waits its turn
      removals.set(chatId, (removals.get(chatId) ?? 0) + 1);
      await inOrder(chatId, async () => {
        const chip = get().queued[chatId];
        if (!chip) return;
        if (chip.id !== null) {
          try {
            // false: the CLI took it already; its card follows with the receipt
            if (!(await unqueueLine(chatId, chip.id))) {
              // what the CLI took is what the chip keeps showing until then, nothing else
              const taken = get().written[chip.id];
              if (taken && get().queued[chatId]?.id === chip.id) {
                set((s) => ({
                  queued: {
                    ...s.queued,
                    [chatId]: { text: taken.text, context: taken.context, id: chip.id },
                  },
                }));
              }
              return;
            }
          } catch {
            return;
          }
        }
        if (get().queued[chatId]?.id === chip.id) dropChip(chatId);
      });
    },
    stop: async () => {
      const chatId = get().activeChatId;
      const chat = chatId ? get().chats[chatId] : null;
      if (!chatId || !chat || !isBusy(chat) || chat.state === "cancelling") return;
      set((s) => withChat(s, chatId, markCancelling(s.chats[chatId]!)));
      try {
        const { client } = await ensureRuntime();
        await client.cancel({ chatId });
      } catch (e) {
        const { message } = classifyStartError(e);
        set((s) =>
          s.chats[chatId]
            ? withChat(s, chatId, {
                ...s.chats[chatId]!,
                state: "idle",
                error: { kind: "unknown", message, retryable: true, at: Date.now() },
              })
            : s,
        );
      }
    },
    decidePermission: async (requestId, decision, persist, message, rules) => {
      await answerOpenRequest((client, chatId) =>
        client.permission({ chatId, requestId, decision, persist, message, rules }),
      );
    },
    answerQuestion: async (requestId, answers) => {
      await answerOpenRequest((client, chatId) =>
        client.answerQuestion({ chatId, requestId, answers }),
      );
    },
    reloadSession: async () => {
      const chatId = get().activeChatId;
      if (!chatId) return;
      const notice = await reloadChatSession(chatId);
      if (notice !== null) {
        set((s) =>
          s.chats[chatId] ? withChat(s, chatId, { ...s.chats[chatId]!, localNotice: notice }) : s,
        );
      }
    },
    setPermissionMode: async (mode) => {
      const chatId = get().activeChatId;
      if (!chatId) return;
      const chat = get().chats[chatId];
      if (chat?.session && chat.state !== "ended") {
        try {
          const { client } = await ensureRuntime();
          await client.setPermissionMode({ chatId, mode });
        } catch (e) {
          const { message } = classifyStartError(e);
          set((s) =>
            s.chats[chatId]
              ? withChat(s, chatId, {
                  ...s.chats[chatId]!,
                  error: { kind: "unknown", message, retryable: true, at: Date.now() },
                })
              : s,
          );
          return;
        }
      }
      set((s) => ({ modes: { ...s.modes, [chatId]: mode } }));
    },
    setChatModel: async (model, effort) => {
      const chatId = get().activeChatId;
      if (!chatId) return;
      const prev = get().chatModels[chatId];
      const settings = agentSettingsFrom(useSettingsStore.getState().settings);
      const choice: ChatModelChoice = {
        model,
        effort: effort === undefined ? (prev?.effort ?? settings.effort) : effort,
      };
      const chat = get().chats[chatId];
      const prevReported = chat?.reportedModel ?? null;
      const live = !!chat?.session && chat.state !== "ended";
      // Optimistic: the chip shows the selection at once; a live session confirms it later. The
      // CLI's earlier report described the old model: dropped, so it can never outvote the pick
      // (only a report arriving after it, a fallback, shows).
      set((s) => ({
        chatModels: { ...s.chatModels, [chatId]: choice },
        modelPending: live ? { ...s.modelPending, [chatId]: true } : s.modelPending,
        ...(s.chats[chatId]
          ? withChat(s, chatId, { ...s.chats[chatId]!, reportedModel: null })
          : {}),
      }));
      if (live) {
        try {
          const { client } = await ensureRuntime();
          await client.setModel({ chatId, ...choice });
        } catch (e) {
          const { message } = classifyStartError(e);
          set((s) => {
            // a newer selection owns the chat's choice now: leave it alone
            const superseded = s.chatModels[chatId] !== choice;
            const reverted = {
              chatModels: prev
                ? { ...s.chatModels, [chatId]: prev }
                : omitKey(s.chatModels, chatId),
              modelPending: omitKey(s.modelPending, chatId),
            };
            const error = {
              kind: "unknown",
              message,
              retryable: true,
              at: Date.now(),
            } as const;
            const chats = s.chats[chatId]
              ? withChat(s, chatId, {
                  ...s.chats[chatId]!,
                  error,
                  ...(superseded
                    ? {}
                    : { reportedModel: s.chats[chatId]!.reportedModel ?? prevReported }),
                })
              : s;
            return superseded ? chats : { ...chats, ...reverted };
          });
          return;
        }
      }
      scheduleSave(chatId);
    },
    retry: async () => {
      const chatId = get().activeChatId;
      const chat = chatId ? get().chats[chatId] : null;
      if (!chatId || !chat || isBusy(chat)) return;
      const last = [...chat.turns].reverse().find((t) => t.user);
      if (!last?.user) return;
      set((s) => withChat(s, chatId, { ...s.chats[chatId]!, error: null, state: "idle" }));
      await deliver(chatId, last.user.text, last.user.context);
    },
    detectBinary: async (override) => {
      try {
        const { client } = await ensureRuntime();
        const binary = await client.detectBinary({
          binaryOverride:
            override ?? agentSettingsFrom(useSettingsStore.getState().settings).binaryPath,
        });
        set({ binary });
      } catch {
        set({ binary: null });
      }
    },
    openNewProjectDialog: (opts) =>
      set({ newProjectDialog: { open: true, folder: opts?.folder ?? null } }),
    closeNewProjectDialog: () => set({ newProjectDialog: { open: false, folder: null } }),

    ingest: (chatId, incoming, lastSeq) => {
      if (!get().chats[chatId]) return;
      // `agent.show-turn-changes` off: the card (and its note summary) and the changed-notes
      // row never appear
      const showChanges = useSettingsStore.getState().settings["agent.show-turn-changes"] !== false;
      const events = showChanges
        ? incoming
        : incoming.filter((e) => e.type !== "turn-changes" && e.type !== "session-changes");
      const now = Date.now();
      let finished = false;
      let received = false;
      const refused = refusedModelFrom(events);
      set((s) => {
        const chat = s.chats[chatId];
        if (!chat) return s;
        const note = s.notes[chatId];
        // a receipt turns the message written earlier into a card (and a note entry) right where
        // the CLI took it; a line that is gone (lost, stopped) goes back to waiting in Writer
        const line = (id: string) => (s.written[id]?.chatId === chatId ? s.written[id] : undefined);
        const folded = note ? recordEvents(note, events, now, line) : null;
        finished = folded?.finished ?? false;
        let written = s.written;
        let queued = s.queued;
        for (const e of events) {
          if (e.type !== "message-received" && e.type !== "steer-undelivered") continue;
          if (!line(e.messageId)) continue;
          written = omitKey(written, e.messageId);
          received = received || e.type === "message-received";
          const chip = queued[chatId];
          if (chip?.id !== e.messageId) continue;
          // the tail not written yet (a merge was under way) is all that is left waiting
          if (e.type === "message-received") {
            queued = chip.tail
              ? { ...queued, [chatId]: { ...chip.tail, id: null } }
              : omitKey(queued, chatId);
          } else {
            queued = {
              ...queued,
              [chatId]: { text: chip.text, context: chip.context, id: null },
            };
          }
        }
        return {
          ...withChat(s, chatId, { ...reduceEvents(chat, events, now, line), lastSeq }),
          written,
          queued,
          notes: folded ? { ...s.notes, [chatId]: folded.note } : s.notes,
          cliCatalog: catalogFrom(events) ?? s.cliCatalog,
          modelPending:
            // a process that ended can no longer confirm the pick: the next one starts with it
            s.modelPending[chatId] &&
            (events.some((e) => e.type === "session-ended") ||
              confirmsModel(events, s.chatModels[chatId]))
              ? omitKey(s.modelPending, chatId)
              : s.modelPending,
          chatModels: refused
            ? {
                ...s.chatModels,
                [chatId]: { model: refused.using, effort: s.chatModels[chatId]?.effort ?? null },
              }
            : s.chatModels,
        };
      });
      // Side effects after set(): recover a lost CLI session, save, send the queued message.
      if (get().resuming[chatId]) {
        if (eventErrorTexts(events).some(isSessionMissing)) {
          void recoverMissingSession(chatId);
          return;
        }
        if (
          events.some(
            (e) =>
              e.type === "text-delta" ||
              e.type === "text" ||
              e.type === "tool-call-started" ||
              (e.type === "turn-finished" && !e.isError),
          )
        )
          set((s) => ({ resuming: { ...s.resuming, [chatId]: false } }));
      }
      if (finished) {
        scheduleSave(chatId);
        void maybeAutoTitle(chatId);
      } else if (received) scheduleSave(chatId);
      flushHeld(chatId);
    },

    loadSkills: async (projectPath) => {
      const key = skillsKey(projectPath);
      set((s) => ({
        skills: {
          ...s.skills,
          [key]: { status: "loading", items: s.skills[key]?.items ?? [], error: null },
        },
      }));
      try {
        const { client } = await ensureRuntime();
        const items = await client.listSkills({ projectPath });
        set((s) => ({ skills: { ...s.skills, [key]: { status: "ready", items, error: null } } }));
      } catch (e) {
        set((s) => ({
          skills: {
            ...s.skills,
            [key]: {
              status: "error",
              items: s.skills[key]?.items ?? [],
              error: classifyStartError(e).message,
            },
          },
        }));
      }
    },

    restoreChats: async (root) => {
      if (chatRestore.root === root) return;
      chatRestore.root = root;
      chatRestore.ready = false;
      chatRestore.lastKey = null;
      // The vault's own last project first, so nothing made below starts in another one.
      await loadLastProject(root);
      if (chatRestore.root !== root || useWorkspaceStore.getState().root !== root) return;
      const saved = await chatRestore.io.load(root);
      const restored: { chat: Chat; note: NoteState; model: string | null }[] = [];
      for (const ref of saved?.chats ?? []) {
        if (get().chats[ref.chatId]) continue;
        try {
          const { summary, markdown } = await persistence.history.load(ref.chatId);
          const doc = parseChatNote(markdown);
          const chat = chatFromNote(doc, summary);
          if (!doc.meta.sessionId && ref.sessionId) chat.resumeSessionId = ref.sessionId;
          restored.push({ chat, note: noteStateFromDoc(doc), model: doc.meta.model });
        } catch (e) {
          // the note is gone (or unreadable): the chat drops out of the saved list
          logger.log("debug", "agent", `skipping a chat to restore: ${String(e)}`);
        }
      }
      // the vault changed while the notes loaded: this restore is stale
      if (chatRestore.root !== root || useWorkspaceStore.getState().root !== root) return;
      if (restored.length > 0) {
        const settingsEffort = agentSettingsFrom(useSettingsStore.getState().settings).effort;
        set((s) => {
          const chats = { ...s.chats };
          const notes = { ...s.notes };
          const chatModels = { ...s.chatModels };
          // untouched empty tabs make room, like opening a saved chat
          const keep = s.order.filter((id) => {
            const c = s.chats[id];
            const empty = c && c.turns.length === 0 && !(s.drafts[id]?.text ?? "");
            if (empty) {
              delete chats[id];
              delete notes[id];
            }
            return !empty;
          });
          for (const r of restored) {
            chats[r.chat.chatId] = r.chat;
            notes[r.chat.chatId] = r.note;
            if (r.model) chatModels[r.chat.chatId] = { model: r.model, effort: settingsEffort };
          }
          const order = [...restored.map((r) => r.chat.chatId), ...keep];
          const current = s.activeChatId && keep.includes(s.activeChatId) ? s.activeChatId : null;
          const wanted =
            saved?.activeChatId && restored.some((r) => r.chat.chatId === saved.activeChatId)
              ? saved.activeChatId
              : restored[restored.length - 1]!.chat.chatId;
          return { chats, notes, chatModels, order, activeChatId: current ?? wanted };
        });
      }
      // No chat came back and the first tab is still empty: it starts in the remembered project.
      const first = get().activeChatId ? get().chats[get().activeChatId!] : undefined;
      if (restored.length === 0 && first && isUntouchedChat(first, get().drafts[first.chatId]))
        get().newChat(defaultProjectPath());
      chatRestore.ready = true;
      // what is saved may have lost chats whose notes are gone
      const now = openChatsSnapshot(get());
      if (saved && JSON.stringify(now) !== JSON.stringify(saved)) scheduleOpenChatsSave();
      else chatRestore.lastKey = JSON.stringify(now);
    },

    openSavedChat: async (chatId) => {
      if (get().chats[chatId]) {
        usePaneStore.getState().setOpen(true);
        get().selectChat(chatId);
        return;
      }
      try {
        const { summary, markdown } = await persistence.history.load(chatId);
        const doc = parseChatNote(markdown);
        const chat = chatFromNote(doc, summary);
        const savedModel = doc.meta.model;
        const settingsEffort = agentSettingsFrom(useSettingsStore.getState().settings).effort;
        set((s) => {
          // An untouched empty tab makes room instead of piling up.
          const active = s.activeChatId ? s.chats[s.activeChatId] : null;
          const drop =
            active && active.turns.length === 0 && !(s.drafts[active.chatId]?.text ?? "")
              ? active.chatId
              : null;
          const chats = { ...s.chats, [chatId]: chat };
          const notes = { ...s.notes, [chatId]: noteStateFromDoc(doc) };
          if (drop) {
            delete chats[drop];
            delete notes[drop];
          }
          return {
            chats,
            notes,
            chatModels: savedModel
              ? { ...s.chatModels, [chatId]: { model: savedModel, effort: settingsEffort } }
              : s.chatModels,
            order: [...s.order.filter((id) => id !== drop), chatId],
            activeChatId: chatId,
            view: "chat",
            historyError: null,
            focusComposerTick: s.focusComposerTick + 1,
          };
        });
        usePaneStore.getState().setOpen(true);
      } catch (e) {
        set({ historyError: `Could not open this chat: ${classifyStartError(e).message}` });
      }
    },
  };
});

// An open pane always has a chat tab, however it opened (a command, the saved state, or the
// Settings page: the pane store holds the visibility, this store the tabs). Restored chats make
// room for the empty tab.
const ensureChatTab = (open: boolean) => {
  const s = useAgentStore.getState();
  if (open && s.order.length === 0) s.newChat();
};

// The store's own subscriptions live on the feature's `ctx` (`lib/store-lifecycle.ts`): wired
// while the feature is active, released when it deactivates.
function wireAgentStore(ctx: FeatureContext) {
  ensureChatTab(usePaneStore.getState().open);
  ctx.subscribe(usePaneStore, (s, prev) => {
    if (s.open !== prev.open) ensureChatTab(s.open);
  });

  // Save the open chats on every change to the tab strip or its transcripts (debounced), and on
  // window close, like the editor session.
  ctx.subscribe(useAgentStore, (s, prev) => {
    if (
      s.order !== prev.order ||
      s.activeChatId !== prev.activeChatId ||
      s.notes !== prev.notes ||
      s.chats !== prev.chats
    )
      scheduleOpenChatsSave();
  });
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", flushOpenChats);
    ctx.onDispose(() => window.removeEventListener("beforeunload", flushOpenChats));
  }

  // The last used project follows the active chat (a tab switch, a new chat, a changed project)
  // and is saved per vault once that vault's value was loaded.
  ctx.subscribe(useAgentStore, (s, prev) => {
    const chat = s.activeChatId ? s.chats[s.activeChatId] : undefined;
    const before = prev.activeChatId ? prev.chats[prev.activeChatId] : undefined;
    if (chat && (s.activeChatId !== prev.activeChatId || chat.projectPath !== before?.projectPath))
      if (chat.projectPath !== s.currentProjectPath)
        useAgentStore.setState({ currentProjectPath: chat.projectPath });
    if (s.currentProjectPath !== prev.currentProjectPath) {
      const root = useWorkspaceStore.getState().root;
      if (root && root === lastProject.root)
        void setPreference(lastProjectPreferenceKey(root), s.currentProjectPath);
    }
  });
}

/** The agent feature turns off: what the chats hold is saved (no word is lost, they come back
 *  when it is turned on), the `agent:event` listener and the pump go, the pending timers are
 *  cleared and the store is empty again. Rust has already killed every chat's process. */
function resetAgentStore() {
  flushOpenChats();
  for (const id of Object.keys(useAgentStore.getState().chats)) void persistence.saver().flush(id);
  teardownRuntime();
  runtimeStarting = null;
  chatRestore.reset(chatRestore.io, chatRestore.delayMs);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
}

registerAgentStore({ wire: wireAgentStore, reset: resetAgentStore });
