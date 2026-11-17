import { useMemo, useRef, useState } from "react";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { usePopoverPlacement } from "@/hooks/use-popover-placement";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCliCatalog, useDiskSkills, type Chat } from "@/hooks/use-agent";
import {
  SOURCE_LABEL,
  loadedLabel,
  mergeSlashItems,
  type SlashItem,
} from "@/lib/agent/slash-commands";
import { openVaultPath } from "./agent-links";

/** What "loaded" means, in words (spec 3.2): the CLI lists it for this chat. */
export function skillStatusText(item: SlashItem): string {
  if (item.loaded === null) return "On disk. The chat has not started yet.";
  if (item.loaded) return "Loaded: Claude lists it for this chat.";
  return "Found on disk but not in Claude's list for this chat. Type /reload-skills or start a new chat.";
}

function openSkill(item: SlashItem) {
  if (!item.path) return;
  if (item.source === "global") void revealItemInDir(item.path);
  else openVaultPath(item.path);
}

/** "Skills (N)" next to the mode chip: every skill (project, vault, global, and what Claude
 *  reported, including plugin skills) with its source, whether it is loaded and a link to its file. */
export function SkillsChip({ chat }: { chat: Chat }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(wrapRef, wrapRef, () => setOpen(false), open);
  const placement = usePopoverPlacement(wrapRef, open, { width: 320, maxHeight: 288 });
  const disk = useDiskSkills(chat.projectPath);
  const catalog = useCliCatalog();
  const skills = useMemo(
    () =>
      mergeSlashItems(disk?.items ?? [], chat.session, catalog).filter((i) => i.kind === "skill"),
    [disk?.items, chat.session, catalog],
  );
  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-agent-skills-chip
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[11.5px] text-text-secondary hover:bg-[var(--item-hover-bg)]"
      >
        Skills ({skills.length})
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Skills"
          data-agent-skills-popover
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          style={placement}
          className="absolute bottom-full left-0 z-30 mb-1 overflow-y-auto rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] p-1 shadow-lg"
        >
          {skills.length === 0 ? (
            <p className="px-2 py-1.5 text-[12.5px] text-text-muted">
              {disk?.status === "loading"
                ? "Loading skills…"
                : "No skills found. Skills live in .claude/skills or .agents/skills."}
            </p>
          ) : (
            <ul>
              {skills.map((s) => (
                <li key={s.name} data-agent-skill-row className="rounded-md px-2 py-1.5">
                  <div className="flex items-baseline gap-2 text-[12.5px]">
                    <span className="truncate font-medium text-text-primary">/{s.name}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-text-muted">
                      {SOURCE_LABEL[s.source]}
                      {loadedLabel(s) && (
                        <>
                          {" · "}
                          {s.loaded ? <span aria-hidden="true">✓ </span> : null}
                          <span title={skillStatusText(s)}>{loadedLabel(s)}</span>
                        </>
                      )}
                    </span>
                  </div>
                  {s.description && (
                    <p className="mt-0.5 line-clamp-2 text-[11.5px] text-text-muted">
                      {s.description}
                    </p>
                  )}
                  {s.loaded === false && (
                    <p className="mt-0.5 text-[11px] text-text-muted">{skillStatusText(s)}</p>
                  )}
                  {s.path && (
                    <button
                      type="button"
                      onClick={() => openSkill(s)}
                      className="mt-0.5 text-[11px] text-text-muted underline hover:text-text-primary"
                    >
                      {s.source === "global" ? "Show in Finder" : "Open SKILL.md"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
