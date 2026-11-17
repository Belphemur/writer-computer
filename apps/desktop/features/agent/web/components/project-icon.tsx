import { HugeiconsIcon } from "@hugeicons/react";
import { projectColorVar, useProjectIcon } from "@features/agent/web/lib/project-appearance";
import { useProjectAppearance } from "@features/agent/web/stores/projects-store";

/**
 * The one way a project's icon is drawn (spec 4.8): the stored Hugeicons name in the project's
 * color. A missing or unknown icon draws the default project icon, a missing or unknown color the
 * current accent. The set loads lazily, so the default shows until it resolves.
 */
export function ProjectIcon({
  icon,
  color,
  size = 14,
  className,
}: {
  icon?: string | null;
  color?: string | null;
  size?: number;
  className?: string;
}) {
  const element = useProjectIcon(icon);
  return (
    <span
      aria-hidden="true"
      data-project-icon={icon ?? ""}
      data-project-color={color ?? ""}
      className={`inline-flex shrink-0 items-center ${className ?? ""}`}
      style={{ color: projectColorVar(color) }}
    >
      <HugeiconsIcon icon={element} size={size} strokeWidth={1.75} color="currentColor" />
    </span>
  );
}

/** [`ProjectIcon`] of the listed project at a vault-relative folder path. */
export function ProjectPathIcon({
  path,
  size,
  className,
}: {
  path: string | null;
  size?: number;
  className?: string;
}) {
  const { icon, color } = useProjectAppearance(path);
  return <ProjectIcon icon={icon} color={color} size={size} className={className} />;
}
