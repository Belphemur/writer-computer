// The typed client of the agent's Rust half: every command goes through `featureInvoke` (route
// `plugin:agent|<command>`, manifest guard), the event through `featureEvents`. This is the ONLY
// module that imports the generated `bindings.ts` (tauri-specta, rewritten by
// `WRITER_UPDATE_BINDINGS=1 cargo test bindings`), and only for types, so the generated runtime
// stays out of the app.
//
// `AgentCommands` is the argument object and result of each command as the pane uses them. The
// commands of the hand-written contract in `lib/agent/events.ts` (`AgentCommandMap`) and the few
// the clients type themselves keep their UI types; every other result is the generated one. Where
// a UI type differs from the wire the difference is real and listed here, to be removed when the UI
// types move onto the generated ones: `ChatSummary.preview` is nullable and `titleSource` optional
// on the wire, `AgentBinaryInfo` has optional fields the UI treats as required, `ContextRef.label`
// is UI-only. `tests/agent-ipc.test.ts` ties the command list of the manifest, the generated
// bindings and this map together.
import type { RegenerateOutcome } from "@/lib/agent/auto-title";
import type { AgentCommandMap, AgentEventEnvelope, ChatSummary } from "@/lib/agent/events";
import type { ManifestPreview } from "@/lib/agent/project-client";
import { featureEvents } from "@/lib/features/events";
import { featureInvoke } from "@/lib/features/ipc";
import manifest from "../feature.json";
import type { ProjectUpdate, commands } from "./bindings";

export type * from "./bindings";

type Gen = typeof commands;
type Camel<S extends string> = S extends `${infer A}_${infer B}`
  ? `${A}${Capitalize<Camel<B>>}`
  : S;
/** Result of a command, from the generated function of the same name. */
type Ret<K extends string> = Awaited<ReturnType<Gen[Camel<K> & keyof Gen]>>;

/** A Rust `Option<T>` argument: may be left out or null. */
type Opt<T> = T | null | undefined;

type FromMap<K extends keyof AgentCommandMap> = {
  args: AgentCommandMap[K][0];
  result: AgentCommandMap[K][1];
};
/** A command the hand contract does not describe: the generated result. */
type Generated<K extends string, A extends object> = { args: A; result: Ret<K> };

export interface AgentCommands {
  agent_detect_binary: FromMap<"agent_detect_binary">;
  agent_start: FromMap<"agent_start">;
  agent_send: FromMap<"agent_send">;
  agent_cancel: FromMap<"agent_cancel">;
  agent_permission: FromMap<"agent_permission">;
  agent_set_permission_mode: FromMap<"agent_set_permission_mode">;
  agent_set_model: FromMap<"agent_set_model">;
  agent_close: FromMap<"agent_close">;
  agent_resume: Generated<"agent_resume", { chatId: string; sessionId: string }>;
  agent_snapshot: FromMap<"agent_snapshot">;
  agent_turn_changes: FromMap<"agent_turn_changes">;
  agent_revert_changes: FromMap<"agent_revert_changes">;
  agent_list_skills: FromMap<"agent_list_skills">;
  agent_list_chats: FromMap<"agent_list_chats">;
  agent_load_chat: FromMap<"agent_load_chat">;
  agent_save_chat: FromMap<"agent_save_chat">;
  agent_chat_action: FromMap<"agent_chat_action">;
  agent_auto_title: {
    args: { chatId: string; titleModel?: Opt<string>; chatModel?: Opt<string> };
    result: ChatSummary | null;
  };
  agent_regenerate_title: {
    args: { chatId: string; titleModel?: Opt<string> };
    result: RegenerateOutcome;
  };
  agent_chat_replay: Generated<"agent_chat_replay", { chatId: string; maxTokens?: Opt<number> }>;
  agent_permission_rules: FromMap<"agent_permission_rules">;
  agent_remove_permission_rule: FromMap<"agent_remove_permission_rule">;
  agent_list_projects: Generated<"agent_list_projects", { includeArchived?: Opt<boolean> }>;
  agent_read_project: Generated<"agent_read_project", { path: string }>;
  agent_create_project: Generated<
    "agent_create_project",
    {
      name: string;
      parent?: Opt<string>;
      description: string;
      inclusions: string[];
      instructions: string;
    }
  >;
  agent_make_project: Generated<
    "agent_make_project",
    {
      path: string;
      createAgentsMd: boolean;
      instructions?: Opt<string>;
      description?: Opt<string>;
      inclusions?: Opt<string[]>;
    }
  >;
  agent_update_project: Generated<"agent_update_project", { path: string; update: ProjectUpdate }>;
  agent_archive_project: Generated<"agent_archive_project", { path: string; archived: boolean }>;
  agent_inspect_folder: Generated<"agent_inspect_folder", { path: string }>;
  agent_project_manifest: { args: { path: string }; result: ManifestPreview };
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
