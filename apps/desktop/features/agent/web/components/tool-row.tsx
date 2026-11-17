import { useId, useState } from "react";
import {
  Alert02Icon,
  CommandLineIcon,
  Edit02Icon,
  File02Icon,
  Globe02Icon,
  AiBrain01Icon,
  Cancel01Icon,
  Clock01Icon,
  Tick02Icon,
  ArtificialIntelligence01Icon,
} from "@hugeicons/core-free-icons";
import type { ToolBlock, ToolStatus } from "@features/agent/web/lib/transcript";
import { inputJson, toolKind, toolLabel, type ToolKind } from "@features/agent/web/lib/tool-kinds";
import { Ico, Spinner } from "./agent-icon";

const KIND_ICON: Record<ToolKind, typeof File02Icon> = {
  execute: CommandLineIcon,
  edit: Edit02Icon,
  read: File02Icon,
  fetch: Globe02Icon,
  agent: AiBrain01Icon,
  other: ArtificialIntelligence01Icon,
};

const STATUS_TEXT: Record<ToolStatus, string> = {
  running: "Running",
  waiting: "Waiting for permission",
  ok: "Done",
  error: "Failed",
  rejected: "Rejected",
  interrupted: "Interrupted",
};

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === "running") return <Spinner />;
  const icon =
    status === "ok"
      ? Tick02Icon
      : status === "waiting"
        ? Clock01Icon
        : status === "error"
          ? Alert02Icon
          : Cancel01Icon;
  const tone =
    status === "error"
      ? "text-[var(--agent-error)]"
      : status === "waiting"
        ? "text-[var(--agent-warn)]"
        : "text-text-icon-muted";
  return <Ico icon={icon} className={tone} />;
}

const MAX_LINES = 2000;
const HEAD_LINES = 500;

/** Code block that shows the first 500 lines of a >2,000 line text with "Show all" (spec 3.5). */
export function CodeBlock({ text, label }: { text: string; label: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const cut = !all && lines.length > MAX_LINES;
  return (
    <div>
      <pre
        aria-label={label}
        tabIndex={0}
        className="max-h-64 overflow-auto rounded-md bg-[var(--surface-subtle)] p-2 font-[var(--mono-font)] text-[12px] leading-snug whitespace-pre-wrap break-words text-text-secondary"
      >
        {cut ? lines.slice(0, HEAD_LINES).join("\n") : text}
      </pre>
      {cut && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1 text-[11px] text-text-muted underline hover:text-text-primary"
        >
          Show all {lines.length} lines
        </button>
      )}
    </div>
  );
}

export function ToolRow({ block, nested }: { block: ToolBlock; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const running = block.status === "running" || block.status === "waiting";
  const input = inputJson(block.input, block.inputText);
  const label = toolLabel(block.tool, block.input, running);
  return (
    <div data-agent-tool data-status={block.status} className={nested ? "pl-4" : undefined}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-text-secondary hover:bg-[var(--item-hover-bg)]"
      >
        <Ico icon={KIND_ICON[toolKind(block.tool)]} className="shrink-0 text-text-icon-muted" />
        <span className="min-w-0 flex-1 truncate font-[var(--mono-font)]" title={label}>
          {label}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-text-muted">
          <StatusIcon status={block.status} />
          <span className={block.status === "ok" ? "sr-only" : undefined}>
            {STATUS_TEXT[block.status]}
          </span>
        </span>
      </button>
      {open && (
        <div id={bodyId} className="space-y-1.5 px-2 pb-2 pl-8">
          {input && <CodeBlock text={input} label={`${block.tool} input`} />}
          {block.output !== null && (
            <>
              <CodeBlock text={block.output || "(no output)"} label={`${block.tool} output`} />
              {block.truncated && <p className="text-[11px] text-text-muted">Output truncated</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
