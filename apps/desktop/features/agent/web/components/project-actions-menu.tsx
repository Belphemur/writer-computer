import type { RefObject } from "react";
import { openArchiveProject } from "@features/agent/web/lib/project-actions";
import { RowMenu, type RowMenuItem } from "./row-menu";

/** The ONE list of per-project actions (spec 4.6): the project home header and every switcher row
 *  render it. "Archive project…" goes through the home's confirm step (`openArchiveProject`). */
export function projectMenuItems(projectPath: string, onChangeIcon: () => void): RowMenuItem[] {
  return [
    { id: "icon", label: "Change icon…", onSelect: onChangeIcon },
    {
      id: "archive",
      label: "Archive project…",
      onSelect: () => openArchiveProject(projectPath),
      destructive: true,
    },
  ];
}

/** The "…" actions menu of one project, anchored under `anchorRef`. */
export function ProjectActionsMenu({
  projectPath,
  anchorRef,
  label,
  onChangeIcon,
  onClose,
}: {
  projectPath: string;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  onChangeIcon: () => void;
  onClose: () => void;
}) {
  return (
    <RowMenu
      items={projectMenuItems(projectPath, onChangeIcon)}
      anchorRef={anchorRef}
      label={label}
      onClose={onClose}
    />
  );
}
