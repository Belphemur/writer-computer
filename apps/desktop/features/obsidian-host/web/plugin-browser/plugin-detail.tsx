import { linkHandlers } from "@/lib/link-activation";
import type { StoreAudit, StoreDetail } from "../host/store-client";
import {
  useActionError,
  useBusy,
  useCatalogActions,
  useDetail,
  useDetailError,
  useDetailStatus,
  useEnabledIds,
  useSelectedId,
  useTrusted,
} from "./use-plugin-catalog";
import { formatDate } from "./format";
import { ReadmeView } from "./readme-view";

const BTN =
  "rounded-lg border border-[var(--line-subtler)] bg-[var(--surface-card)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-hover,var(--surface-card))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent,currentColor)] disabled:cursor-not-allowed disabled:opacity-50";

function Audit({ audit }: { audit: StoreAudit }) {
  const files = Object.keys(audit.files ?? {});
  return (
    <p
      role="status"
      className={`rounded-lg border px-3 py-2 text-[12px] ${
        audit.intact
          ? "border-[var(--line-subtler)] text-[var(--text-muted)]"
          : "border-red-500/40 text-red-500"
      }`}
    >
      {audit.intact
        ? `Integrity check passed: ${files.length} file${files.length === 1 ? "" : "s"} match the recorded SHA-256 hashes.`
        : "Integrity check failed: installed files differ from what was installed. Reinstall the plugin."}
    </p>
  );
}

function Readme({ detail }: { detail: StoreDetail }) {
  if (detail.readme === null) {
    return (
      <p className="text-[12px] text-[var(--text-muted)]">
        README unavailable{detail.readme_error ? `: ${detail.readme_error}` : "."}
      </p>
    );
  }
  return <ReadmeView markdown={detail.readme} repo={detail.entry.repo} />;
}

export function PluginDetail({ onPluginsChanged }: { onPluginsChanged?: () => void }) {
  const id = useSelectedId();
  const detail = useDetail();
  const status = useDetailStatus();
  const error = useDetailError();
  const trusted = useTrusted();
  const enabledIds = useEnabledIds();
  const busy = useBusy();
  const actionError = useActionError();
  const actions = useCatalogActions();

  if (!id) {
    return (
      <p className="p-4 text-[13px] text-[var(--text-muted)]">Select a plugin to see details.</p>
    );
  }
  if (!detail) {
    if (status === "error") {
      return (
        <div role="alert" className="p-4 text-[13px] text-red-500">
          Could not load plugin: {error}{" "}
          <button
            className={BTN}
            onClick={() => void actions.select(null).then(() => actions.select(id))}
          >
            Retry
          </button>
        </div>
      );
    }
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading plugin"
        className="flex animate-pulse flex-col gap-2 p-4"
      >
        <span className="text-[12px] text-[var(--text-muted)]">Loading plugin…</span>
        <span className="h-5 w-1/2 rounded bg-[var(--surface-subtle-strong)]" />
        <span className="h-3 w-3/4 rounded bg-[var(--surface-subtle)]" />
        <span className="h-3 w-2/3 rounded bg-[var(--surface-subtle)]" />
        <span className="mt-2 h-24 rounded bg-[var(--surface-subtle)]" />
      </div>
    );
  }

  const { entry, latest, installed, update, audit } = detail;
  const pending = busy[id];
  const isInstalled = installed !== null;
  const isEnabled = enabledIds.includes(id);
  const run = async (p: Promise<boolean>) => {
    if (await p) onPluginsChanged?.();
  };
  const repoUrl = `https://github.com/${entry.repo}`;

  return (
    <article aria-labelledby="plugin-detail-title" className="flex flex-col gap-3 p-4">
      <header>
        <h2 id="plugin-detail-title" className="text-lg font-semibold text-[var(--text-primary)]">
          {entry.name}
        </h2>
        <p className="text-[12px] text-[var(--text-muted)]">
          by {entry.author} ·{" "}
          <button
            type="button"
            className="underline"
            {...linkHandlers({ kind: "url", href: repoUrl })}
            aria-label={`Open ${entry.repo} on GitHub`}
          >
            {entry.repo}
          </button>
        </p>
      </header>
      <p className="text-[13px] text-[var(--text-primary)]">{entry.description}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px] text-[var(--text-muted)]">
        <dt>Downloads</dt>
        <dd>{entry.downloads.toLocaleString()}</dd>
        <dt>Installed</dt>
        <dd>{installed ?? "No"}</dd>
        <dt>Latest</dt>
        <dd>
          {latest
            ? `${latest.version}${latest.published ? ` (${formatDate(latest.published)})` : ""}`
            : `Unavailable${detail.release_error ? `: ${detail.release_error}` : ""}`}
        </dd>
        <dt>State</dt>
        <dd>{isInstalled ? (isEnabled ? "Enabled" : "Disabled") : "Not installed"}</dd>
      </dl>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Plugin actions">
        {!isInstalled && (
          <button
            className={BTN}
            disabled={!!pending || !latest}
            onClick={() => void run(actions.install(id))}
          >
            {pending === "installing" ? "Installing…" : "Install"}
          </button>
        )}
        {isInstalled && update && (
          <button
            className={BTN}
            disabled={!!pending}
            onClick={() => void run(actions.install(id))}
          >
            {pending === "updating" ? "Updating…" : `Update to ${latest?.version ?? "latest"}`}
          </button>
        )}
        {isInstalled && (
          <button
            className={BTN}
            disabled={!!pending || (!isEnabled && !trusted)}
            title={!trusted && !isEnabled ? "Trust this vault to enable plugins" : undefined}
            onClick={() => void run(actions.setEnabled(id, !isEnabled))}
          >
            {pending === "enabling"
              ? "Enabling…"
              : pending === "disabling"
                ? "Disabling…"
                : isEnabled
                  ? "Disable"
                  : "Enable"}
          </button>
        )}
        {isInstalled && (
          <button
            className={BTN}
            disabled={!!pending}
            onClick={() => void run(actions.uninstall(id))}
          >
            {pending === "uninstalling" ? "Uninstalling…" : "Uninstall"}
          </button>
        )}
      </div>
      {isInstalled && !isEnabled && (
        <p className="text-[12px] text-[var(--text-muted)]">
          Plugins are never enabled automatically. Review it, then press Enable.
        </p>
      )}
      {actionError[id] && (
        <p role="alert" className="text-[12px] text-red-500">
          {actionError[id]}{" "}
          <button className="underline" onClick={() => actions.clearActionError(id)}>
            Dismiss
          </button>
        </p>
      )}
      {audit && <Audit audit={audit} />}
      <Readme detail={detail} />
    </article>
  );
}
