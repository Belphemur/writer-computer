import {
  ArrowLeft01Icon,
  Cancel01Icon,
  Clock01Icon,
  Folder01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { openSettings } from "@/hooks/editor-api";
import {
  closeAgentPane,
  openAgentHistory,
  openNewProjectDialog,
  setAgentView,
} from "@features/agent/web/hooks/agent-api";
import { useAgentView } from "@features/agent/web/hooks/use-agent";
import { Ico } from "./agent-icon";
import { ProjectSwitcherSlot } from "./slots";

function HeaderButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: typeof Cancel01Icon;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-md p-1.5 text-text-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary"
    >
      <Ico icon={icon} size={15} />
    </button>
  );
}

/**
 * The window chrome overlays the top of the dock (drag region z-30, tab bar z-40), so the header
 * sits above it (z-50) but ignores pointer events itself; only the controls are clickable and
 * the rest of the strip still drags the window (same arrangement as the plugin pane).
 */
export function AgentHeader({ projectPath }: { projectPath: string | null }) {
  const view = useAgentView();
  return (
    <header
      data-agent-header
      className="pointer-events-none relative z-50 flex shrink-0 items-center gap-1 px-3 pt-10 pb-2"
    >
      <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1">
        {view !== "chat" && (
          <HeaderButton
            label="Back to chat"
            icon={ArrowLeft01Icon}
            onClick={() => setAgentView("chat")}
          />
        )}
        <ProjectSwitcherSlot projectPath={projectPath} />
      </div>
      <div className="pointer-events-auto flex items-center">
        <HeaderButton label="Chat history" icon={Clock01Icon} onClick={openAgentHistory} />
        <HeaderButton
          label="New project"
          icon={Folder01Icon}
          onClick={() => openNewProjectDialog()}
        />
        <HeaderButton
          label="Agent settings"
          icon={Settings01Icon}
          onClick={() => openSettings("agent")}
        />
        <HeaderButton label="Close agent pane" icon={Cancel01Icon} onClick={closeAgentPane} />
      </div>
    </header>
  );
}
