// @vitest-environment jsdom
// Webview failure containment (SPECs/builtin-plugins-spec.md section 16): a throwing contribution
// is contained by its error boundary or the host's try/catch, three failures switch the feature
// off for the session, `features:failed` from Rust does the same at once, safe mode turns every
// feature off without touching settings, and the Features section offers "Turn back on".
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), log: vi.fn() },
  describeError: (e: unknown) => ({ message: String(e) }),
}));

import { FeatureBoundary } from "../src/components/feature-boundary";
import { FeatureHealthNotices } from "../src/components/feature-health-notices";
import { FeaturesSection } from "../src/components/settings-panel/features-section";
import { syncBuiltinFeatures } from "../src/lib/features/builtin";
import {
  editorExtensionContributions,
  featureEditorExtensions,
} from "../src/lib/features/editor-extensions";
import { startFeatureHealthBridge } from "../src/lib/features/health-bridge";
import { contributedEditorBodyItems } from "../src/lib/features/menus";
import { createFeatureHost, defineFeature } from "../src/lib/features/registry";
import { keybindings } from "../src/lib/keybindings/registry";
import { tableExtension } from "../features/tables/web/extension";
import {
  FAILURE_LIMIT,
  isOffForSession,
  useFeatureHealth,
} from "../src/stores/feature-health-store";
import { useSettingsStore } from "../src/stores/settings-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => new Promise((r) => setTimeout(r, 0));
const boom = () => {
  throw new Error("boom");
};
const health = () => useFeatureHealth.getState();
const initial = useFeatureHealth.getState();

const host = createFeatureHost({
  onError: () => {},
  listen: (async () => () => {}) as never,
});

beforeEach(() => {
  useFeatureHealth.setState({
    ...initial,
    failures: {},
    sessionOff: {},
    crashDisabled: [],
    dismissed: {},
    safeMode: false,
  });
  invoke.mockReset();
});
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

describe("the health store", () => {
  it("the third failure of one feature switches it off for the session", () => {
    for (let i = 1; i < FAILURE_LIMIT; i++) health().recordFailure("demo", "command");
    expect(isOffForSession(health(), "demo")).toBe(false);
    health().recordFailure("demo", "command");
    expect(isOffForSession(health(), "demo")).toBe(true);
    expect(isOffForSession(health(), "other")).toBe(false);
  });

  it("a failure from Rust switches it off at once, safe mode switches everything off", () => {
    health().markFailedByRust("demo", "setup");
    expect(isOffForSession(health(), "demo")).toBe(true);
    expect(health().failures.demo?.boundary).toBe("setup");
    health().applyStatus({ safeMode: true, crashDisabled: [], failures: [] });
    expect(isOffForSession(health(), "anything")).toBe(true);
  });

  it("clear forgets the failures and the crash entry", () => {
    health().applyStatus({
      safeMode: false,
      crashDisabled: [{ id: "demo", setting: "features.demo.enabled", boundary: "setup" }],
      failures: [{ id: "demo", boundary: "command", at: 1 }],
    });
    health().clear("demo");
    expect(health().failures).toEqual({});
    expect(health().sessionOff).toEqual({});
    expect(health().crashDisabled).toEqual([]);
  });
});

describe("the feature host contains a throwing contribution", () => {
  const def = (run: () => void) =>
    defineFeature({
      id: "demo",
      contributes: {
        keybindings: [{ id: "demo.key", keys: ["Mod+Alt+D"], description: "x", run }],
      },
    });

  it("a throwing keybinding does not throw at the key press and is counted", async () => {
    host.register(def(boom));
    const b = keybindings.find(
      new KeyboardEvent("keydown", { key: "d", metaKey: true, altKey: true, cancelable: true }),
      "bubble",
    )!;
    expect(() => b.run(new KeyboardEvent("keydown"))).not.toThrow();
    await flush();
    expect(health().failures.demo?.count).toBe(1);
    expect(health().failures.demo?.boundary).toBe("command");
  });

  it("a throwing activate is counted too", async () => {
    host.register(defineFeature({ id: "demo", activate: boom }));
    await expect(host.activate("demo")).rejects.toThrow("boom");
    expect(health().failures.demo?.boundary).toBe("activate");
  });

  it("three failures switch the feature off: the loader unregisters it and the setting stays", async () => {
    const features = [{ manifest: { id: "demo", enabledByDefault: true }, definition: def(boom) }];
    const settings = {};
    const sync = () =>
      syncBuiltinFeatures(host, features, settings, (id) => isOffForSession(health(), id));
    sync();
    expect(host.list()).toEqual(["demo"]);
    for (let i = 0; i < FAILURE_LIMIT; i++) health().recordFailure("demo", "command");
    sync();
    await flush(); // unregister is asynchronous
    expect(host.list()).toEqual([]);
    expect(settings).toEqual({});
    health().clear("demo");
    sync();
    expect(host.list()).toEqual(["demo"]);
  });

  it("safe mode registers no feature", () => {
    const features = [
      { manifest: { id: "demo", enabledByDefault: true }, definition: def(() => {}) },
    ];
    health().applyStatus({ safeMode: true, crashDisabled: [], failures: [] });
    syncBuiltinFeatures(host, features, {}, (id) => isOffForSession(health(), id));
    expect(host.list()).toEqual([]);
  });
});

