// The typed client of the agent's Rust half: every command goes through `featureInvoke` (route
// `plugin:agent|<command>`, manifest guard), the event through `featureEvents`. This is the ONLY
// module that imports the generated `bindings.ts` (tauri-specta, rewritten by
// `WRITER_UPDATE_BINDINGS=1 cargo test bindings`), and only for types, so the generated runtime
// stays out of the app.
//
// `AgentCommands` is the argument object of each command as the pane uses them (argument names are
// the one thing the generated functions do not keep as a type) and its result, which is always the
// generated one (`Ret`): no wire result is described by hand. The pane's own types
// (`lib/agent/events.ts`) re-export the generated ones and add the UI-only fields (`ContextRef.label`).
// `tests/agent-ipc.test.ts` ties the command list of the manifest, the generated bindings and this
// map together.
import { featureEvents } from "@/lib/features/events";
import { featureInvoke } from "@/lib/features/ipc";
import manifest from "../feature.json";
import type {
  AgentEventEnvelope,
  AgentSettings,
  ChatActionName,
  ContextRef,
  Effort,
  MemoryScope,
  PermissionDecision,
  PermissionPersist,
  ProjectUpdate,
  commands,
} from "./bindings";

export type * from "./bindings";

type Gen = typeof commands;
type Camel<S extends string> = S extends `${infer A}_${infer B}`
  ? `${A}${Capitalize<Camel<B>>}`
  : S;
/** Result of a command, from the generated function of the same name. */
type Ret<K extends string> = Awaited<ReturnType<Gen[Camel<K> & keyof Gen]>>;

/** A Rust `Option<T>` argument: may be left out or null. */
type Opt<T> = T | null | undefined;

type Command<K extends string, A extends object> = { args: A; result: Ret<K> };

