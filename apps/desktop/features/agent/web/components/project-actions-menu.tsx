import { Archive01Icon, InformationCircleIcon, SmileIcon } from "@hugeicons/core-free-icons";
import type { RefObject } from "react";
import { openArchiveProject, openProjectDetail } from "@features/agent/web/lib/project-actions";
import { RowMenu, type RowMenuItem } from "./row-menu";

/** Where a project's "…" menu sits: the title dropdown's rows or the Projects list's rows (which
 *  also offer "Open details"). The project detail has no menu: its icon opens the icon picker. */
export type ProjectMenuPlace = "switcher" | "list";

/** The ONE list of per-project actions (spec 4.6). "Archive project…" opens the confirmation
 *  dialog in place (`openArchiveProject`). */
export function projectMenuItems(
  projectPath: string,
  place: ProjectMenuPlace,
  onChangeIcon: () => void,
): RowMenuItem[] {
  const items: RowMenuItem[] = [];
  if (place === "list") {
    items.push({
      id: "details",
      label: "Open details",
      icon: InformationCircleIcon,
      onSelect: () => openProjectDetail(projectPath),
    });
  }
  items.push({ id: "icon", label: "Change icon…", icon: SmileIcon, onSelect: onChangeIcon });
  items.push({
    id: "archive",
    label: "Archive project…",
    icon: Archive01Icon,
    onSelect: () => openArchiveProject(projectPath),
    destructive: true,
  });
  return items;
}

/** The "…" actions menu of one project, anchored under `anchorRef`. */
export function ProjectActionsMenu({
  projectPath,
  place,
  anchorRef,
  label,
  onChangeIcon,
  onClose,
}: {
  projectPath: string;
  place: ProjectMenuPlace;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  onChangeIcon: () => void;
  onClose: () => void;
}) {
  return (
    <RowMenu
      items={projectMenuItems(projectPath, place, onChangeIcon)}
      anchorRef={anchorRef}
      label={label}
      onClose={onClose}
    />
  );
}
