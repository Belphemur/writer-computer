import { useMemo, useRef, useState } from "react";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { usePopoverPlacement } from "@/hooks/use-popover-placement";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { revealLabelForPlatform } from "@/lib/platform-labels";
import { detectPlatform } from "@/lib/platform";
import { useCliCatalog, useDiskSkills, type Chat } from "@features/agent/web/hooks/use-agent";
import {
  SOURCE_LABEL,
  loadedLabel,
  mergeSlashItems,
  type SlashItem,
} from "@features/agent/web/lib/slash-commands";
import type { McpServerStatus } from "@features/agent/web/lib/events";
import { vaultLinkHandlers } from "./agent-links";

/** The CLI's status word as a label ("needs-auth" reads "needs sign-in"). */
export function mcpStatusLabel(status: string): string {
  return status === "needs-auth" ? "needs sign-in" : status;
}

/** The MCP servers the chat's CLI reported with their state (`init.mcp_servers`). `null`: not
 *  reported since the start or the last reload (the CLI sends the list with the next message). */
export function McpSection({ servers }: { servers: McpServerStatus[] | null }) {
  return (
    <div data-agent-mcp className="mt-1 border-t border-[var(--line-subtle)] px-2 pt-1.5 pb-1">
      <p className="text-[11px] font-medium text-text-muted">MCP servers</p>
      {servers === null ? (
        <p data-agent-mcp-pending className="text-[11.5px] text-text-muted">
          Status appears with your next message.
        </p>
      ) : servers.length === 0 ? (
        <p className="text-[11.5px] text-text-muted">None reported for this chat.</p>
      ) : (
        <ul>
          {servers.map((s) => (
            <li
              key={s.name}
              data-agent-mcp-row
              className="flex items-baseline gap-2 text-[12.5px] text-text-primary"
            >
              <span className="truncate">{s.name}</span>
              <span
                className={`ml-auto shrink-0 text-[11px] ${s.status === "connected" ? "text-text-muted" : "text-[var(--status-warning,#b45309)]"}`}
              >
                {mcpStatusLabel(s.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What "loaded" means, in words (spec 3.2): the CLI lists it for this chat. */
export function skillStatusText(item: SlashItem): string {
  if (item.loaded === null) return "On disk. The chat has not started yet.";
  if (item.loaded) return "Loaded: Claude lists it for this chat.";
  return "Found on disk but not in Claude's list for this chat. Use Reload session (/reload) or start a new chat.";
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
        {chat.session?.mcpServers?.some((s) => s.status !== "connected") && (
          <span aria-label="An MCP server is not connected" title="An MCP server is not connected">
            {" "}
            ⚠
          </span>
        )}
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
                      // a global skill lives outside the vault: reveal it; the rest are note links
                      {...(s.source === "global"
                        ? { onClick: () => void revealItemInDir(s.path!) }
                        : vaultLinkHandlers(s.path))}
                      className="mt-0.5 text-[11px] text-text-muted underline hover:text-text-primary"
                    >
                      {s.source === "global"
                        ? revealLabelForPlatform(detectPlatform())
                        : "Open SKILL.md"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {chat.session && <McpSection servers={chat.session.mcpServers} />}
        </div>
      )}
    </div>
  );
}
