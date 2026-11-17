/**
 * Chat history and persisted-permission commands (spec sections 6.3 and 9, lane 4). Plain
 * request/response calls with their own file, like `project-client.ts`; `client.ts` stays the one
 * module for the chat transport. Types come from the shared contract in `events.ts`.
 */
import { invoke } from "@tauri-apps/api/core";
import type { RegenerateOutcome } from "./auto-title";
import type { AgentCommandMap, ChatId, ChatSummary } from "./events";

type Args<K extends keyof AgentCommandMap> = AgentCommandMap[K][0];
type Result<K extends keyof AgentCommandMap> = AgentCommandMap[K][1];

export type ChatAction = Args<"agent_chat_action">["action"];

export type ReplaySeed = {
  text: string;
  turnsIncluded: number;
  turnsTotal: number;
  estimatedTokens: number;
};

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
  permissionRules(projectPath: string | null): Promise<Result<"agent_permission_rules">>;
  removePermissionRule(projectPath: string | null, rule: string): Promise<void>;
}

export const chatHistoryClient: ChatHistoryClient = {
  list: (a) => invoke("agent_list_chats", a),
  load: (chatId) => invoke("agent_load_chat", { chatId }),
  save: (a) => invoke("agent_save_chat", a),
  action: (chatId, action, title) => invoke("agent_chat_action", { chatId, action, title }),
  autoTitle: (a) => invoke("agent_auto_title", a),
  regenerateTitle: (chatId, titleModel) => invoke("agent_regenerate_title", { chatId, titleModel }),
  replay: (chatId, maxTokens) => invoke("agent_chat_replay", { chatId, maxTokens }),
  permissionRules: (projectPath) => invoke("agent_permission_rules", { projectPath }),
  removePermissionRule: (projectPath, rule) =>
    invoke("agent_remove_permission_rule", { projectPath, rule }),
};
