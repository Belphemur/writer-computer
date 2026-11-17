// The agent's IPC after the move into a plugin: every command is called as
// `plugin:agent|<command>` (the "alias test per moved command" of the spec's risk table), the
// manifest, the generated bindings and the typed client name the same commands, and the event
// follows the `<id>:<name>` rule.
// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "../feature.json";
import { commands } from "../web/bindings";
import { agentCommand, agentEvents } from "../web/ipc";

afterEach(() => clearMocks());

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const call = agentCommand as unknown as (c: string, a?: object) => Promise<unknown>;

describe("the agent's commands", () => {
  it("are the same set in the manifest and in the generated bindings", () => {
    expect(Object.keys(commands).map(snake).sort()).toEqual([...manifest.rust.commands].sort());
    expect(manifest.rust.commands).toHaveLength(36);
  });

  it("are invoked by the generated bindings on the plugin route", () => {
    for (const [name, fn] of Object.entries(commands)) {
      expect(fn.toString(), name).toContain(`"plugin:agent|${snake(name)}"`);
    }
  });

  it.each(manifest.rust.commands)("%s is called as plugin:agent|%s", async (command) => {
    const seen: string[] = [];
    mockIPC((cmd) => void seen.push(cmd));
    await call(command, {});
    expect(seen).toEqual([`plugin:agent|${command}`]);
  });

  it("a command the manifest does not declare never reaches Rust", async () => {
    let reached = false;
    mockIPC(() => void (reached = true));
    await expect(call("agent_context_preview", {})).rejects.toThrow(/declares no command/);
    expect(reached).toBe(false);
  });
});

describe("the agent's event", () => {
  it("is named agent:event, as the manifest says", () => {
    expect(manifest.rust.events).toEqual([agentEvents.name("event")]);
    expect(agentEvents.name("event")).toBe("agent:event");
  });
});
