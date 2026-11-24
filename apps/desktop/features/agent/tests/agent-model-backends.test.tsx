// @vitest-environment jsdom
// The model chip of a chat on a backend with a live model list: the backend's enabled models, the
// effort levels limited to the Effort enum, none for a model without variants, the backend's own
// default keys, and "Set as default" writing them. Claude's chip is `agent-model.test.tsx`.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
vi.mock("@/lib/tauri", () => ({
  fuzzySearch: async () => [],
  resolveWikiLinkTarget: vi.fn(),
  recentLogErrors: vi.fn(async () => []),
  openLogFolder: vi.fn(),
}));

import { ModelChip } from "@features/agent/web/components/model-chip";
import { resetBackendModelsForTests } from "@/lib/features/agent-backends";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import {
  configureAgentRuntimeForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";
import { useSettingsStore } from "@/stores/settings-store";
import { FIXTURE_ID, FIXTURE_KEYS, registerFixtureBackend } from "./helpers/fixture-backend";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the model chip on a backend with a live list", () => {
  let container: HTMLElement;
  let root: Root;
  let unregister: () => void;
  let setSetting: ReturnType<typeof vi.fn>;
  let setModel: ReturnType<typeof vi.fn>;
  const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
  /** The model rows (the effort rows carry an aria-label). */
  const items = () =>
    [...container.querySelectorAll<HTMLElement>("[role=menuitemradio]:not([aria-label])")].map(
      (b) => (b.textContent ?? "").replace("✓ ", ""),
    );
  const chip = () => $("[data-agent-model-chip]")!;
  const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));
  const choose = async (label: RegExp) => {
    const item = [...container.querySelectorAll<HTMLElement>("[role=menuitemradio]")].find((b) =>
      label.test((b.textContent ?? "").replace("✓ ", "")),
    )!;
    await act(async () => item.click());
  };

  async function mount(settings: Record<string, unknown> = {}) {
    useSettingsStore.setState({
      settings: { [FIXTURE_KEYS.disabledModels]: ["acme/off"], ...settings },
      setSetting,
    } as never);
    act(() => void useAgentStore.getState().newChat());
    act(() =>
      useAgentStore.getState().setChatBackend(useAgentStore.getState().activeChatId!, FIXTURE_ID),
    );
    await act(async () =>
      root.render(<ModelChip chatId={useAgentStore.getState().activeChatId!} />),
    );
    await flush();
  }

  beforeEach(() => {
    const mock = createMockAgentClient({ goldens: goldens as unknown as Goldens });
    setModel = vi.fn(async () => {});
    setSetting = vi.fn(async () => {});
    configureAgentRuntimeForTests({ ...mock, setModel } as typeof mock);
    useAgentStore.setState(useAgentStore.getInitialState(), true);
    resetBackendModelsForTests();
    unregister = registerFixtureBackend();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    unregister();
  });

  it("lists Default and the backend's enabled models; a switched-off or retired one is left out", async () => {
    await mount();
    act(() => chip().click());
    expect(items()).toEqual(["Default", "Big (Acme)", "Plain (Acme)"]);
  });

  it("offers the model's variants that are in the Effort enum, never `none`", async () => {
    await mount({ [FIXTURE_KEYS.model]: "acme/big" });
    expect(chip().textContent).toContain("Big");
    act(() => chip().click());
    const efforts = [...container.querySelectorAll<HTMLElement>("[aria-label^='Effort ']")].map(
      (b) => b.getAttribute("aria-label"),
    );
    expect(efforts).toEqual(["Effort Default", "Effort low", "Effort high"]);
    // not "restarts the session": the backend applies effort live
    expect(container.textContent).not.toContain("restarts the session");
  });

  it("shows no effort levels for a model without variants", async () => {
    await mount({ [FIXTURE_KEYS.model]: "acme/plain" });
    act(() => chip().click());
    expect(container.querySelectorAll("[aria-label^='Effort ']")).toHaveLength(0);
  });

  it("picking a model before the first message sets the chat's choice with no live call", async () => {
    await mount();
    act(() => chip().click());
    await choose(/^Plain/);
    const id = useAgentStore.getState().activeChatId!;
    expect(useAgentStore.getState().chatModels[id]).toMatchObject({ model: "acme/plain" });
    expect(setModel).not.toHaveBeenCalled();
    expect(chip().textContent).toContain("Plain");
  });

  it("a new chat starts on the backend's own default model and effort", async () => {
    await mount({ [FIXTURE_KEYS.model]: "acme/big", [FIXTURE_KEYS.effort]: "high" });
    const id = useAgentStore.getState().activeChatId!;
    act(() => chip().click());
    expect($("[role=menuitemradio][aria-checked=true]")?.textContent).toContain("Big");
    expect($("[aria-label='Effort high']")?.getAttribute("aria-checked")).toBe("true");
    expect(useAgentStore.getState().chatModels[id]).toBeUndefined();
  });

  it("Set as default writes the backend's model and effort keys, not the Claude ones", async () => {
    await mount();
    act(() => chip().click());
    await choose(/^Big/);
    act(() => chip().click());
    await act(async () => $("[aria-label='Effort high']")!.click());
    act(() => chip().click());
    const setDefault = [...container.querySelectorAll<HTMLElement>("[role=menuitem]")].find((b) =>
      /Set as default/.test(b.textContent ?? ""),
    )!;
    await act(async () => setDefault.click());
    expect(setSetting).toHaveBeenCalledWith(FIXTURE_KEYS.model, "acme/big");
    expect(setSetting).toHaveBeenCalledWith(FIXTURE_KEYS.effort, "high");
    expect(setSetting.mock.calls.map((c) => c[0])).not.toContain("agent.model");
  });
});
