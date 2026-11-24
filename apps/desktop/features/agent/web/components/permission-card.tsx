import { useId, useRef, useState } from "react";
import { ShieldKeyIcon } from "@hugeicons/core-free-icons";
import { decideAgentPermission } from "@features/agent/web/hooks/agent-api";
import type { PermissionView } from "@features/agent/web/lib/transcript";
import {
  alwaysChoice,
  editPreview,
  inputJson,
  KIND_LABEL,
  type PermissionChoice,
  permissionChoices,
  permissionSummary,
  ruleChips,
  toolKind,
  toolRole,
} from "@features/agent/web/lib/tool-kinds";
import { Ico } from "./agent-icon";
import { CodeBlock } from "./tool-row";

/** What approving any shell command means, whichever backend runs it. */
const SHELL_WARNING = "Runs with your full account rights.";

/**
 * "Permission required", pinned above the composer, one request at a time (spec 6.2).
 * Keyboard: with focus anywhere inside the card, Enter = Allow once and Esc = Deny once (a
 * focused button keeps its own Enter). From the composer the pane handles Cmd+Enter (allow),
 * Cmd+Shift+Enter (always, in the project) and Cmd+Backspace (deny). Focus is never stolen from
 * the composer when the card appears; the card precedes the composer in DOM order so Tab from
 * the composer's start reaches it.
 */
export function PermissionCard({
  request,
  more,
  shellNote,
}: {
  request: PermissionView;
  more: number;
  /** The chat's backend's own sentence for a shell request (its descriptor). */
  shellNote?: string;
}) {
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const detailsId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const chips = ruleChips(request.suggestions);
  // the rules still ticked; at least one stays (a chip is only unticked while another is ticked)
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const ticked = chips.filter((r) => !unticked.has(r));
  const choices = permissionChoices(request.suggestions, chips.length > 0 ? ticked : undefined);
  const projectChoice =
    alwaysChoice(request.suggestions, chips.length > 0 ? ticked : undefined) ?? choices[0];
  const kind = toolKind(request.tool);
  const preview = kind === "edit" ? editPreview(request.tool, request.input) : null;

  const allow = () => void decideAgentPermission(request.requestId, "allow");
  const always = (c: PermissionChoice) =>
    void decideAgentPermission(request.requestId, "allow", c.persist, undefined, c.rules);
  const toggle = (rule: string) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (!next.delete(rule)) next.add(rule);
      return next;
    });
  const deny = () => void decideAgentPermission(request.requestId, "deny");

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (menu) setMenu(false);
      else deny();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !e.shiftKey) {
      e.preventDefault();
      allow();
    }
  }

  return (
    <div
      ref={cardRef}
      role="alert"
      data-agent-permission
      aria-label="Permission required"
      onKeyDown={onKeyDown}
      className="rounded-xl border border-[var(--agent-warn)] bg-[var(--surface-card)] p-3 text-[13px] text-text-primary"
    >
      <div className="flex items-center gap-2 font-medium">
        <Ico icon={ShieldKeyIcon} size={15} className="text-[var(--agent-warn)]" />
        <span>Permission required</span>
        {request.by && (
          <span
            data-agent-permission-by={request.by}
            className="rounded-full bg-[var(--surface-subtle)] px-1.5 py-0.5 text-[11px] font-normal text-text-muted"
          >
            asked by {request.by}
          </span>
        )}
        {more > 0 && (
          <span className="ml-auto rounded-md bg-[var(--surface-subtle)] px-1.5 py-0.5 text-[11px] font-normal text-text-muted">
            +{more} more
          </span>
        )}
      </div>
      <p className="mt-1.5 break-words" data-agent-permission-summary>
        {permissionSummary(request)}
      </p>
      <p className="mt-0.5 text-[11.5px] text-text-muted">Type: {KIND_LABEL[kind]}</p>
      {toolRole(request.tool) === "shell" && (
        <p className="mt-0.5 text-[11.5px] text-text-muted" data-agent-permission-shell-warning>
          {SHELL_WARNING}
          {shellNote && ` ${shellNote}`}
        </p>
      )}

      {chips.length > 0 && (
        <div role="group" aria-label="Rules to allow" className="mt-2 flex flex-wrap gap-1.5">
          {chips.map((rule) => {
            const on = !unticked.has(rule);
            return (
              <label
                key={rule}
                data-agent-permission-rule
                className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-[var(--surface-subtle)] px-1.5 py-0.5 text-[11.5px]"
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={on && ticked.length === 1}
                  onChange={() => toggle(rule)}
                />
                <code className="truncate" title={rule}>
                  {rule}
                </code>
              </label>
            );
          })}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={allow}
          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12.5px] font-medium text-[var(--bg-base)] hover:opacity-90"
        >
          Allow once
        </button>
        {choices.length > 0 && (
          <div className="relative inline-flex">
            <button
              type="button"
              onClick={() => projectChoice && always(projectChoice)}
              className="rounded-l-md border border-[var(--line-subtle)] px-2.5 py-1 text-[12.5px] hover:bg-[var(--item-hover-bg)]"
            >
              Always allow
            </button>
            <button
              type="button"
              aria-label="More always-allow choices"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
              className="rounded-r-md border border-l-0 border-[var(--line-subtle)] px-1.5 py-1 text-[12.5px] hover:bg-[var(--item-hover-bg)]"
            >
              ▾
            </button>
            {menu && (
              <div
                role="menu"
                aria-label="Always allow"
                className="absolute bottom-full left-0 z-20 mb-1 w-64 rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] p-1 shadow-lg"
              >
                {choices.map((c) => (
                  <button
                    key={c.label}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setMenu(false);
                      always(c);
                    }}
                    className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-[var(--item-hover-bg)]"
                  >
                    <span className="block">{c.label}</span>
                    {c.rule && (
                      <code className="block truncate text-[11px] text-text-muted" title={c.rule}>
                        {c.rule}
                      </code>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={deny}
          className="rounded-md border border-[var(--line-subtle)] px-2.5 py-1 text-[12.5px] hover:bg-[var(--item-hover-bg)]"
        >
          Deny
        </button>
        <button
          type="button"
          aria-expanded={details}
          aria-controls={detailsId}
          onClick={() => setDetails((v) => !v)}
          className="ml-auto text-[12px] text-text-muted underline hover:text-text-primary"
        >
          Show details
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-text-muted">Enter allows once, Esc denies.</p>

      {details && (
        <div id={detailsId} className="mt-2 space-y-1.5">
          {request.decisionReason && (
            <p className="text-[12px] text-text-muted">{request.decisionReason}</p>
          )}
          <CodeBlock text={inputJson(request.input, "")} label="Tool input" />
          {preview && <CodeBlock text={preview} label="Content preview" />}
        </div>
      )}
    </div>
  );
}
