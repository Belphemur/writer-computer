import { useCallback, useEffect, useRef, useState } from "react";
import { matchesQuery, stringList } from "@/lib/features/agent-backends";
import { formatRelativeTime } from "@/lib/relative-time";
import { mcpCoveredBy, mcpSwitchedAfter } from "@/lib/switches";
import { useSettingsStore } from "@/stores/settings-store";
import { BooleanControl } from "@/components/settings-panel/setting-control";
import { SearchField } from "@/components/settings-panel/search-field";
import { mcpStatusLabel } from "@features/agent/web/lib/mcp-status";
import { callAgent, type Applies, type McpMenu, type McpServer } from "./ipc";

// Settings > Agent > MCP servers (ADR 2026-11-24, spec native-agent-spec 7.1): one menu for every
// backend, drawn from what `agent_mcp_servers` answers. Writer's own server first, always on and
// locked; one switch per other server, written to the backend's setting (`menu.setting`) with the
// shared switch rule and put in force by `agent_mcp_apply`. Names and states only.

const APPLIES: Record<Applies, string> = {
  "next-start": "Applies when a chat restarts.",
  live: "Applies now.",
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The menu of `backendId`: cached at once, read from the program on the first open and on
 *  Refresh (it may start every server, so never on a timer). The newest request wins. */
function useMcpMenu(backendId: string) {
  const [menu, setMenu] = useState<McpMenu | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // the backend has no switches (no menu): the answer is null
  const [absent, setAbsent] = useState(false);
  const latest = useRef(0);
  // the refreshes in flight: a superseded one still ends its own, so Refresh never stays locked
  const refreshing = useRef(new Set<number>());
  const load = useCallback(
    async (refresh: boolean): Promise<McpMenu | null> => {
      const mine = ++latest.current;
      if (refresh) {
        refreshing.current.add(mine);
        setBusy(true);
      }
      try {
        const next = await callAgent("agent_mcp_servers", { backend: backendId, refresh });
        if (mine !== latest.current) return null;
        setAbsent(next === null);
        setMenu(next);
        setFailure(null);
        return next;
      } catch (e) {
        if (mine === latest.current) setFailure(message(e));
        return null;
      } finally {
        if (refresh) {
          refreshing.current.delete(mine);
          setBusy(refreshing.current.size > 0);
        }
      }
    },
    [backendId],
  );
  useEffect(() => {
    setMenu(null);
    refreshing.current.clear();
    setBusy(false);
    setAbsent(false);
    setFailure(null);
    void (async () => {
      const cached = await load(false);
      // never read yet: the first open reads once, so the list is not empty for no reason
      if (cached && cached.checkedAtMs === null && !cached.error) await load(true);
    })();
    return () => {
      latest.current++;
    };
  }, [backendId, load]);
  return { menu, busy, failure, setFailure, absent, load };
}

function Row({
  server,
  coveredBy,
  onChange,
}: {
  server: McpServer;
  /** The key of the switched-off server that takes this one off with it, if any. */
  coveredBy: string | null;
  onChange: (server: McpServer, on: boolean) => void;
}) {
  const word = server.status === "unknown" ? null : mcpStatusLabel(server.status);
  const raw = server.names.filter((n) => n !== server.name);
  return (
    <li data-agent-mcp-server={server.name} className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-[var(--text-primary)]">
          {server.ownedByWriter ? "Writer" : server.name}
        </div>
        {raw.length > 0 && (
          <div className="truncate text-[12px] text-[var(--text-muted)]">
            {server.names.join(", ")}
          </div>
        )}
        {coveredBy && (
          <div data-agent-mcp-covered className="truncate text-[12px] text-[var(--text-muted)]">
            Off with {coveredBy}
          </div>
        )}
      </div>
      {word && (
        <span
          data-agent-mcp-state={server.status}
          className="shrink-0 text-[12px] text-[var(--text-muted)]"
        >
          {word}
        </span>
      )}
      <BooleanControl
        label={server.ownedByWriter ? "Writer is always on" : `Enable ${server.name}`}
        value={server.enabled}
        disabled={server.ownedByWriter || coveredBy !== null}
        onChange={(on) => onChange(server, on)}
      />
    </li>
  );
}

/** The backend's MCP servers: search, a switch per server, the time of the last read with
 *  Refresh and one line on when a switch applies. */
export function AgentMcp({ backendId }: { backendId: string }) {
  const { menu, busy, failure, setFailure, absent, load } = useMcpMenu(backendId);
  const setSetting = useSettingsStore((s) => s.setSetting);
  const [query, setQuery] = useState("");
  const stored = useSettingsStore((s) => (menu ? s.settings[menu.setting] : undefined));

  async function toggle(server: McpServer, on: boolean) {
    if (!menu) return;
    // read at the click: two quick clicks each start from the list the other left
    const list = stringList(useSettingsStore.getState().settings[menu.setting]);
    try {
      await setSetting(menu.setting, mcpSwitchedAfter(list, server.name, on, menu.defaultOn));
      await callAgent("agent_mcp_apply", { backend: backendId });
    } catch (e) {
      await load(false); // the menu shows what is in force, then the reason
      setFailure(message(e));
      return;
    }
    await load(false);
  }

  const rows = menu?.servers.filter(
    (s) => s.ownedByWriter || matchesQuery(query, s.name, ...s.names),
  );
  const when = menu?.checkedAtMs ? formatRelativeTime(Math.floor(menu.checkedAtMs / 1000)) : null;
  const problem = failure ?? menu?.error ?? null;
  // nothing before the first answer: no empty frame, and no menu for a backend without switches
  if (absent || (!menu && !failure)) return null;
  return (
    <div
      data-agent-mcp-menu={backendId}
      className="border-t border-[var(--line-subtler)] px-4 py-3.5"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-medium text-[var(--text-primary)]">MCP servers</h3>
        <SearchField
          label="Search MCP servers"
          value={query}
          onChange={setQuery}
          className="ml-auto block min-w-[140px] max-w-[260px] flex-1"
        />
      </div>
      <ul>
        {rows?.map((s) => (
          <Row
            key={s.name}
            server={s}
            coveredBy={menu ? mcpCoveredBy(stringList(stored), s.name, menu.defaultOn) : null}
            onChange={(srv, on) => void toggle(srv, on)}
          />
        ))}
        {menu && rows?.length === 1 && menu.servers.length > 1 && (
          <li className="py-2 text-[13px] text-[var(--text-muted)]">No servers match.</li>
        )}
      </ul>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-[var(--text-muted)]">
        <span data-agent-mcp-checked>
          {busy ? "Checking…" : when ? `Checked ${when}` : "Not checked"}
        </span>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          data-agent-mcp-refresh
          disabled={busy}
          onClick={() => void load(true)}
          className="rounded-md px-1.5 hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
      {problem && (
        <p data-agent-mcp-error className="mt-1 text-[12px] text-[var(--danger)]">
          {problem}
        </p>
      )}
      {menu && (
        <p data-agent-mcp-applies className="mt-1 text-[12px] text-[var(--text-muted)]">
          {APPLIES[menu.applies]}
        </p>
      )}
    </div>
  );
}
