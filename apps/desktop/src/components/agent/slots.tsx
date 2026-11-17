/**
 * SLOTS other lanes fill (documented seam; the pane imports only from this file).
 *
 * - `ProjectSwitcherSlot` (lane 3, filled): the header's project label and picker
 *   (`project-switcher.tsx`); it receives the active chat's project (vault-relative folder or null for
 *   the vault root) and switches with `useAgentStore.getState().currentProjectPath` /
 *   `startNewAgentChat(path)` from `@/hooks/agent-api`.
 * - `ProjectHomeSlot` (lane 3, filled): the in-pane project home (`view === "project"`),
 *   `project-home.tsx`; its `recentChats` prop is lane 4's slot for the project's saved chats.
 * - `HistorySlot` (lane 4, filled): the in-pane chat history (`view === "history"`), lane 4's
 *   `HistoryPane`; opening a chat goes through the store's `openSavedChat`.
 *
 * The new-project dialog (`new-project-dialog.tsx`, lane 3) is mounted once in `App.tsx` and renders
 * from the store's `newProjectDialog` state (set by `openNewProjectDialog`).
 */
import { openSavedAgentChat } from "@/hooks/agent-api";
import {
  useActiveChatId,
  useAgentChat,
  useAgentProjectPath,
  useHistoryError,
} from "@/hooks/use-agent";
import { HistoryPane } from "./history-list";
import { ProjectRecentChats } from "./project-recent-chats";
import { ProjectHome } from "./project-home";
import { ProjectSwitcher } from "./project-switcher";

export function ProjectSwitcherSlot({ projectPath }: { projectPath: string | null }) {
  return <ProjectSwitcher projectPath={projectPath} />;
}

/** The project of the active chat, else the default for new chats. */
export function ProjectHomeSlot() {
  const activeId = useActiveChatId();
  const chat = useAgentChat(activeId);
  const fallback = useAgentProjectPath();
  const projectPath = chat?.projectPath ?? fallback;
  return (
    <ProjectHome
      projectPath={projectPath}
      recentChats={projectPath ? <ProjectRecentChats projectPath={projectPath} /> : undefined}
    />
  );
}

/** The history view (lane 4's `HistoryPane`): opening a chat resumes it from its note. */
export function HistorySlot() {
  const error = useHistoryError();
  return (
    <div data-agent-slot="history" className="flex min-h-0 flex-1 flex-col">
      {error && (
        <p role="alert" className="px-4 pt-2 text-[12.5px] text-[var(--agent-error)]">
          {error}
        </p>
      )}
      <HistoryPane onOpen={(chat) => void openSavedAgentChat(chat.chatId)} />
    </div>
  );
}
