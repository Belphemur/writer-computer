/**
 * Chat history and persisted-permission commands (spec sections 6.3 and 9, lane 4). Plain
 * request/response calls with their own file, like `project-client.ts`; `client.ts` stays the one
 * module for the chat transport. Types come from the shared contract in `events.ts`.
 */
import {
  callAgent as call,
  type AgentArgs as Args,
  type AgentResult as Result,
} from "@features/agent/web/ipc";
import type { RegenerateOutcome } from "./auto-title";
import type { ChatId, ChatSummary, ReplaySeed } from "./events";

export type ChatFile = Result<"agent_save_chat_file">;

export type ChatAction = Args<"agent_chat_action">["action"];

export type AutoTitleArgs = {
  chatId: ChatId;
  /** `agent.title-model`; blank or `auto` means the cheapest model. */
  titleModel: string | null;
  /** The chat's own model, the fallback when the cheap one is refused. */
  chatModel: string | null;
};

export interface ChatHistoryClient {
  list(args: Args<"agent_list_chats">): Promise<ChatSummary[]>;
  load(chatId: ChatId): Promise<Result<"agent_load_chat">>;
  save(args: Args<"agent_save_chat">): Promise<ChatSummary>;
  action(chatId: ChatId, action: ChatAction, title?: string): Promise<ChatSummary | null>;
  /** One small model call for a title, applied only while the user has not renamed the chat.
   *  `null`: nothing changed (no consented session, a failed call, a user title). */
  autoTitle(args: AutoTitleArgs): Promise<ChatSummary | null>;
  /** "Regenerate title" for any chat, open or not: the note on disk is the input. The user asked,
   *  so a title of their own is replaced too; the result is an automatic title. */
  regenerateTitle(chatId: ChatId, titleModel: string | null): Promise<RegenerateOutcome>;
  /** Capped replay text for a new CLI session when the old one is gone. */
  replay(chatId: ChatId, maxTokens?: number): Promise<ReplaySeed>;
  /** A pasted or browser-dropped image (base64) into the chat folder's hidden `assets/`. */
  saveImage(projectPath: string | null, name: string, dataBase64: string): Promise<ChatFile>;
  /** A Finder-dropped file or folder (absolute path): copied into the same folder, or, already in
   *  the vault, returned to be referenced in place. */
  importFile(projectPath: string | null, sourcePath: string): Promise<ChatFile>;
  permissionRules(projectPath: string | null): Promise<Result<"agent_permission_rules">>;
  removePermissionRule(projectPath: string | null, rule: string): Promise<void>;
}

export const chatHistoryClient: ChatHistoryClient = {
  list: (a) => call("agent_list_chats", a),
  load: (chatId) => call("agent_load_chat", { chatId }),
  save: (a) => call("agent_save_chat", a),
  action: (chatId, action, title) => call("agent_chat_action", { chatId, action, title }),
  autoTitle: (a) => call("agent_auto_title", a),
  regenerateTitle: (chatId, titleModel) => call("agent_regenerate_title", { chatId, titleModel }),
  replay: (chatId, maxTokens) => call("agent_chat_replay", { chatId, maxTokens }),
  saveImage: (projectPath, name, dataBase64) =>
    call("agent_save_chat_file", { projectPath, name, dataBase64 }),
  importFile: (projectPath, sourcePath) =>
    call("agent_import_chat_file", { projectPath, sourcePath }),
  permissionRules: (projectPath) => call("agent_permission_rules", { projectPath }),
  removePermissionRule: (projectPath, rule) =>
    call("agent_remove_permission_rule", { projectPath, rule }).then(() => undefined),
};
