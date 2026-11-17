// The `agent.context` service (what the graph's "Attach to agent chat" uses): it is registered with
// the feature and gone with it, and attaching puts the note into the active chat's draft as an `@`
// mention (token in the text, ref in the mentions) and opens the pane.
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { featureHost as host } from "@/lib/features/registry";
import "@/lib/features/builtin";
import { getService } from "@/lib/features/services";
import { usePaneStore } from "@features/agent/web/stores/pane-store";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import manifest from "../feature.json";
import { AGENT_CONTEXT, type AgentContextService } from "../web/api";

beforeEach(() => {
  useSettingsStore.setState({ settings: { "features.agent.enabled": true } });
});

describe("agent.context", () => {
  it("is declared, registered while the feature is on, and gone when it is off", async () => {
    expect(manifest.provides).toContain(AGENT_CONTEXT);
    expect(getService<AgentContextService>(AGENT_CONTEXT)).toBeDefined();
    useSettingsStore.setState({ settings: { "features.agent.enabled": false } });
    await vi.waitFor(() => expect(getService(AGENT_CONTEXT)).toBeUndefined());
    useSettingsStore.setState({ settings: { "features.agent.enabled": true } });
    expect(host.list()).toContain("agent");
  });

  it("attaches notes to the active draft once each and shows the pane", async () => {
    const service = getService<AgentContextService>(AGENT_CONTEXT)!;
    await service.attachNotes(["People/Ana.md", "People/Ben.md"]);
    await service.attachNotes(["People/Ana.md"]);
    const s = useAgentStore.getState();
    const draft = s.drafts[s.activeChatId!]!;
    expect(draft.mentions.map((m) => ("path" in m ? m.path : ""))).toEqual([
      "People/Ana.md",
      "People/Ben.md",
    ]);
    expect(draft.text).toBe("@Ana @Ben ");
    expect(usePaneStore.getState().open).toBe(true);
  });
});
