// @vitest-environment jsdom
import process from "node:process";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { PluginViewPane } from "../web/components/plugin-view-pane";
import { usePluginsStore } from "../web/stores/plugins-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeLeaf(id: string, title: string) {
  const containerEl = document.createElement("div");
  containerEl.textContent = `body ${id}`;
  return {
    id,
    containerEl,
    view: { getDisplayText: () => title, getViewType: () => id },
  } as never;
}

let container: HTMLElement;
let root: Root;
const a = fakeLeaf("a", "Alpha");
const b = fakeLeaf("b", "Beta");

beforeEach(() => {
  usePluginsStore.setState({ leaves: [a, b], activeLeaf: a, isPaneOpen: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = () => act(async () => root.render(<PluginViewPane />));

describe("PluginViewPane", () => {
  it("switches the active leaf when a tab is clicked", async () => {
    await render();
    const tabs = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
    expect(tabs.map((t) => t.textContent)).toEqual(["Alpha", "Beta"]);
    await act(async () => tabs[1].click());
    expect(usePluginsStore.getState().activeLeaf).toBe(b);
    expect(container.textContent).toContain("body b");
  });

  it("closes the pane with the close button", async () => {
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Close plugin pane']")!.click(),
    );
    expect(usePluginsStore.getState().isPaneOpen).toBe(false);
    expect(container.querySelector("aside")).toBeNull();
  });

  // jsdom has no layout, so hit-testing cannot be exercised here. The real-window cause was the
  // full-width window drag region (z-30) and editor tab bar (z-40) overlaying the pane header,
  // swallowing clicks. Pin the stacking contract that fixes it.
  it("lifts the header above the window chrome without blocking window drags", async () => {
    await render();
    const header = container.querySelector("[data-plugin-pane-header]")!;
    expect(header.className).toContain("z-50");
    expect(header.className).toContain("pointer-events-none");
    for (const control of header.querySelectorAll("button")) {
      expect(control.closest(".pointer-events-auto")).not.toBeNull();
    }
  });
});

describe("plugin leaf host structure", () => {
  it("nests leaf > leaf-content[data-type] > header + view-content in a definite-height flex column", async () => {
    const { ItemView, WorkspaceLeaf } = await import("../web/host/api/views");
    const { installObsidianTheme } = await import("../web/host/api/theme-compat");
    const { installDomHelpers } = await import("../web/host/api/dom");
    installDomHelpers(window);
    class V extends ItemView {
      getViewType() {
        return "chat-view";
      }
    }
    const app = {
      workspace: {
        viewCreator: () => ({ creator: (l: never) => new V(l) }),
        bridge: { leafChanged() {} },
      },
      modals: new Set(),
    } as never;
    const leaf = new WorkspaceLeaf(app, "right");
    await leaf.setViewState({ type: "chat-view" });
    expect(leaf.containerEl.className).toBe("workspace-leaf");
    const content = leaf.containerEl.firstElementChild as HTMLElement;
    expect(content.className).toBe("workspace-leaf-content");
    expect(content.dataset.type).toBe("chat-view");
    // Plugins index containerEl.children[1] for the content area.
    expect(content.children[0].className).toBe("view-header");
    expect(content.children[1].className).toBe("view-content");
    const css =
      (installObsidianTheme(document),
      document.querySelector("style[data-writer-obsidian-theme]")!.textContent!);
    expect(css).toMatch(
      /:where\(\.workspace-leaf\) \{[^}]*flex-direction: column;[^}]*height: 100%;[^}]*min-height: 0/,
    );
    expect(css).toMatch(
      /:where\(\.workspace-leaf-content > \.view-content\) \{[^}]*flex: 1 1 auto;[^}]*min-height: 0/,
    );
    // The React side hosts the leaf in a flex column that clips (plugins scroll internally).
    usePluginsStore.setState({ leaves: [leaf], activeLeaf: leaf, isPaneOpen: true });
    await act(async () => root.render(<PluginViewPane />));
    const host = container.querySelector("[data-plugin-leaf-host]")!;
    expect(host.className).toContain("flex-col");
    expect(host.className).toContain("overflow-hidden");
    expect(host.firstElementChild).toBe(leaf.containerEl);
  });
});

describe("plugin content text selection", () => {
  it("excludes plugin-hosted content from the global user-select:none and re-enables text selection", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/src/App.css`, "utf8");
    const noneRule = css.slice(
      css.indexOf("*:not(.cm-editor)"),
      css.indexOf("}", css.indexOf("*:not(.cm-editor)")),
    );
    expect(noneRule).toContain("[data-plugin-leaf-host] *");
    expect(noneRule).toContain(".modal-container *");
    expect(noneRule).toContain("user-select: none");
    expect(css).toMatch(
      /\n\.markdown-rendered \* \{\s*-webkit-user-select: text;\s*user-select: text;/,
    );
    const controls = css.slice(css.indexOf(".view-actions"));
    expect(controls.slice(0, controls.indexOf("}"))).toContain("user-select: none");
  });

  it("restores body user-select after a resize drag", async () => {
    usePluginsStore.setState({ leaves: [a], activeLeaf: a, isPaneOpen: true });
    await render();
    document.body.style.userSelect = "auto";
    const handle = container.querySelector<HTMLElement>("[role=separator]")!;
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100 }),
      );
    });
    expect(document.body.style.userSelect).toBe("none");
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup"));
    });
    expect(document.body.style.userSelect).toBe("auto");
  });
});
