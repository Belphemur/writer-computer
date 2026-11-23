// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: {
    target: "/home/ada/.local/bin/writer",
    installed: false,
    state: "missing",
    onPath: false,
    package: false,
  } as import("../src/lib/tauri").CliInstallStatus,
  installError: null as string | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/tauri", () => ({
  cliStatus: vi.fn(async () => state.status),
  installCli: vi.fn(async () => {
    if (state.installError) throw new Error(state.installError);
    state.status = { ...state.status, installed: true, state: "installed" };
    return state.status;
  }),
  uninstallCli: vi.fn(async () => {
    state.status = { ...state.status, installed: false, state: "missing" };
    return state.status;
  }),
}));

import { CliSection, cliStateLabel } from "../src/components/settings-panel/cli-section";
import { SETTINGS_SECTIONS } from "../src/components/settings-panel/settings-sections";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<CliSection />));
}
beforeEach(() => {
  root = undefined as unknown as Root;
  state.status = {
    target: "/home/ada/.local/bin/writer",
    installed: false,
    state: "missing",
    onPath: false,
    package: false,
  };
  state.installError = null;
});
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label);

describe("Settings > Command line", () => {
  it("is a registered section", () => {
    const section = SETTINGS_SECTIONS.find((s) => s.id === "command-line")!;
    expect(section.blocks).toContainEqual({ type: "cli" });
  });

  it("installs, then says when the folder is not on the PATH, then removes", async () => {
    await mount();
    expect(container.querySelector("[data-cli-state]")!.textContent).toBe("Not installed");
    expect(container.querySelector("[data-cli-path-hint]")).toBeNull();

    await act(async () => button("Install")!.click());
    expect(container.querySelector("[data-cli-state]")!.textContent).toBe("Installed");
    expect(container.querySelector("[data-cli-path-hint]")!.textContent).toBe(
      "/home/ada/.local/bin is not on your PATH.",
    );

    await act(async () => button("Remove")!.click());
    expect(container.querySelector("[data-cli-state]")!.textContent).toBe("Not installed");
  });

  it("shows no hint when the folder is on the PATH", async () => {
    state.status = { ...state.status, installed: true, state: "installed", onPath: true };
    await mount();
    expect(container.querySelector("[data-cli-path-hint]")).toBeNull();
  });

  it("a package's link has no button", async () => {
    state.status = {
      target: "/usr/bin/writer",
      installed: true,
      state: "installed",
      onPath: true,
      package: true,
    };
    await mount();
    expect(container.querySelector("[data-cli-state]")!.textContent).toBe(
      "Installed by the package",
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows the reason when installing fails", async () => {
    state.installError = "no permission to write /x";
    await mount();
    await act(async () => button("Install")!.click());
    expect(container.querySelector("[data-cli-message]")!.textContent).toContain(
      "no permission to write /x",
    );
  });

  it("labels every state", () => {
    const base = { target: "/t", installed: false, onPath: true, package: false } as const;
    expect(cliStateLabel({ ...base, state: "stale" })).toMatch(/another copy/);
    expect(cliStateLabel({ ...base, state: "foreign" })).toMatch(/in the way/);
  });
});