export interface AgentCommands {
  agent_detect_binary: Command<"agent_detect_binary", { binaryOverride?: Opt<string> }>;
  agent_start: Command<
    "agent_start",
    {
      chatId: string;
      /** Vault-relative project folder, or null for the vault root. */
      projectPath: string | null;
      resumeSessionId: string | null;
      settings: AgentSettings;
      /** The project's `AGENTS.md` text is injected through this. */
      appendSystemPrompt: string | null;
    }
  >;
  agent_send: Command<
    "agent_send",
    { chatId: string; messageId: string; text: string; context: ContextRef[] }
  >;
  agent_cancel: Command<"agent_cancel", { chatId: string }>;
  agent_permission: Command<
    "agent_permission",
    {
      chatId: string;
      requestId: string;
      decision: PermissionDecision;
      persist?: Opt<PermissionPersist>;
      /** Shown to the model on deny. */
      message?: Opt<string>;
    }
  >;
  agent_set_permission_mode: Command<
    "agent_set_permission_mode",
    { chatId: string; mode: AgentSettings["permissionMode"] }
  >;
  agent_set_model: Command<
    "agent_set_model",
    { chatId: string; model: string | null; effort: Effort | null }
  >;
  agent_close: Command<"agent_close", { chatId: string }>;
  agent_resume: Command<"agent_resume", { chatId: string; sessionId: string }>;
  /** Events with seq > afterSeq still buffered (bounded ring), plus the current state. */
  agent_snapshot: Command<"agent_snapshot", { chatId: string; afterSeq: number }>;
  /** The diffs of a finished turn; `null` once the in-memory snapshot is gone (app restart). */
  agent_turn_changes: Command<"agent_turn_changes", { chatId: string; turnId: string }>;
  /** Undo: restore the pre-turn content; one outcome per path; `null` when the snapshot is gone. */
  agent_revert_changes: Command<
    "agent_revert_changes",
    { chatId: string; turnId: string; paths: string[] }
  >;
  agent_list_skills: Command<"agent_list_skills", { projectPath: string | null }>;
  /** The vault memory and, with a project, that project's (`.writer/memory/`, `<project>/.memory/`). */
  agent_memory_list: Command<"agent_memory_list", { projectPath: string | null }>;
  agent_memory_delete: Command<
    "agent_memory_delete",
    { scope: MemoryScope; projectPath: string | null; name: string }
  >;
  agent_memory_forget_all: Command<
    "agent_memory_forget_all",
    { scope: MemoryScope; projectPath: string | null }
  >;
  /** The user-clicked import of Claude Code's own memory for this vault and its projects. */
  agent_memory_import_claude: Command<"agent_memory_import_claude", Record<string, never>>;
  /** `all: true` lists every project's chats; `query` filters by title and first user message. */
  agent_list_chats: Command<
    "agent_list_chats",
    {
      projectPath: string | null;
      includeArchived?: Opt<boolean>;
      all?: Opt<boolean>;
      query?: Opt<string>;
    }
  >;
  agent_load_chat: Command<"agent_load_chat", { chatId: string }>;
  agent_save_chat: Command<
    "agent_save_chat",
    { chatId: string; markdown: string; titleHint?: Opt<string> }
  >;
  agent_chat_action: Command<
    "agent_chat_action",
    { chatId: string; action: ChatActionName; title?: Opt<string> }
  >;
  agent_auto_title: Command<
    "agent_auto_title",
    { chatId: string; titleModel?: Opt<string>; chatModel?: Opt<string> }
  >;
  agent_regenerate_title: Command<
    "agent_regenerate_title",
    { chatId: string; titleModel?: Opt<string> }
  >;
  agent_chat_replay: Command<"agent_chat_replay", { chatId: string; maxTokens?: Opt<number> }>;
  /** A pasted or browser-dropped image (base64) into the chat's hidden `assets/` folder. */
  agent_save_chat_image: Command<
    "agent_save_chat_image",
    { projectPath: string | null; name: string; dataBase64: string }
  >;
  /** A Finder-dropped image file (absolute path), copied into the chat's `assets/` folder. */
  agent_import_chat_image_file: Command<
    "agent_import_chat_image_file",
    { projectPath: string | null; sourcePath: string }
  >;
  agent_permission_rules: Command<"agent_permission_rules", { projectPath: string | null }>;
  agent_remove_permission_rule: Command<
    "agent_remove_permission_rule",
    { projectPath: string | null; rule: string }
  >;
  agent_list_projects: Command<"agent_list_projects", { includeArchived?: Opt<boolean> }>;
  agent_read_project: Command<"agent_read_project", { path: string }>;
  agent_create_project: Command<
    "agent_create_project",
    {
      /** Folder name; created under `parent` (default: `Projects`). */
      name: string;
      parent?: Opt<string>;
      description: string;
      inclusions: string[];
      /** Seeds `AGENTS.md`. Empty means the short template. */
      instructions: string;
    }
  >;
  agent_make_project: Command<
    "agent_make_project",
    {
      path: string;
      createAgentsMd: boolean;
      instructions?: Opt<string>;
      description?: Opt<string>;
      inclusions?: Opt<string[]>;
    }
  >;
  agent_update_project: Command<"agent_update_project", { path: string; update: ProjectUpdate }>;
  agent_archive_project: Command<"agent_archive_project", { path: string; archived: boolean }>;
  agent_inspect_folder: Command<"agent_inspect_folder", { path: string }>;
  agent_project_manifest: Command<"agent_project_manifest", { path: string }>;
}

/** `agentCommand("agent_start", { ... })` -> `invoke("plugin:agent|agent_start", ...)`. */
export const agentCommand = featureInvoke<AgentCommands>(manifest.id, manifest.rust.commands);

export type AgentArgs<K extends keyof AgentCommands> = AgentCommands[K]["args"];
export type AgentResult<K extends keyof AgentCommands> = AgentCommands[K]["result"];

/** The call a client module makes with a command name chosen by type (`featureInvoke`'s own
 *  signature cannot take a generic key). */
export const callAgent = <K extends keyof AgentCommands>(
  command: K,
  args: AgentArgs<K>,
): Promise<AgentResult<K>> =>
  (agentCommand as (c: K, a: AgentArgs<K>) => Promise<AgentResult<K>>)(command, args);

/** The one event: every chat event of a window, in order (`seq` per chat). */
export const agentEvents = featureEvents<{ event: AgentEventEnvelope }>(manifest.id);
