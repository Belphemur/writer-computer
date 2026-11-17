// @vitest-environment jsdom
// The `fileTreeDecorations` contribution point (SPECs/builtin-plugins-spec.md section 6.5): a
// feature draws a badge on sidebar tree rows through one hook; core draws it, names no feature,
// removes it with the kill switch and contains a hook that throws.
import { SparklesIcon } from "@hugeicons/core-free-icons";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), log: vi.fn() },
  describeError: (e: unknown) => ({ message: String(e) }),
}));

import { FileTreeDecorations } from "@/components/sidebar/file-tree-decorations";
import { fileTreeDecorationContributions } from "@/lib/features/file-tree";
import { createFeatureHost, defineFeature } from "@/lib/features/registry";
import type { FileTreeBadge } from "@/lib/features/types";
import { useFeatureHealth } from "@/stores/feature-health-store";
import type { DirEntry } from "@/types/fs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host = createFeatureHost({ onError: () => {}, listen: (async () => () => {}) as never });
const entry = (name: string, is_dir = false) => ({ name, path: `/v/${name}`, is_dir }) as DirEntry;
const BADGE: FileTreeBadge = { label: "Marked", icon: SparklesIcon, testId: "fixture-badge" };
const initialHealth = useFeatureHealth.getState();

const marking = (useBadge: (e: DirEntry) => FileTreeBadge | null) =>
  defineFeature({
    id: "deco",
    contributes: { fileTreeDecorations: [{ id: "deco.mark", useBadge }] },
  });

let container: HTMLElement;
let root: Root;
const render = (e: DirEntry) => act(async () => root.render(<FileTreeDecorations entry={e} />));

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useFeatureHealth.setState({ ...initialHealth, failures: {}, sessionOff: {}, safeMode: false });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const id of host.list()) await host.unregister(id);
});

describe("file tree decorations", () => {
  it("draws nothing without a contribution", async () => {
    await render(entry("docs", true));
    expect(container.innerHTML).toBe("");
  });

  it("draws the badge a feature's hook returns, per entry, with its label as the tooltip", async () => {
    host.register(marking((e) => (e.is_dir ? BADGE : null)));
    await render(entry("docs", true));
    const badge = container.querySelector("[data-testid=fixture-badge]")!;
    expect(badge.getAttribute("aria-label")).toBe("Marked");
    expect(badge.getAttribute("title")).toBe("Marked");
    await render(entry("a.md"));
    expect(container.querySelector("[data-testid=fixture-badge]")).toBeNull();
  });

  it("removes the badge when the feature is unregistered and removes only its own entry", async () => {
    host.register(marking(() => BADGE));
    await render(entry("docs", true));
    expect(fileTreeDecorationContributions.size).toBe(1);
    await act(async () => host.unregister("deco"));
    expect(fileTreeDecorationContributions.size).toBe(0);
    expect(container.querySelector("[data-testid=fixture-badge]")).toBeNull();
  });

  it("refuses an id outside the feature's namespace", () => {
    expect(() =>
      defineFeature({
        id: "deco",
        contributes: { fileTreeDecorations: [{ id: "other.mark", useBadge: () => null }] },
      }),
    ).toThrow(/must start with "deco\."/);
  });

  it("contains a hook that throws: nothing drawn, one strike on its feature", async () => {
    host.register(
      marking(() => {
        throw new Error("boom");
      }),
    );
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await render(entry("docs", true));
    quiet.mockRestore();
    expect(container.innerHTML).toBe("");
    expect(useFeatureHealth.getState().failures["deco"]?.boundary).toBe("render");
  });
});
