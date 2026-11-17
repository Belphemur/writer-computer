// @vitest-environment jsdom
// The project badge on the sidebar tree: the agent feature contributes it through
// `fileTreeDecorations`, core draws it, and it goes away with the kill switch.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import { FileTreeDecorations } from "@/components/sidebar/file-tree-decorations";
import { createFeatureHost } from "@/lib/features/registry";
import type { DirEntry } from "@/types/fs";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";
import agentFeature from "../web/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host = createFeatureHost({ onError: () => {}, listen: (async () => () => {}) as never });
const dir = (path: string) => ({ name: path.split("/").pop()!, path, is_dir: true }) as DirEntry;
const file = (path: string) => ({ name: path.split("/").pop()!, path, is_dir: false }) as DirEntry;
const BADGE = "[data-testid=project-badge]";

let container: HTMLElement;
let root: Root;
const render = (e: DirEntry) => act(async () => root.render(<FileTreeDecorations entry={e} />));

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useProjectsStore.setState({ folderPaths: new Set(["/v/Projects/Acme"]) });
  host.register(agentFeature);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const id of host.list()) await host.unregister(id);
});

describe("project badge", () => {
  it("marks a project folder, not another folder and not a file at that path", async () => {
    await render(dir("/v/Projects/Acme"));
    const badge = container.querySelector(BADGE)!;
    expect(badge.getAttribute("aria-label")).toBe("Agent project");
    await render(dir("/v/Projects"));
    expect(container.querySelector(BADGE)).toBeNull();
    await render(file("/v/Projects/Acme"));
    expect(container.querySelector(BADGE)).toBeNull();
  });

  it("is gone when the agent feature is off", async () => {
    await render(dir("/v/Projects/Acme"));
    expect(container.querySelector(BADGE)).not.toBeNull();
    await act(async () => host.unregister("agent"));
    expect(container.querySelector(BADGE)).toBeNull();
  });
});
