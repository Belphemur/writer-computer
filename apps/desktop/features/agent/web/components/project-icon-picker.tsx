import { useRef, useState, type RefObject } from "react";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { usePopoverPlacement } from "@/hooks/use-popover-placement";
import { ICON_PICKER_WIDTH, IconPicker } from "@/components/icon-picker/icon-picker";
import { loadIconSet } from "@/lib/icon-picker/icon-set";
import { iconValue, parseIconValue } from "@/lib/icon-picker/icon-value";
import type { IconSet } from "@/lib/icon-picker/icon-shards";
import {
  PROJECT_COLORS,
  projectColorVar,
  type ProjectAppearance,
} from "@features/agent/web/lib/project-appearance";
import { useProjectAppearance, useProjectsStore } from "@features/agent/web/stores/projects-store";

const PANEL_WIDTH = ICON_PICKER_WIDTH;

/** What the user picked: an icon or reset ends the interaction, a color does not (the user
 *  usually wants both). */
export type PickKind = "icon" | "color" | "reset";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

/**
 * The icon and color panel (spec 4.8): the core icon picker (Icons tab only; a project's icon is
 * a Hugeicons name) plus the color swatches and Reset. It only reports choices (`onChange`); who
 * writes them is the caller (the popover below for a saved project, the new-project dialog's
 * state for one that does not exist yet). `loadIcons` is the test seam for the lazily loaded set.
 */
export function ProjectIconPicker({
  value,
  onChange,
  onClose,
  error,
  loadIcons = loadIconSet,
}: {
  value: ProjectAppearance;
  onChange: (next: ProjectAppearance, kind: PickKind) => void;
  onClose: () => void;
  error?: string | null;
  loadIcons?: () => Promise<IconSet>;
}) {
  const current = value.icon ? iconValue("icon", value.icon) : null;
  return (
    <div data-project-icon-picker>
      <IconPicker
        label="Project icon and color"
        tabs={["icons"]}
        value={current}
        iconColor={projectColorVar(value.color)}
        loadIcons={loadIcons}
        onClose={onClose}
        error={error}
        onPick={(v) => {
          const picked = parseIconValue(v);
          if (picked) onChange({ icon: picked.name, color: value.color }, "icon");
        }}
        footer={
          <div className="mt-2 flex items-center gap-1.5" role="group" aria-label="Color">
            {PROJECT_COLORS.map((name) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                title={name}
                aria-pressed={value.color === name}
                onClick={() => onChange({ icon: value.icon, color: name }, "color")}
                style={{ background: projectColorVar(name) }}
                className={`size-5 rounded-full outline-offset-2 ${
                  value.color === name ? "ring-2 ring-[var(--text-primary)] ring-offset-1" : ""
                }`}
              />
            ))}
            <button
              type="button"
              onClick={() => onChange({ icon: null, color: null }, "reset")}
              className="ml-auto rounded-md px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]"
            >
              Reset
            </button>
          </div>
        }
      />
    </div>
  );
}

/**
 * The picker as a popover under `anchorRef` (a `relative` wrapper) for a saved project: every
 * choice is written through the projects store (`project.md`, the one write path). An icon or
 * Reset closes it, a color leaves it open. The wrapper stays mounted only while the popover is
 * wanted, so the caller renders it conditionally.
 */
export function ProjectIconPopover({
  projectPath,
  anchorRef,
  onClose,
}: {
  projectPath: string;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const value = useProjectAppearance(projectPath);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  usePopoverDismiss(ref, anchorRef, onClose);
  const placement = usePopoverPlacement(anchorRef, true, {
    width: PANEL_WIDTH + 16,
    side: "bottom",
    maxHeight: 460,
  });
  return (
    <div ref={ref} style={placement} className="absolute left-0 top-full z-50 mt-1">
      <ProjectIconPicker
        value={value}
        error={error}
        onClose={onClose}
        onChange={(next, kind) => {
          setError(null);
          useProjectsStore
            .getState()
            .setAppearance(projectPath, next)
            .then(
              () => {
                if (kind !== "color") onClose();
              },
              (e: unknown) => setError(describe(e)),
            );
        }}
      />
    </div>
  );
}
