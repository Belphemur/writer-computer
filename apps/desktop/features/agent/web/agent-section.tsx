import { useCallback, useEffect, useState } from "react";
import { linkHandlers } from "@/lib/link-activation";
import { useAllSettings, useSetSetting } from "@/hooks/use-settings";
import { createTauriAgentClient } from "@features/agent/web/lib/client";
import {
  AGENT_BACKENDS,
  DEFAULT_BACKEND_ID,
  backendById,
  deriveBackendStatus,
  type AgentBackendDescriptor,
  type BackendGlyph,
  type BackendStatus,
  type DetectedBinary,
} from "@features/agent/web/lib/backends";
import {
  buildModelRows,
  modelIdToSetting,
  modelSettingToId,
  modelSupportsEffort,
  DEFAULT_MODEL_ID,
} from "@features/agent/web/lib/model-catalog";
import { PERMISSION_MODE_LABEL } from "@features/agent/web/lib/agent-settings";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { AgentConfigureDialog, locateBinary } from "./agent-configure";
import { AgentMemory } from "./agent-memory";
import { AgentModels } from "./agent-models";
import { ROW, SELECT, SelectRow } from "./agent-rows";
import { TierModels } from "./tier-models";
import { SettingRows } from "@/components/settings-panel/setting-rows";

const text = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);

const CARD =
  "overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]";
const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";
const COMING_SOON_NOTE =
  'Coming soon. See "Other backends" in the agent spec; Claude is the only backend today.';

function Glyph({ glyph, size = 18 }: { glyph: BackendGlyph; size?: number }) {
  // Writer's own marks, not vendor logos: a spark for Claude, a plain letter tile for the rest.
  if (glyph === "claude") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
        <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
      </svg>
    );
  }
  const letter = { opencode: "O", codex: "X", "quick-chat": "Q" }[glyph];
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.6 }}
      className="inline-flex items-center justify-center rounded-md border border-current font-semibold"
    >
      {letter}
    </span>
  );
}

