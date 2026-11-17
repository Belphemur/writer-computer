import { create } from "zustand";
import {
  createEventPump,
  createTauriAgentClient,
  type AgentClient,
  type EventPump,
  type Unsubscribe,
} from "@/lib/agent/client";
import { agentSettingsFrom, type ChatModelChoice } from "@/lib/agent/agent-settings";
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
} from "@/lib/agent/events";
import {
  appendUserTurn,
  createChat,
  failSend,
  isBusy,
  isComposerDisabled,
  markCancelling,
  reduceEvents,
} from "@/lib/agent/reduce";
import type { Chat } from "@/lib/agent/transcript";
import {
  buildNote,
  dropLastExchange,
  eventErrorTexts,
  isSessionMissing,
  newNoteState,
  noteStateFromDoc,
  recordEvents,
  recordSend,
  type NoteState,
} from "@/lib/agent/chat-persist";
import { applyTitleSummary, shouldAutoTitle, type RegenerateOutcome } from "@/lib/agent/auto-title";
import { buildPrompt } from "@/lib/agent/context-text";
import { mentionsActiveNote } from "@/lib/agent/mentions";
import { createRefIo, prepareRefs, type RefIo } from "@/lib/agent/ref-resolve";
import { chatFromNote } from "@/lib/agent/chat-from-note";
import { parseChatNote } from "@/lib/agent/chat-note";
import { createChatSaver, type ChatSaver } from "@/lib/agent/chat-saver";
import { chatHistoryClient, type ChatHistoryClient } from "@/lib/agent/chat-history-client";
import { reloadChatNoteIfOpen } from "@/lib/agent/chat-editor-sync";
import { logger } from "@/lib/logger";
import { useEditorStore } from "@/stores/editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export const AGENT_PANE_WIDTH_SETTING = "agent.pane-width";
export const AGENT_PANE_MIN_WIDTH = 320;
/** The `agent.pane-width` setting's range (shared/settings.schema.json). */
export const AGENT_PANE_MAX_WIDTH = 900;
export const AGENT_PANE_DEFAULT_WIDTH = 420;

/** Skills on disk per project (`""` = the vault root): what the `/` menu lists before and next to the CLI's own list. */
export type SkillsEntry = {
  status: "loading" | "ready" | "error";
  items: DiskSkill[];
  error: string | null;
};
export const skillsKey = (projectPath: string | null) => projectPath ?? "";

export type AgentView = "chat" | "history" | "project";
export type AgentBackend = "tauri" | "mock";

/** What the user typed and attached but has not sent; kept per chat so tab switches lose nothing. */
export type Draft = {
  text: string;
  /** Explicit `@` mentions shown as chips. */
  mentions: ContextRef[];
  /** False once the user removed the active-note chip for this chat. */
  activeNote: boolean;
};

export type QueuedMessage = { text: string; context: ContextRef[] };

const EMPTY_DRAFT: Draft = { text: "", mentions: [], activeNote: true };

interface AgentState {
  chats: Record<ChatId, Chat>;
  /** Tab order. */
  order: ChatId[];
  activeChatId: ChatId | null;
  drafts: Record<ChatId, Draft>;
  queued: Record<ChatId, QueuedMessage>;
  /** Per-chat permission mode chosen in the composer; the setting is the default. */
  modes: Record<ChatId, AgentPermissionMode>;
  /** Per-chat model (and effort) chosen in the composer; null model is "Agent default". Absent:
   *  the `agent.model` / `agent.effort` settings. Also restored from a saved chat's note. */
  chatModels: Record<ChatId, ChatModelChoice>;
  /** What each chat's note holds (see `chat-persist.ts`); saved after a send and a turn end. */
  notes: Record<ChatId, NoteState>;
  /** Chats that started with `--resume`: a "session not found" answer triggers the replay path. */
  resuming: Record<ChatId, boolean>;
  skills: Record<string, SkillsEntry>;
  /** The CLI's last reported lists in this window (it reports only after a first message). */
  cliCatalog: { slashCommands: string[]; skills: string[] } | null;
  /** Why the last attempt to open a saved chat failed. */
  historyError: string | null;
  paneOpen: boolean;
  paneWidth: number;
  view: AgentView;
  backend: AgentBackend;
  binary: AgentBinaryInfo | null;
  /** Project (vault-relative folder) new chats start in; Lane 3 sets it from the switcher. */
  currentProjectPath: string | null;
  /** Bumped to ask the composer to take focus. */
  focusComposerTick: number;
  /** Lane 3 renders the dialog from this; lane 2 only opens and closes it. */
  newProjectDialog: { open: boolean; folder: string | null };

