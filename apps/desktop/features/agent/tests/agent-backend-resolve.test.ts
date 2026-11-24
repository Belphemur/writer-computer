// @vitest-environment jsdom
// The default backend is resolved before detection has run: untouched chats follow it once it is
// known (and when a backend's feature comes or goes), never a chat the user picked for or one with
// content; a changed program path makes everything look again; "Choose binary…" saves only a
// program that is found.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const openMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock, ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

import { chooseBinary } from "@features/agent/web/components/error-card";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import {
  resetBackendUsabilityForTests,
  useBackendUsability,
} from "@features/agent/web/stores/backend-usability";
import {
  configureAgentRuntimeForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";
import { useSettingsStore } from "@/stores/settings-store";
import { FIXTURE_ID, registerFixtureBackend } from "./helpers/fixture-backend";

const get = () => useAgentStore.getState();
const backendOf = (id: string) => get().chats[id]!.backendId;

describe("re-resolving the default backend", () => {
  let unregister: () => void;
  beforeEach(() => {
    configureAgentRuntimeForTests(
      createMockAgentClient({ goldens: goldens as unknown as Goldens }),
    );
    useAgentStore.setState(useAgentStore.getInitialState(), true);
    resetBackendUsabilityForTests();
    useSettingsStore.setState({ settings: { "agent.default-backend": FIXTURE_ID } });
    unregister?.();
    unregister = registerFixtureBackend();
  });

  it("a chat made before detection starts on Claude, then moves once the default is usable", () => {
    const id = get().newChat();
    expect(backendOf(id)).toBe("claude");
    useBackendUsability.setState({ usable: { claude: true, [FIXTURE_ID]: true } });
    expect(backendOf(id)).toBe(FIXTURE_ID);
    expect(get().notes[id]!.meta.backend).toBe(FIXTURE_ID);
  });

  it("a default found missing leaves it on Claude", () => {
    const id = get().newChat();
    useBackendUsability.setState({ usable: { claude: true, [FIXTURE_ID]: false } });
    expect(backendOf(id)).toBe("claude");
  });

  it("leaves a chat the user picked, and a chat with content", () => {
    const picked = get().newChat();
    get().setChatBackend(picked, "claude");
    const typed = get().newChat();
    get().setDraft(typed, { text: "half-written" });
    const free = get().newChat();
    useBackendUsability.setState({ usable: { claude: true, [FIXTURE_ID]: true } });
    expect(backendOf(picked)).toBe("claude");
    expect(backendOf(typed)).toBe("claude");
    expect(backendOf(free)).toBe(FIXTURE_ID);
  });

  it("follows the registry: a backend whose feature goes off is left", () => {
    useBackendUsability.setState({ usable: { claude: true, [FIXTURE_ID]: true } });
    const id = get().newChat();
    expect(backendOf(id)).toBe(FIXTURE_ID);
    unregister();
    expect(backendOf(id)).toBe("claude");
    unregister = registerFixtureBackend();
    expect(backendOf(id)).toBe(FIXTURE_ID);
  });
});

describe("a program path changes", () => {
  let detectBinary: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const mock = createMockAgentClient({ goldens: goldens as unknown as Goldens });
    detectBinary = vi.fn(async () => ({ ...(await mock.detectBinary({})), found: true }));
    configureAgentRuntimeForTests({ ...mock, detectBinary } as typeof mock);
    useAgentStore.setState(useAgentStore.getInitialState(), true);
    resetBackendUsabilityForTests();
    useSettingsStore.setState({ settings: {} });
  });

  it("looks again once a detection has been shown, and re-checks which backends are usable", async () => {
    await get().detectBinary("claude");
    const shown = get().binaries.claude;
    expect(useBackendUsability.getState().usable).toEqual({});
    useSettingsStore.setState({ settings: { "agent.binary-path": "/synthetic/bin/claude2" } });
    // the forced check ran (its answer is whatever the mocked IPC says), and the card's was redone
    await vi.waitFor(() => expect("claude" in useBackendUsability.getState().usable).toBe(true));
    await vi.waitFor(() => expect(get().binaries.claude).not.toBe(shown));
  });

  it("does nothing for a path nobody has looked at yet", () => {
    useSettingsStore.setState({ settings: { "agent.binary-path": "/synthetic/bin/claude2" } });
    expect(detectBinary).not.toHaveBeenCalled();
  });
});

describe("Choose binary…", () => {
  let setSetting: ReturnType<typeof vi.fn>;
  let found: boolean;
  beforeEach(() => {
    const mock = createMockAgentClient({ goldens: goldens as unknown as Goldens });
    found = true;
    configureAgentRuntimeForTests({
      ...mock,
      detectBinary: async () => ({
        ...(await mock.detectBinary({})),
        found,
        path: found ? "/p" : null,
      }),
    } as typeof mock);
    useAgentStore.setState(useAgentStore.getInitialState(), true);
    setSetting = vi.fn(async () => {});
    useSettingsStore.setState({ settings: {}, setSetting } as never);
    openMock.mockReset();
    openMock.mockResolvedValue("/synthetic/bin/picked");
  });

  it("saves the program under the backend's key when it is found", async () => {
    await chooseBinary("claude");
    expect(setSetting).toHaveBeenCalledWith("agent.binary-path", "/synthetic/bin/picked");
  });

  it("saves nothing and shows not found when it is not", async () => {
    found = false;
    await chooseBinary("claude");
    expect(setSetting).not.toHaveBeenCalled();
    expect(get().binaries.claude?.found).toBe(false);
  });

  it("does nothing when the dialog is dismissed", async () => {
    openMock.mockResolvedValue(null);
    await chooseBinary("claude");
    expect(setSetting).not.toHaveBeenCalled();
    expect(get().binaries.claude).toBeUndefined();
  });
});
