// Settings > Agent > MCP servers: the menu drawn from what `agent_mcp_servers` answers (the cases of
// the shared golden `shared/agent-mcp/menu.json`, the Rust side's own output), search, the switch
// written with the shared rule and put in force, Refresh and the one "applies" line. Every call
// goes through the plugin route; names and states only.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import golden from "@shared/agent-mcp/menu.json";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { useSettingsStore } from "@/stores/settings-store";
import { AgentMcp } from "../web/agent-mcp";
import type { McpMenu } from "../web/bindings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const menuOf = (name: string): McpMenu =>
  (golden.cases.find((c) => c.name === name)!.menu as unknown as McpMenu) ?? ({} as McpMenu);

describe("Settings > Agent > MCP servers", () => {
  let container: HTMLElement;
  let root: Root;
  let answer: McpMenu;
  const calls: [string, Record<string, unknown>][] = [];

  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  const all = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const rows = () => all("[data-agent-mcp-server]").map((e) => e.dataset.agentMcpServer);
  const flush = () => act(async () => {});
  const click = async (el: Element | null | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const servers = () =>
    calls.filter(([c]) => c === "plugin:agent|agent_mcp_servers").map(([, a]) => a);
  async function mount(backend = "claude") {
    await act(async () => {
      root.render(<AgentMcp backendId={backend} />);
    });
    await flush();
  }

  beforeEach(() => {
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    vi.useFakeTimers({ toFake: ["Date"] });
    // three minutes after the golden's `checkedAtMs`
    vi.setSystemTime(1_700_000_000_000 + 3 * 60_000);
    calls.length = 0;
    answer = menuOf("claude, on unless listed");
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args ?? {}]);
      if (cmd === "plugin:agent|agent_mcp_servers") return answer;
      if (cmd === "set_setting") return args.value;
      return null;
    });
    useSettingsStore.setState({
      settings: Object.fromEntries(SETTINGS_SCHEMA.map((d) => [d.key, d.default])),
      isLoaded: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("draws Writer first and locked on, then a switch per server in its state, naming collided servers once", async () => {
    await mount();
    expect(rows()).toEqual(["writer", "my_srv", "notes", "web"]);
    const writer = q("[data-agent-mcp-server=writer] [role=switch]") as HTMLButtonElement;
    expect(writer.disabled).toBe(true);
    expect(writer.getAttribute("aria-checked")).toBe("true");
    // the raw names of one switch are visible
    expect(q("[data-agent-mcp-server=my_srv]")?.textContent).toContain("my srv, my.srv");
    const on = (n: string) =>
      q(`[data-agent-mcp-server=${n}] [role=switch]`)!.getAttribute("aria-checked");
    expect([on("my_srv"), on("notes"), on("web")]).toEqual(["true", "false", "true"]);
    const word = (n: string) =>
      q(`[data-agent-mcp-server=${n}] [data-agent-mcp-state]`)?.textContent;
    expect([word("my_srv"), word("notes"), word("web")]).toEqual([
      "failed",
      "connected",
      "needs sign-in",
    ]);
    // Writer's own state is unknown: no word
    expect(q("[data-agent-mcp-server=writer] [data-agent-mcp-state]")).toBeNull();
    expect(q("[data-agent-mcp-checked]")?.textContent).toBe("Checked 3 mins ago");
    expect(q("[data-agent-mcp-applies]")?.textContent).toBe("Applies when a chat restarts.");
    expect(q("[data-agent-mcp-error]")).toBeNull();
    // a read list is not read again on open
    expect(servers()).toEqual([{ backend: "claude", refresh: false }]);
  });

  it("reads the list once on the first open when nothing was read yet", async () => {
    answer = menuOf("never read");
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args ?? {}]);
      if (cmd === "plugin:agent|agent_mcp_servers") {
        return args.refresh ? menuOf("claude, on unless listed") : answer;
      }
      return null;
    });
    await mount();
    expect(servers()).toEqual([
      { backend: "claude", refresh: false },
      { backend: "claude", refresh: true },
    ]);
    expect(rows()).toContain("notes");
  });

  it("searches by name and raw name, always keeping Writer's row", async () => {
    await mount();
    const search = q("input[type=search]") as HTMLInputElement;
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          search,
          value,
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("my.srv");
    expect(rows()).toEqual(["writer", "my_srv"]);
    await type("NOTES");
    expect(rows()).toEqual(["writer", "notes"]);
    await type("zzz");
    expect(rows()).toEqual(["writer"]);
    expect(container.textContent).toContain("No servers match.");
  });

  it("a switch writes the backend's list with the shared rule, puts it in force, then reloads the menu", async () => {
    // the stored list the golden's menu was made from
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, "agent.test.mcp": ["notes"] },
    });
    await mount();
    await click(q("[data-agent-mcp-server=web] [role=switch]"));
    await flush();
    const order = calls.map(([c, a]) => [c, a.key ?? a.backend, a.value ?? a.refresh]);
    // the menu is on unless listed: switching `web` off lists it next to `notes`
    expect(order.slice(1)).toEqual([
      ["set_setting", "agent.test.mcp", ["notes", "web"]],
      ["plugin:agent|agent_mcp_apply", "claude", undefined],
      ["plugin:agent|agent_mcp_servers", "claude", false],
    ]);
    // and switching the listed `notes` on takes it off the list
    await click(q("[data-agent-mcp-server=notes] [role=switch]"));
    await flush();
    const writes = calls.filter(([c]) => c === "set_setting").map(([, a]) => a.value);
    expect(writes).toEqual([["notes", "web"], ["web"]]);
  });

  it("Refresh reads the list now, and says it is checking while it does", async () => {
    await mount();
    let release!: (menu: McpMenu) => void;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args ?? {}]);
      if (cmd !== "plugin:agent|agent_mcp_servers") return null;
      return args.refresh ? new Promise<McpMenu>((r) => (release = r)) : answer;
    });
    await click(q("[data-agent-mcp-refresh]"));
    expect(servers().at(-1)).toEqual({ backend: "claude", refresh: true });
    expect(q("[data-agent-mcp-checked]")?.textContent).toBe("Checking…");
    expect((q("[data-agent-mcp-refresh]") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release({ ...answer, checkedAtMs: 1_700_000_000_000 + 3 * 60_000 }));
    expect(q("[data-agent-mcp-checked]")?.textContent).toBe("Checked just now");
  });

  it("says why the last read failed and, for a backend that applies at once, says so", async () => {
    answer = menuOf("the last read failed");
    await mount();
    expect(q("[data-agent-mcp-error]")?.textContent).toBe("mcp list timed out");
    act(() => root.unmount());
    root = createRoot(container);
    answer = menuOf("off unless listed, with a stale switch");
    await mount("other");
    expect(q("[data-agent-mcp-applies]")?.textContent).toBe("Applies now.");
    // the stale switch is a row, so it can be undone; the backend's own name is asked
    expect(rows()).toContain("gone");
    expect(servers().at(-1)).toEqual({ backend: "other", refresh: false });
  });

  it("a row covered by another switched-off server is locked, says which, and never toggles the parent", async () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, "agent.test.mcp": ["notes"] },
    });
    answer = {
      ...answer,
      servers: [
        ...answer.servers,
        { ...answer.servers.find((x) => x.name === "web")!, name: "notes__x", names: ["notes__x"] },
      ],
    };
    await mount();
    const sw = q("[data-agent-mcp-server=notes__x] [role=switch]") as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(q("[data-agent-mcp-server=notes__x] [data-agent-mcp-covered]")?.textContent).toBe(
      "Off with notes",
    );
    expect(q("[data-agent-mcp-server=notes] [data-agent-mcp-covered]")).toBeNull();
    await click(sw);
    expect(calls.some(([c]) => c === "set_setting")).toBe(false);
  });

  it("where the list holds the servers switched on, an entry covers only its own server", async () => {
    const server = (name: string, enabled: boolean) => ({
      name,
      names: [name],
      status: "connected" as const,
      ownedByWriter: false,
      enabled,
    });
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, "agent.test.mcp": ["a"] },
    });
    answer = {
      ...menuOf("off unless listed, with a stale switch"),
      setting: "agent.test.mcp",
      defaultOn: false,
      servers: [{ ...answer.servers[0]! }, server("a", true), server("a__b", false)],
    };
    await mount("other");
    const child = q("[data-agent-mcp-server=a__b] [role=switch]") as HTMLButtonElement;
    // `a` on does not switch `a__b` on, and `a__b` is its own switch (not locked, not "Off with")
    expect(child.getAttribute("aria-checked")).toBe("false");
    expect(child.disabled).toBe(false);
    expect(q("[data-agent-mcp-covered]")).toBeNull();
    await click(child);
    await flush();
    expect(calls.filter(([c]) => c === "set_setting").map(([, a]) => a.value)).toEqual([
      ["a", "a__b"],
    ]);
  });

  it("a refresh that a newer read replaced still ends its own Checking", async () => {
    await mount();
    let release!: (menu: McpMenu) => void;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args ?? {}]);
      if (cmd === "set_setting") return args.value;
      if (cmd !== "plugin:agent|agent_mcp_servers") return null;
      return args.refresh ? new Promise<McpMenu>((r) => (release = r)) : answer;
    });
    await click(q("[data-agent-mcp-refresh]"));
    expect(q("[data-agent-mcp-checked]")?.textContent).toBe("Checking…");
    // a switch reloads the menu while the refresh is out: the refresh is no longer the newest
    await click(q("[data-agent-mcp-server=web] [role=switch]"));
    await flush();
    await act(async () => release(answer));
    expect(q("[data-agent-mcp-checked]")?.textContent).not.toBe("Checking…");
    expect((q("[data-agent-mcp-refresh]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a switch that fails says why and shows what is in force", async () => {
    await mount();
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args ?? {}]);
      if (cmd === "set_setting") throw new Error("disk full");
      return cmd === "plugin:agent|agent_mcp_servers" ? answer : null;
    });
    await click(q("[data-agent-mcp-server=web] [role=switch]"));
    await flush();
    expect(q("[data-agent-mcp-error]")?.textContent).toBe("disk full");
    expect(calls.map(([c]) => c).slice(-1)).toEqual(["plugin:agent|agent_mcp_servers"]);
    expect(calls.some(([c]) => c === "plugin:agent|agent_mcp_apply")).toBe(false);
  });

  it("draws nothing before the first answer", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(container.innerHTML).toBe("");
  });

  it("draws nothing for a backend that answers no menu, and does not read it again", async () => {
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args ?? {}]);
      return null;
    });
    await mount("other");
    expect(q("[data-agent-mcp-menu]")).toBeNull();
    expect(servers()).toEqual([{ backend: "other", refresh: false }]);
  });
});
