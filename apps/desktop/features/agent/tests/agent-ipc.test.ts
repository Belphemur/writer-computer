// The agent's IPC after the move into a plugin: every command is called as
// `plugin:agent|<command>` (the "alias test per moved command" of the spec's risk table), the
// manifest, the generated bindings and the typed client name the same commands, and the event
// follows the `<id>:<name>` rule.
// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "../feature.json";
import {
  agentCommand,
  agentEvents,
  type AgentArgs,
  type AgentCommands,
  type AgentSettings,
} from "../web/ipc";

afterEach(() => clearMocks());

const call = agentCommand as unknown as (c: string, a?: object) => Promise<unknown>;

// The agent is the one client that keeps a hand-typed args object per command (`AgentCommands`:
// every call site passes an object). Each is called here with every argument the map names, and
// `describeFeatureIpc` holds those names to the generated bindings, so a snake_case or renamed key
// cannot pass. `FULL` is typed by the map: a key it does not have is a type error.
const settings = {} as AgentSettings;
const FULL: { [K in keyof AgentCommands]: AgentArgs<K> } = {
  agent_detect_binary: { binaryOverride: null },
  agent_start: {
    chatId: "c",
    projectPath: null,
    resumeSessionId: null,
    settings,
    appendSystemPrompt: null,
  },
  agent_send: { chatId: "c", messageId: "m", text: "t", context: [] },
  agent_steer: { chatId: "c", messageId: "m", text: "t", context: [] },
  agent_queue: { chatId: "c", messageId: "m", text: "t", context: [] },
  agent_unqueue: { chatId: "c", messageId: "m" },
  agent_cancel: { chatId: "c" },
  agent_permission: {
    chatId: "c",
    requestId: "r",
    decision: "allow",
    persist: null,
    rules: null,
    message: null,
  },
  agent_answer_question: { chatId: "c", requestId: "r", answers: null },
  agent_set_permission_mode: { chatId: "c", mode: "manual" },
  agent_set_model: { chatId: "c", model: null, effort: null },
  agent_reload: { chatId: "c" },
  agent_close: { chatId: "c" },
  agent_resume: { chatId: "c", sessionId: "s" },
  agent_snapshot: { chatId: "c", afterSeq: 0 },
  agent_turn_changes: { chatId: "c", turnId: "t" },
  agent_session_changes: { chatId: "c" },
  agent_revert_changes: { chatId: "c", turnId: "t", paths: [] },
  agent_list_skills: { projectPath: null },
  agent_memory_list: { projectPath: null },
  agent_memory_delete: { scope: "vault", projectPath: null, name: "n" },
  agent_memory_forget_all: { scope: "vault", projectPath: null },
  agent_memory_import_claude: {},
  agent_list_chats: { projectPath: null, includeArchived: null, all: null, query: null },
  agent_load_chat: { chatId: "c" },
  agent_save_chat: { chatId: "c", markdown: "m", titleHint: null },
  agent_chat_action: { chatId: "c", action: "pin", title: null },
  agent_auto_title: { chatId: "c", titleModel: null, chatModel: null },
  agent_regenerate_title: { chatId: "c", titleModel: null },
  agent_chat_replay: { chatId: "c", maxTokens: null },
  agent_save_chat_file: { projectPath: null, name: "n", dataBase64: "" },
  agent_import_chat_file: { projectPath: null, sourcePath: "/x" },
  agent_permission_rules: { projectPath: null },
  agent_remove_permission_rule: { projectPath: null, rule: "r" },
  agent_list_projects: { includeArchived: null },
  agent_read_project: { path: "p" },
  agent_create_project: {
    name: "n",
    parent: null,
    description: "",
    inclusions: [],
    instructions: "",
  },
  agent_make_project: {
    path: "p",
    createAgentsMd: true,
    instructions: null,
    description: null,
    inclusions: null,
  },
  agent_update_project: { path: "p", update: {} },
  agent_archive_project: { path: "p", archived: true },
  agent_inspect_folder: { path: "p" },
  agent_project_manifest: { path: "p" },
};

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: Object.fromEntries(
    Object.entries(FULL).map(([name, args]) => [name, { call: () => call(name, args), args }]),
  ),
});

describe("the agent's client", () => {
  it("a command the manifest does not declare never reaches Rust", async () => {
    let reached = false;
    mockIPC(() => void (reached = true));
    await expect(call("agent_context_preview", {})).rejects.toThrow(/declares no command/);
    expect(reached).toBe(false);
  });
});

describe("the agent's event", () => {
  it("is named agent:event, as the manifest says", () => {
    expect(manifest.rust.events).toEqual([agentEvents.name("event")]);
    expect(agentEvents.name("event")).toBe("agent:event");
  });
});
