// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const listTerminals = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/tauri", () => ({ listTerminals }));

import { TerminalControl } from "../src/components/settings-panel/terminal-control";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const found = [
  { id: "ghostty", label: "Ghostty", names: ["ghostty", "Ghostty"] },
  { id: "kitty", label: "kitty", names: ["kitty"] },
];

let host: HTMLElement;
let root: Root;
const onChange = vi.fn();

async function mount(value = "") {
  await act(async () => root.render(<TerminalControl value={value} onChange={onChange} />));
}
const select = () => host.querySelector("select") as HTMLSelectElement;
const optionLabels = () => [...select().options].map((o) => o.textContent);
const textField = () => host.querySelector('input[type="text"]');

async function choose(value: string) {
  await act(async () => {
    select().value = value;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  onChange.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("TerminalControl", () => {
  it("lists System default, the found terminals and Other", async () => {
    listTerminals.mockResolvedValue(found);
    await mount();
    expect(optionLabels()).toEqual(["System default", "Ghostty", "kitty", "Other…"]);
    expect(textField()).toBeNull();
  });

  it("choosing a terminal stores its id", async () => {
    listTerminals.mockResolvedValue(found);
    await mount();
    await choose("kitty");
    expect(onChange).toHaveBeenCalledWith("kitty");
  });

  it("choosing Other shows the text field and stores nothing yet", async () => {
    listTerminals.mockResolvedValue(found);
    await mount();
    expect(textField()).toBeNull();
    await choose(select().options[select().options.length - 1]!.value);
    expect(textField()).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still offers System default and Other when detection fails", async () => {
    listTerminals.mockRejectedValue(new Error("no login shell"));
    await mount();
    expect(optionLabels()).toEqual(["System default", "Other…"]);
    expect(select().disabled).toBe(false);
  });
});
