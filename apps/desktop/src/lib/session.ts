import * as tauri from "@/lib/tauri";
import { useSettingsStore } from "@/stores/settings-store";
import type { SessionTabData } from "@/lib/tauri";

interface Session {
  tabs: SessionTabData[];
  activeIndex: number | null;
}

export async function saveSession(
  workspaceRoot: string,
  tabs: SessionTabData[],
  activeIndex: number | null,
): Promise<void> {
  const settings = useSettingsStore.getState().settings;
  if (!settings["workspace.restore-open-files"]) return;

  try {
    await tauri.saveSession(workspaceRoot, tabs, activeIndex);
  } catch {
    // Silently fail — session is best-effort
  }
}

export async function loadSession(workspaceRoot: string): Promise<Session | null> {
  const settings = useSettingsStore.getState().settings;
  if (!settings["workspace.restore-open-files"]) return null;

  try {
    const data = await tauri.loadSession(workspaceRoot);
    if (!data || !data.tabs) return null;
    return {
      tabs: data.tabs,
      activeIndex: data.active_index ?? null,
    };
  } catch {
    return null;
  }
}

/** The agent pane's open chats of a workspace (same file and mechanism as the editor tabs). */
export interface AgentChatsSession {
  chats: { chatId: string; sessionId: string | null }[];
  activeChatId: string | null;
}

export async function saveAgentChats(workspaceRoot: string, s: AgentChatsSession): Promise<void> {
  if (useSettingsStore.getState().settings["agent.restore-chats"] === false) return;
  try {
    await tauri.saveAgentChats(
      workspaceRoot,
      s.chats.map((c) => ({ chat_id: c.chatId, session_id: c.sessionId })),
      s.activeChatId,
    );
  } catch {
    // best-effort, like the editor session
  }
}

export async function loadAgentChats(workspaceRoot: string): Promise<AgentChatsSession | null> {
  if (useSettingsStore.getState().settings["agent.restore-chats"] === false) return null;
  try {
    const data = (await tauri.loadSession(workspaceRoot))?.agent_chats;
    if (!data?.chats) return null;
    return {
      chats: data.chats.map((c) => ({ chatId: c.chat_id, sessionId: c.session_id ?? null })),
      activeChatId: data.active_chat_id ?? null,
    };
  } catch {
    return null;
  }
}
