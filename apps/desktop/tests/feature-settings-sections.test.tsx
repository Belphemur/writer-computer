// @vitest-environment jsdom
// Feature pages in the Settings sidebar: contributed through the registry (the Agent), generated
// for a feature with settings or secrets and no page of its own, absent for one with neither.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

const { WITH_SECRET_ID, PLAIN_ID } = vi.hoisted(() => ({
  WITH_SECRET_ID: "fixture-secrets",
  PLAIN_ID: "plain-fixture",
}));
vi.mock("../src/lib/features/manifests", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/features/manifests")>();
  const fixture = (
    await import("../src-tauri/tests/fixtures/features/fixture-secrets/feature.json")
  ).default;
  const plain = { id: "plain-fixture", name: "Plain fixture", version: "0.0.0", description: "-" };
  return { ...real, FEATURE_MANIFESTS: [...real.FEATURE_MANIFESTS, fixture, plain] };
});
vi.mock("../src/lib/settings-schema", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/settings-schema")>();
  const def = {
    key: "fixture-secrets.greeting",
    label: "Fixture greeting",
    description: "Test row.",
    category: "Features",
    type: "string",
    default: "hello",
  };
  return { ...real, FEATURE_SETTINGS: { ...real.FEATURE_SETTINGS, [WITH_SECRET_ID]: [def] } };
});

import agentFeature from "../features/agent/web/index";
import { SettingsPanel } from "../src/components/settings-panel";
import { FeaturesSection } from "../src/components/settings-panel/features-section";
import { featureHost } from "../src/lib/features/registry";
import { setFeatureSecretsClient } from "../src/stores/feature-secrets-store";
import { useFeatureHealth } from "../src/stores/feature-health-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useUIStore } from "../src/stores/ui-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
const flush = () => act(async () => {});

function setSettings(values: Record<string, unknown>) {
  useSettingsStore.setState({ settings: values, isLoaded: true } as never);
}
async function mount(section: string) {
  useUIStore.setState({ settingsSection: section });
  await act(async () => root.render(<SettingsPanel isActive />));
  await flush();
}
const tabs = () =>
  [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((t) => t.textContent);
const q = (sel: string) => container.querySelector<HTMLElement>(sel);

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
  setFeatureSecretsClient({
    keysSet: async () => [],
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  });
  setSettings({});
  useFeatureHealth.setState({ safeMode: false, sessionOff: {} } as never);
  useWorkspaceStore.setState({ root: "/synthetic-vault" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await featureHost.unregister("agent");
});

describe("the Agent page", () => {
  it("is in the sidebar only while the agent feature is on, and is the one place for its settings", async () => {
    setSettings({ "features.agent.enabled": false });
    await mount("editor");
    expect(tabs()).not.toContain("Agent");

    // switched on: the feature registers (`syncBuiltinFeatures`) and its page appears
    setSettings({});
    featureHost.register(agentFeature);
    await flush();
    expect(tabs().filter((t) => t === "Agent")).toHaveLength(1);
    // its own page, not a generated one
    expect(q("#settings-tab-agent")).not.toBeNull();
    expect(q("[id='settings-tab-feature:agent']")).toBeNull();
    // placed between Files & vault and the Features page
    expect(tabs().indexOf("Agent")).toBe(tabs().indexOf("Files & vault") + 1);

    await mount("agent");
    await vi.waitFor(() => expect(q("[data-agent-status]")).not.toBeNull());
    expect(container.querySelectorAll("[data-agent-status]")).toHaveLength(1);

    setSettings({ "features.agent.enabled": false });
    await act(async () => featureHost.unregister("agent"));
    await flush();
    expect(tabs()).not.toContain("Agent");
    // the remembered selection falls back to a page that exists, nothing broken is shown
    expect(q("[data-agent-status]")).toBeNull();
    expect(q('[role="tab"][aria-selected="true"]')).not.toBeNull();
  });

  it("is not duplicated on the Features page", async () => {
    featureHost.register(agentFeature);
    await mount("features");
    expect(container.textContent).not.toContain("Claude binary");
    expect(q("[data-agent-status]")).toBeNull();
    expect(q("[data-feature='agent']")).not.toBeNull();
  });
});

describe("a feature without a page of its own", () => {
  it("gets a generated page with its settings rows and a Secrets group", async () => {
    await mount("editor");
    expect(tabs()).toContain("Fixture secrets");
    await mount(`feature:${WITH_SECRET_ID}`);
    await vi.waitFor(() => expect(q("[data-feature-secrets]")).not.toBeNull());
    expect(container.textContent).toContain("Fixture greeting");
    const secrets = q("[data-feature-secrets]")!;
    expect(secrets.textContent).toContain("Secrets");
    expect(secrets.textContent).toContain("API token");
    expect(secrets.textContent).toContain("Not set");
  });

  it("has no page when its feature is off, and none at all with neither settings nor secrets", async () => {
    setSettings({ [`features.${WITH_SECRET_ID}.enabled`]: false });
    await mount("editor");
    expect(tabs()).not.toContain("Fixture secrets");
    setSettings({});
    await flush();
    expect(tabs()).toContain("Fixture secrets");
    // the plain fixture and Tables have neither: no sidebar item
    expect(tabs()).not.toContain("Plain fixture");
    expect(tabs()).not.toContain("Tables");
    // a feature that failed this session shows nothing broken either
    useFeatureHealth.setState({ sessionOff: { [WITH_SECRET_ID]: true } } as never);
    await flush();
    expect(tabs()).not.toContain("Fixture secrets");
  });

  it("is never shown on the Features page", async () => {
    await act(async () => root.render(<FeaturesSection />));
    const row = q(`[data-feature="${WITH_SECRET_ID}"]`)!;
    expect(row).not.toBeNull();
    expect(row.querySelector("[aria-expanded]")).toBeNull();
    expect(row.textContent).not.toContain("Fixture greeting");
    expect(row.textContent).not.toContain("API token");
    expect(q(`[data-feature="${PLAIN_ID}"]`)).not.toBeNull();
  });
});