  openPane: () => void;
  closePane: () => void;
  togglePane: () => void;
  /** `persist: false` while dragging; call `persistPaneWidth` when the drag ends. */
  setPaneWidth: (width: number, persist?: boolean) => void;
  persistPaneWidth: () => void;
  /** Adopts the `agent.pane-width` setting (startup, and when Settings changes it). */
  syncPaneWidth: (value: unknown) => void;
  /** Opens a saved chat in a tab: transcript from its note, resumes its CLI session on send. */
  openSavedChat: (chatId: ChatId) => Promise<void>;
  /** Reads the skills on disk for a project (cached entry stays visible while it refreshes). */
  loadSkills: (projectPath: string | null) => Promise<void>;
  /** Switches the active chat's model (and effort): live when a session runs (`set_model`), else
   *  at the next start. `effort` undefined keeps the current one. */
  setChatModel: (model: string | null, effort?: ChatModelChoice["effort"]) => Promise<void>;
  setView: (view: AgentView) => void;
  setBackend: (backend: AgentBackend) => void;
  newChat: (projectPath?: string | null) => ChatId;
  closeChat: (chatId: ChatId) => void;
  selectChat: (chatId: ChatId) => void;
  cycleChat: (delta: 1 | -1) => void;
  setDraft: (chatId: ChatId, patch: Partial<Draft>) => void;
  sendMessage: (text: string) => Promise<void>;
  removeQueued: (chatId: ChatId) => void;
  stop: () => Promise<void>;
  decidePermission: (
    requestId: string,
    decision: "allow" | "deny",
    persist?: PermissionPersist,
    message?: string,
  ) => Promise<void>;
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
    const { createMockAgentClient, loadGoldens } = await import("@/lib/agent/mock-client");
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
  teardownRuntime();
  testClient = client ? { client, schedule } : null;
}

// ---------------------------------------------------------------------------------------------
// Helpers

const clampWidth = (w: number) =>
  Math.max(AGENT_PANE_MIN_WIDTH, Math.min(AGENT_PANE_MAX_WIDTH, Math.round(w)));

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

/** The slash commands and skills of the newest `session-started` in a batch. */
function catalogFrom(events: readonly AgentEvent[]): AgentState["cliCatalog"] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "session-started")
      return { slashCommands: e.slashCommands, skills: e.skills ?? [] };
  }
  return null;
}

function withChat(s: AgentState, id: ChatId, next: Chat): Pick<AgentState, "chats"> {
  return { chats: { ...s.chats, [id]: next } };
}

