// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/tauri", () => ({ confirmAction: vi.fn(async () => true) }));

import { SecretsSection } from "../src/components/settings-panel/secrets-section";
import { confirmAction } from "../src/lib/tauri";
import { secretStoreLabelForPlatform } from "../src/components/sidebar/context-menu-utils";
import { detectPlatform } from "../src/lib/platform";
import { setSecretsClient, useSecretsStore } from "../src/stores/secrets-store";
import { workspaceListeners } from "../src/lib/features/workspace-events";
import { SecretStorage } from "../features/obsidian-host/web/host/api/secret-storage";
import { SecretComponent } from "../features/obsidian-host/web/host/api/ui";
import { installDomHelpers } from "../features/obsidian-host/web/host/api/dom";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VALUE = "synthetic-value-12345";
let store: Map<string, string>;
let failList: string | null;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  installDomHelpers(window);
  store = new Map([["alpha-key", VALUE]]);
  failList = null;
  setSecretsClient({
    listIds: async () => {
      if (failList) throw new Error(failList);
      return [...store.keys()].sort();
    },
    set: async (id: string, v: string) => void store.set(id, v),
    delete: async (id: string) => void store.delete(id),
  });
  useSecretsStore.setState({
    ids: [],
    status: "idle",
    error: null,
    actionError: null,
    busy: false,
  });
  const confirm = vi.mocked(confirmAction);
  confirm.mockResolvedValue(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => root.render(<SecretsSection />));
}
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  )!;

describe("Settings > Secrets", () => {
  it("lists names, never the value, and has no reveal or copy control", async () => {
    await mount();
    expect(container.querySelector('[data-secret="alpha-key"]')).not.toBeNull();
    expect(container.innerHTML).not.toContain(VALUE);
    expect(container.textContent).not.toMatch(/reveal|show value|copy/i);
    expect(container.querySelectorAll('input[type="password"]').length).toBe(1);
  });

  it("shows an empty state", async () => {
    store.clear();
    await mount();
    expect(container.querySelector("[data-secrets-empty]")).not.toBeNull();
  });

  it("shows a keychain error with a retry that recovers", async () => {
    failList = "keychain locked";
    await mount();
    const notice = container.querySelector("[data-secrets-error]")?.textContent ?? "";
    expect(notice).toContain("keychain locked");
    expect(notice).toContain(`couldn't read the ${secretStoreLabelForPlatform(detectPlatform())}`);
    expect(notice).toContain("run without them");
    failList = null;
    await act(async () => button("Retry").click());
    expect(container.querySelector("[data-secrets-error]")).toBeNull();
    expect(container.querySelector('[data-secret="alpha-key"]')).not.toBeNull();
  });

  it("adds a secret write-only, validates the name, and clears the value field", async () => {
    await mount();
    const [name, value] = [
      container.querySelector<HTMLInputElement>('input[aria-label="Secret name"]')!,
      container.querySelector<HTMLInputElement>('input[aria-label="Secret value"]')!,
    ];
    await type(name, "Bad Name");
    await type(value, "v1");
    await act(async () => button("Add").click());
    expect(container.textContent).toContain("lowercase letters, digits and dashes");
    expect(store.has("Bad Name")).toBe(false);

    await type(name, "beta-2");
    await act(async () => button("Add").click());
    expect(store.get("beta-2")).toBe("v1");
    expect(container.querySelector('[data-secret="beta-2"]')).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Secret value"]')!.value,
    ).toBe("");
    expect(container.innerHTML).not.toContain(">v1<");
  });

  it("replaces a value without showing the old one", async () => {
    await mount();
    await act(async () => button("Replace value of alpha-key").click());
    const field = container.querySelector<HTMLInputElement>(
      'input[aria-label="New value for alpha-key"]',
    )!;
    expect(field.value).toBe("");
    await type(field, "rotated");
    await act(async () => button("Save").click());
    expect(store.get("alpha-key")).toBe("rotated");
    expect(container.querySelector('input[aria-label="New value for alpha-key"]')).toBeNull();
  });

  it("deletes only after confirmation", async () => {
    await mount();
    vi.mocked(confirmAction).mockResolvedValueOnce(false);
    await act(async () => button("Delete alpha-key").click());
    expect(store.has("alpha-key")).toBe(true);
    await act(async () => button("Delete alpha-key").click());
    expect(store.has("alpha-key")).toBe(false);
    expect(container.querySelector("[data-secrets-empty]")).not.toBeNull();
  });

  it("shows a failed write and keeps the list", async () => {
    setSecretsClient({
      listIds: async () => ["alpha-key"],
      set: async () => {
        throw new Error("IO error: denied");
      },
      delete: async () => {},
    });
    await mount();
    await act(async () => button("Replace value of alpha-key").click());
    await type(
      container.querySelector<HTMLInputElement>('input[aria-label="New value for alpha-key"]')!,
      "x",
    );
    await act(async () => button("Save").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("denied");
  });
});

describe("one store for the section and plugins' SecretComponent", () => {
  it("a secret saved in Settings reaches a running plugin's storage, and back", async () => {
    const storage = new SecretStorage();
    // What the Obsidian host feature registers, without activating the feature itself.
    const off = workspaceListeners.add("t.secrets", {
      owner: "t",
      id: "t.secrets",
      onSecretChanged: (id: string, v: string | null) => storage.applyExternal(id, v),
    });
    try {
      await useSecretsStore.getState().save("gamma", "g1");
      expect(storage.getSecret("gamma")).toBe("g1");
      await useSecretsStore.getState().remove("gamma");
      expect(storage.getSecret("gamma")).toBeNull();
    } finally {
      off();
    }
  });

  it("SecretComponent picks from listSecrets, creates through setSecret, and returns only the name", () => {
    const storage = new SecretStorage();
    storage.setSecret("from-settings", VALUE);
    const host = document.createElement("div");
    const picked: string[] = [];
    const c = new SecretComponent({ secretStorage: storage } as never, host).onChange(
      (n) => void picked.push(n),
    );
    const options = () => [...host.querySelectorAll("option")].map((o) => o.textContent);
    expect(options()).toEqual(["Select secret…", "from-settings", "Create new secret…"]);
    expect(host.innerHTML).not.toContain(VALUE);

    c.selectEl.value = "from-settings";
    c.selectEl.dispatchEvent(new Event("change"));
    expect(picked).toEqual(["from-settings"]);
    expect(c.getValue()).toBe("from-settings");

    c.selectEl.value = "\u0000create";
    c.selectEl.dispatchEvent(new Event("change"));
    const [name, pw] = host.querySelectorAll<HTMLInputElement>(".secret-component-form input");
    expect(pw.type).toBe("password");
    name.value = "Bad";
    pw.value = "v";
    host.querySelector<HTMLButtonElement>(".secret-component-form .mod-cta")!.click();
    expect(storage.getSecret("Bad")).toBeNull();
    name.value = "new-one";
    host.querySelector<HTMLButtonElement>(".secret-component-form .mod-cta")!.click();
    expect(storage.getSecret("new-one")).toBe("v");
    expect(picked).toEqual(["from-settings", "new-one"]);
    expect(host.querySelector(".secret-component-form")).toBeNull();
    expect(options()).toContain("new-one");
  });
});