function BackendTabs({ activeId }: { activeId: string }) {
  return (
    <div role="tablist" aria-label="Agent backend" className="mb-4 flex flex-wrap gap-2">
      {AGENT_BACKENDS.map((b) => {
        const active = b.id === activeId;
        const soon = b.status === "coming-soon";
        return (
          <button
            key={b.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-disabled={soon || undefined}
            disabled={soon}
            data-agent-backend-tab={b.id}
            title={soon ? COMING_SOON_NOTE : undefined}
            className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors ${
              active
                ? "bg-[var(--accent)] text-white"
                : "border border-[var(--line-subtle)] text-[var(--text-secondary)]"
            } ${soon ? "cursor-not-allowed opacity-55" : ""}`}
          >
            <Glyph glyph={b.glyph} size={14} />
            {b.label}
            {soon && <span className="text-[10px] uppercase tracking-wide">Soon</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Detects the backend's program on mount and whenever `agent.binary-path` changes. */
function useBackendStatus(backend: AgentBackendDescriptor, override: string) {
  const [info, setInfo] = useState<DetectedBinary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detect = useCallback(async () => {
    setError(null);
    setInfo(null);
    try {
      setInfo(await createTauriAgentClient().detectBinary({ binaryOverride: override || null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [override]);
  useEffect(() => {
    void detect();
  }, [detect]);
  return { status: deriveBackendStatus(backend, info, error), info, redetect: detect };
}

function StatusBadge({ status }: { status: BackendStatus }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium";
  switch (status.kind) {
    case "ready":
      return (
        <span
          data-agent-status="ready"
          className={`${base} bg-[var(--success-soft)] text-[var(--success)]`}
        >
          ✓ Ready
        </span>
      );
    case "checking":
      return (
        <span data-agent-status="checking" className={`${base} text-[var(--text-muted)]`}>
          Checking…
        </span>
      );
    case "not-found":
      return (
        <span
          data-agent-status="not-found"
          className={`${base} bg-[var(--surface-subtle)] text-[var(--text-secondary)]`}
        >
          Not found
        </span>
      );
    case "needs-sign-in":
      return (
        <span
          data-agent-status="needs-sign-in"
          className={`${base} bg-[var(--surface-subtle)] text-[var(--text-secondary)]`}
        >
          Needs sign-in
        </span>
      );
    case "unsupported-version":
      return (
        <span
          data-agent-status="unsupported-version"
          className={`${base} bg-[var(--warning-soft)] text-[var(--warning)]`}
        >
          Unsupported version
        </span>
      );
    case "error":
      return (
        <span data-agent-status="error" className={`${base} text-[var(--danger)]`}>
          Could not check
        </span>
      );
  }
}

function statusDetail(status: BackendStatus): string {
  switch (status.kind) {
    case "ready":
      return `${status.path}${status.version ? `  ${status.version}` : ""}`;
    case "not-found":
      return "Claude Code was not found on this computer.";
    case "needs-sign-in":
      return `${status.path}. Run claude in a terminal and sign in.`;
    case "unsupported-version":
      return `${status.path}  ${status.version}. Tested with ${status.minVersion} and later; it may still work.`;
    case "error":
      return status.message;
    case "checking":
      return "Looking for the claude program…";
  }
}

/** Settings rows of the generic kind, rendered with the shared `SettingRows`. */
function SchemaRows({ keys }: { keys: readonly string[] }) {
  return <SettingRows defs={keys.flatMap((k) => SETTINGS_SCHEMA.filter((d) => d.key === k))} />;
}

const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: "default", label: "Agent default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

/** Settings > Agent: the same layout as Copilot's agent settings, on Writer's own components. */
export function AgentSection() {
  const backend = backendById(DEFAULT_BACKEND_ID)!;
  const settings = useAllSettings();
  const setSetting = useSetSetting();
  const [configuring, setConfiguring] = useState(false);
  const override = text(settings["agent.binary-path"], "");
  const { status, redetect } = useBackendStatus(backend, override);

  const model = text(settings["agent.model"], "");
  const effort = text(settings["agent.effort"], "default");
  const enabled = settings["agent.enabled-models"];
  const modelRows = buildModelRows(enabled, { currentModel: model || null }).filter(
    (r) => r.enabled || r.id === modelSettingToId(model),
  );
  const effortOk = modelSupportsEffort(model);

  async function locate() {
    const picked = await locateBinary();
    if (picked) await setSetting("agent.binary-path", picked);
  }

  return (
    <section className="mb-10" data-agent-section>
      <BackendTabs activeId={backend.id} />
      <div className={CARD}>
        <div className={ROW} data-agent-header>
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="mt-0.5 text-[var(--text-primary)]">
              <Glyph glyph={backend.glyph} size={22} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-[var(--text-primary)]">
                  {backend.label}
                </span>
                <StatusBadge status={status} />
              </div>
              <div
                data-agent-binary-status
                className="mt-0.5 select-text break-all font-mono text-[12px] text-[var(--text-muted)]"
              >
                {statusDetail(status)}
              </div>
              {status.kind === "not-found" && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={BUTTON}
                    {...(backend.installUrl
                      ? linkHandlers({ kind: "url", href: backend.installUrl })
                      : {})}
                  >
                    Install instructions
                  </button>
                  <button type="button" className={BUTTON} onClick={() => void locate()}>
                    Locate…
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <button type="button" className={BUTTON} onClick={() => setConfiguring(true)}>
              Configure
            </button>
            <button
              type="button"
              className="rounded-md px-1.5 text-[12px] text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
              onClick={() => void redetect()}
            >
              Re-detect
            </button>
          </div>
        </div>

        <SelectRow
          title="Default model"
          description="Used for new chats on this agent. Open chats switch on their next turn."
        >
          <select
            aria-label="Default model"
            value={modelSettingToId(model)}
            className={SELECT}
            onChange={(e) => void setSetting("agent.model", modelIdToSetting(e.target.value))}
          >
            {modelRows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id === DEFAULT_MODEL_ID ? "Agent default" : r.label}
              </option>
            ))}
          </select>
        </SelectRow>
        <SelectRow
          title="Default effort"
          description={
            effortOk
              ? "How hard the model thinks by default."
              : "The selected model has no effort levels."
          }
        >
          <select
            aria-label="Default effort"
            disabled={!effortOk}
            value={effortOk ? effort : "default"}
            className={SELECT}
            onChange={(e) => void setSetting("agent.effort", e.target.value)}
          >
            {EFFORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SelectRow>

        <AgentModels
          backendLabel={backend.label}
          enabled={enabled}
          currentModel={model || null}
          onChange={(next) => void setSetting("agent.enabled-models", next)}
        />
      </div>

      <h2 className="mt-8 mb-1 text-[13px] font-medium text-[var(--text-muted)]">
        Auto mode permissions
      </h2>
      <p className="mb-3 text-[13px] text-[var(--text-muted)]">
        The permission mode decides what the agent may do without asking:{" "}
        {Object.entries(PERMISSION_MODE_LABEL)
          .map(([k, v]) => `${k} (${v})`)
          .join(", ")}
        . <code>auto</code> is Claude Code&apos;s own auto mode: it lets a classifier approve
        routine actions and still asks for risky ones. Writer never offers a mode that skips
        permission checks. The rules below are passed to every chat as <code>--allowedTools</code>{" "}
        and <code>--disallowedTools</code>; a deny rule always wins.
      </p>
      <SchemaRows
        keys={["agent.permission-mode", "agent.allowed-tools", "agent.disallowed-tools"]}
      />

      <h2 className="mt-8 mb-3 text-[13px] font-medium text-[var(--text-muted)]">
        Chats and context
      </h2>
      <SchemaRows
        keys={[
          "agent.attach-active-note",
          "agent.share-open-tabs",
          "agent.show-turn-changes",
          "agent.inject-agents-md",
          "agent.max-concurrent-chats",
          "agent.chats-keep-days",
          "agent.auto-title-chats",
          "agent.restore-chats",
          "agent.orchestrate",
          "agent.show-thinking",
          "agent.pane-width",
          "agent.pane-open",
        ]}
      />

      <AgentMemory />

      <h2 className="mt-8 mb-1 text-[13px] font-medium text-[var(--text-muted)]">
        Sub-agent models
      </h2>
      <p className="mb-3 text-[13px] text-[var(--text-muted)]">
        Each sub-agent role runs on a model tier, and each tier has one model for this agent. The
        cheap tier also writes automatic chat titles.
      </p>
      <TierModels />
      {configuring && (
        <AgentConfigureDialog
          onClose={() => setConfiguring(false)}
          onRedetect={() => void redetect()}
        />
      )}
    </section>
  );
}