// ---------------------------------------------------------------------------------------------
// Persistence glue: the note is built from the store's state and written by the debounced saver

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
}) {
  persistence.instance = null;
  persistence.titleAttempts = new Set();
  persistence.history = opts.history ?? chatHistoryClient;
  persistence.delayMs = opts.delayMs ?? 500;
  persistence.reload = opts.reload ?? reloadChatNoteIfOpen;
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

/** `agent.title-model`, `null` when unset (Rust then picks the cheapest model). */
function titleModelSetting(): string | null {
  const m = useSettingsStore.getState().settings["agent.title-model"];
  return typeof m === "string" ? m : null;
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
  /** Writes the user card and talks to the backend; the caller checked the chat is free.
   *  `replay`: start a fresh session seeded with the note's text (the CLI lost the old one). */
  async function deliver(
    chatId: ChatId,
    text: string,
    context: ContextRef[],
    opts: { replay?: boolean } = {},
  ) {
    const before = get().chats[chatId];
    if (!before) return;
    const live = before.session !== null && before.state !== "ended" && before.state !== "error";
    const messageId = newId();
    const resumeSessionId = opts.replay
      ? null
      : (before.session?.sessionId ?? before.resumeSessionId);
    const now = Date.now();
    set((s) => {
      const chat = appendUserTurn(s.chats[chatId]!, { messageId, text, context }, now, live);
      const note = s.notes[chatId];
      return {
        ...withChat(s, chatId, chat),
        notes: note
          ? { ...s.notes, [chatId]: recordSend(note, { messageId, text, context, ts: now }) }
          : s.notes,
        resuming: { ...s.resuming, [chatId]: !live && resumeSessionId !== null },
      };
    });
    scheduleSave(chatId);
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
      let sendText = buildPrompt({
        text,
        refs,
        cwd: before.projectPath,
        skills: knownSkillNames(get(), before),
      });
      if (opts.replay) {
        const seed = await persistence.history.replay(chatId);
        sendText = `${seed.text}\n\n${sendText}`;
      }
      await client.send({ chatId, messageId, text: sendText, context: refs });
    } catch (e) {
      const { kind, message } = classifyStartError(e);
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

  return {
    chats: {},
    order: [],
    activeChatId: null,
    drafts: {},
    queued: {},
    modes: {},
    chatModels: {},
    notes: {},
    resuming: {},
    historyError: null,
    skills: {},
    cliCatalog: null,
    paneOpen: false,
    paneWidth: AGENT_PANE_DEFAULT_WIDTH,
    view: "chat",
    backend: "tauri",
    binary: null,
    currentProjectPath: null,
    focusComposerTick: 0,
    newProjectDialog: { open: false, folder: null },

    openPane: () => {
      if (get().order.length === 0) get().newChat();
      set((s) => ({ paneOpen: true, view: "chat", focusComposerTick: s.focusComposerTick + 1 }));
    },
    closePane: () => set({ paneOpen: false }),
    togglePane: () => (get().paneOpen ? get().closePane() : get().openPane()),
    setPaneWidth: (width, persist = true) => {
      const next = clampWidth(width);
      if (next === get().paneWidth) return;
      set({ paneWidth: next });
      if (persist) get().persistPaneWidth();
    },
    persistPaneWidth: () => {
      void useSettingsStore
        .getState()
        .setSetting(AGENT_PANE_WIDTH_SETTING, get().paneWidth)
        .catch((e: unknown) => logger.warn("agent", `could not save the pane width: ${String(e)}`));
    },
    syncPaneWidth: (value) => {
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        clampWidth(value) !== get().paneWidth
      )
        set({ paneWidth: clampWidth(value) });
    },
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
        drafts: {},
        modes: {},
        chatModels: {},
        notes: {},
        resuming: {},
        skills: {},
        cliCatalog: null,
        binary: null,
      });
      get().newChat();
    },

    newChat: (projectPath) => {
      const chatId = newId();
      const chat = createChat(chatId, { projectPath: projectPath ?? get().currentProjectPath });
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
        const { [chatId]: _m, ...modes } = s.modes;
        const { [chatId]: _cm, ...chatModels } = s.chatModels;
        const { [chatId]: _n, ...notes } = s.notes;
        const { [chatId]: _r, ...resuming } = s.resuming;
        const idx = s.order.indexOf(chatId);
        const activeChatId =
          s.activeChatId === chatId
            ? (order[Math.min(idx, order.length - 1)] ?? null)
            : s.activeChatId;
        return { chats, order, drafts, queued, modes, chatModels, notes, resuming, activeChatId };
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
      set((s) => ({
        drafts: { ...s.drafts, [chatId]: { ...(s.drafts[chatId] ?? EMPTY_DRAFT), ...patch } },
      })),

    sendMessage: async (rawText) => {
      const chatId = get().activeChatId;
      const chat = chatId ? get().chats[chatId] : null;
      const text = rawText.trim();
      if (!chatId || !chat || !text || isComposerDisabled(chat)) return;
      const context = contextForSend(get().drafts[chatId] ?? EMPTY_DRAFT, text);
      // Clear the draft now; the mentions are consumed, the active-note choice persists.
      get().setDraft(chatId, { text: "", mentions: [] });
      if (isBusy(chat)) {
        set((s) => {
          const q = s.queued[chatId];
          return {
            queued: {
              ...s.queued,
              [chatId]: q
                ? { text: `${q.text}\n\n${text}`, context: [...q.context, ...context] }
                : { text, context },
            },
          };
        });
        return;
      }
      await deliver(chatId, text, context);
    },
    removeQueued: (chatId) =>
      set((s) => {
        const { [chatId]: _q, ...queued } = s.queued;
        return { queued };
      }),
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
    decidePermission: async (requestId, decision, persist, message) => {
      const chatId = get().activeChatId;
      if (!chatId) return;
      try {
        const { client } = await ensureRuntime();
        await client.permission({ chatId, requestId, decision, persist, message });
      } catch (e) {
        // Already resolved elsewhere (cancelled by the CLI): the event will clear the card.
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
      if (chat?.session && chat.state !== "ended") {
        try {
          const { client } = await ensureRuntime();
          await client.setModel({ chatId, ...choice });
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
      set((s) => ({ chatModels: { ...s.chatModels, [chatId]: choice } }));
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
          override: override ?? agentSettingsFrom(useSettingsStore.getState().settings).binaryPath,
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
      // `agent.show-turn-changes` off: the card (and its note summary) never appears
      const showChanges = useSettingsStore.getState().settings["agent.show-turn-changes"] !== false;
      const events = showChanges ? incoming : incoming.filter((e) => e.type !== "turn-changes");
      const now = Date.now();
      let finished = false;
      const refused = refusedModelFrom(events);
      set((s) => {
        const chat = s.chats[chatId];
        if (!chat) return s;
        const note = s.notes[chatId];
        const folded = note ? recordEvents(note, events, now) : null;
        finished = folded?.finished ?? false;
        return {
          ...withChat(s, chatId, { ...reduceEvents(chat, events, now), lastSeq }),
          notes: folded ? { ...s.notes, [chatId]: folded.note } : s.notes,
          cliCatalog: catalogFrom(events) ?? s.cliCatalog,
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
      }
      const after = get().chats[chatId];
      const queued = get().queued[chatId];
      if (after && queued && after.state === "idle") {
        get().removeQueued(chatId);
        void deliver(chatId, queued.text, queued.context);
      }
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

    openSavedChat: async (chatId) => {
      if (get().chats[chatId]) {
        set({ paneOpen: true });
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
            paneOpen: true,
            view: "chat",
            historyError: null,
            focusComposerTick: s.focusComposerTick + 1,
          };
        });
      } catch (e) {
        set({ historyError: `Could not open this chat: ${classifyStartError(e).message}` });
      }
    },
  };
});
