// @vitest-environment jsdom
// The model chip's menu, one component for every backend: the search field only over the
// threshold, provider headers only with several providers, and the keyboard flow (typing filters,
// arrows move, Enter picks, Esc closes).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChipMenu } from "@features/agent/web/components/chip-menu";
import { MODEL_SEARCH_THRESHOLD, ModelList } from "@features/agent/web/components/model-list";
import type { ModelChoice } from "@features/agent/web/lib/model-catalog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const choice = (id: string, provider?: string): ModelChoice => ({
  id,
  label: provider ? `${id} (${provider})` : id,
  name: provider ? id : undefined,
  provider,
  value: id,
  supportsEffort: false,
  efforts: [],
});
const DEFAULT: ModelChoice = {
  id: "default",
  label: "Default",
  value: null,
  supportsEffort: false,
};
const many = (n: number, providers: string[]) =>
  Array.from({ length: n }, (_, i) => choice(`m${i}`, providers[i % providers.length]));

describe("the model menu", () => {
  let container: HTMLElement;
  let root: Root;
  const picked = vi.fn();
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const labels = () => qa("[role=menuitemradio]").map((e) => e.textContent!.replace("✓ ", ""));

  async function mount(models: ModelChoice[]) {
    await act(async () =>
      root.render(
        <ChipMenu menuLabel="Model" width={224} buttonProps={{ "data-chip": true, children: "m" }}>
          {(close) => (
            <ModelList
              models={models}
              selectedId="default"
              onPick={(m) => {
                close();
                picked(m.id);
              }}
            />
          )}
        </ChipMenu>,
      ),
    );
    await act(async () => q("[data-chip]")!.click());
  }
  const type = async (el: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = async (el: Element, k: string) =>
    act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });

  beforeEach(() => {
    picked.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("has no search at or under the threshold, and a search over it", async () => {
    await mount([DEFAULT, ...many(MODEL_SEARCH_THRESHOLD - 1, ["a"])]);
    expect(q("[data-agent-model-search]")).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount([DEFAULT, ...many(MODEL_SEARCH_THRESHOLD + 1, ["a"])]);
    expect(q("[data-agent-model-search]")).not.toBeNull();
  });

  it("shows provider headers only with several providers, the Default row above them", async () => {
    await mount([DEFAULT, ...many(4, ["a"])]);
    expect(qa("[data-agent-model-group]")).toHaveLength(0);
    expect(labels()).toEqual(["Default", "m0 (a)", "m1 (a)", "m2 (a)", "m3 (a)"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount([DEFAULT, ...many(4, ["zed", "acme"])]);
    expect(qa("[data-agent-model-group]").map((g) => g.getAttribute("aria-label"))).toEqual([
      "acme",
      "zed",
    ]);
    // under a header the provider is not repeated
    expect(labels()).toEqual(["Default", "m1", "m3", "m0", "m2"]);
  });

  it("keyboard: typing filters, arrows move, Enter picks, Esc closes", async () => {
    await mount([DEFAULT, ...many(12, ["acme", "zed"])]);
    const input = q("[data-agent-model-search]") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await type(input, "m1");
    expect(labels().sort()).toEqual(["m1", "m10", "m11"]);
    // arrows move from the field over the rows
    await key(input, "ArrowDown");
    expect(document.activeElement).toBe(qa("[role=menuitemradio]")[0]);
    await key(document.activeElement!, "ArrowUp");
    expect(document.activeElement).toBe(input);
    // Enter in the field picks the first match
    const first = labels()[0];
    await key(input, "Enter");
    expect(picked).toHaveBeenCalledWith(first);
    expect(q("[role=menu]")).toBeNull();
  });

  it("Esc closes the menu", async () => {
    await mount([DEFAULT, ...many(12, ["acme", "zed"])]);
    await key(q("[data-agent-model-search]")!, "Escape");
    expect(q("[role=menu]")).toBeNull();
  });
});