describe("a throwing menu item and editor extension", () => {
  it("a throwing menu contribution is skipped, counted, and the others still contribute", async () => {
    const { editorBodyMenuContributions } = await import("../src/lib/features/menus");
    editorBodyMenuContributions.add("bad.menu", {
      owner: "builtin:bad",
      id: "bad.menu",
      items: boom,
    });
    editorBodyMenuContributions.add("good.menu", {
      owner: "builtin:good",
      id: "good.menu",
      items: () => [{ label: "ok" } as never],
    });
    const items = await contributedEditorBodyItems({} as never, {} as never);
    expect(items).toHaveLength(1);
    expect(health().failures.bad?.boundary).toBe("menu");
    expect(health().failures.good).toBeUndefined();
    editorBodyMenuContributions.removeOwner("builtin:bad");
    editorBodyMenuContributions.removeOwner("builtin:good");
  });

  it("a load that rejects, or an extension that cannot build a state, is dropped and counted", async () => {
    featureEditorExtensions(); // an editor exists: loads start
    editorExtensionContributions.add("bad.load", {
      owner: "builtin:badload",
      id: "bad.load",
      load: () => Promise.reject(new Error("no chunk")),
    });
    const { StateField } = await import("@codemirror/state");
    editorExtensionContributions.add("bad.state", {
      owner: "builtin:badstate",
      id: "bad.state",
      load: async () =>
        StateField.define({
          create: () => {
            throw new Error("bad field");
          },
          update: (v) => v,
        }),
    });
    await flush();
    await flush();
    expect(health().failures.badload?.boundary).toBe("editor-extension");
    expect(health().failures.badstate?.boundary).toBe("editor-extension");
    editorExtensionContributions.removeOwner("builtin:badload");
    editorExtensionContributions.removeOwner("builtin:badstate");
  });

  it("the real tables extension still builds an editor state", () => {
    expect(() => EditorState.create({ extensions: tableExtension() })).not.toThrow();
  });
});

describe("the error boundary", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(async () => {
    useSettingsStore.setState({ settings: {}, setSetting: vi.fn(async () => {}) } as never);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("a contribution that throws renders the placeholder and the rest of the pane works", async () => {
    const Bad = () => {
      throw new Error("render boom");
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () =>
      root.render(
        <div>
          <FeatureBoundary feature="demo">
            <Bad />
          </FeatureBoundary>
          <FeatureBoundary feature="fine">
            <p data-testid="fine">still here</p>
          </FeatureBoundary>
        </div>,
      ),
    );
    consoleError.mockRestore();
    expect(container.querySelector('[data-feature-failed="demo"]')?.textContent).toContain(
      "This feature failed",
    );
    expect(container.querySelector('[data-testid="fine"]')?.textContent).toBe("still here");
    expect(health().failures.demo?.boundary).toBe("render");
  });

  it("its Turn off action switches the feature's setting off", async () => {
    const setSetting = vi.fn(async () => {});
    useSettingsStore.setState({ settings: {}, setSetting } as never);
    const Bad = () => {
      throw new Error("x");
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () =>
      root.render(
        <FeatureBoundary feature="demo">
          <Bad />
        </FeatureBoundary>,
      ),
    );
    consoleError.mockRestore();
    await act(async () => container.querySelector("button")!.click());
    expect(setSetting).toHaveBeenCalledWith("features.demo.enabled", false);
  });

  it("the notices show safe mode with Restart normally, and the crash and session notices", async () => {
    health().applyStatus({
      safeMode: true,
      crashDisabled: [{ id: "agent", setting: "features.agent.enabled", boundary: "setup" }],
      failures: [{ id: "tables", boundary: "command", at: 1 }],
    });
    await act(async () => root.render(<FeatureHealthNotices />));
    expect(container.querySelector('[data-notice="safe-mode"]')).not.toBeNull();
    expect(container.textContent).toContain("Agent was turned off after a crash");
    expect(container.textContent).toContain("Tables failed");
    invoke.mockResolvedValue(undefined);
    const restart = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Restart normally",
    )!;
    await act(async () => restart.click());
    expect(invoke).toHaveBeenCalledWith("features_restart_normally");
  });

  it("Settings > Features shows the failure and Turn back on clears it and sets the setting", async () => {
    const setSetting = vi.fn(async () => {});
    useSettingsStore.setState({ settings: {}, setSetting } as never);
    health().applyStatus({
      safeMode: false,
      crashDisabled: [{ id: "agent", setting: "features.agent.enabled", boundary: "setup" }],
      failures: [{ id: "tables", boundary: "command", at: 1 }],
    });
    await act(async () => root.render(<FeaturesSection />));
    const agent = container.querySelector('[data-feature-failure="agent"]')!;
    expect(agent.textContent).toContain("Turned off after a crash (setup)");
    expect(container.querySelector('[data-feature-failure="tables"]')?.textContent).toContain(
      "Failed in command",
    );
    const turnOn = agent.querySelector("button")!;
    await act(async () => turnOn.click());
    expect(setSetting).toHaveBeenCalledWith("features.agent.enabled", true);
    expect(health().crashDisabled).toEqual([]);
  });
});

describe("the Rust bridge", () => {
  it("features:failed switches the web half off and the status fills the notices", async () => {
    let handler: ((e: { payload: { id: string; boundary: string } }) => void) | undefined;
    const listen = vi.fn(async (_n: string, h: never) => {
      handler = h;
      return () => {};
    });
    startFeatureHealthBridge({
      listen: listen as never,
      status: async () => ({
        safeMode: false,
        crashDisabled: [{ id: "agent", setting: "features.agent.enabled", boundary: "native" }],
        failures: [],
      }),
    });
    await flush();
    expect(listen).toHaveBeenCalledWith("features:failed", expect.any(Function));
    expect(health().crashDisabled).toHaveLength(1);
    handler!({ payload: { id: "demo", boundary: "thread:x" } });
    expect(isOffForSession(health(), "demo")).toBe(true);
  });
});
