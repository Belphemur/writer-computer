// @vitest-environment jsdom
// The one icon picker (core, `components/icon-picker`): the Icons tab (search over the loaded set),
// the Emoji tab (search by name and keyword, type or paste one emoji), Remove icon, Escape; the
// pure icon-value rules pinned by `shared/icon-value-vectors.json` (Rust twin: `valid_icon`) and the
// emoji search. The agent's project picker (the same component) is tested in the agent feature.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import vectors from "@shared/icon-value-vectors.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { IconPicker } from "../src/components/icon-picker/icon-picker";
import { IconGlyph } from "../src/components/icon-picker/icon-glyph";
import {
  buildEmojiIndex,
  searchEmojiIndex,
  type EmojiData,
} from "../src/lib/icon-picker/emoji-search";
import { isEmoji, parseIconValue } from "../src/lib/icon-picker/icon-value";
import realEmoji from "../src/lib/icon-picker/emoji.json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
for (const name of ["offsetHeight", "clientHeight"])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 216 });
for (const name of ["offsetWidth", "clientWidth"])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 316 });

describe("icon values", () => {
  it.each(vectors.valid)("%s is an icon value", (v) => {
    expect(parseIconValue(v)).not.toBeNull();
  });
  it.each(vectors.invalid)("%j is not one", (v) => {
    expect(parseIconValue(v)).toBeNull();
  });
  it("reads the kind and the name", () => {
    expect(parseIconValue("emoji:✅")).toEqual({ kind: "emoji", name: "✅" });
    expect(parseIconValue("icon:Home01Icon")).toEqual({ kind: "icon", name: "Home01Icon" });
    expect(parseIconValue(null)).toBeNull();
    expect(isEmoji("👨‍👩‍👧‍👦")).toBe(true);
    expect(isEmoji("ab")).toBe(false);
  });
});

describe("emoji search over the generated list", () => {
  const data: EmojiData = {
    groups: ["Smileys", "Objects"],
    emoji: [
      { emoji: "😀", name: "grinning face", keywords: ["smiling"], group: 0 },
      { emoji: "😄", name: "grinning face with smiling eyes", keywords: [], group: 0 },
      { emoji: "✅", name: "check mark button", keywords: ["symbols"], group: 1 },
    ],
  };
  const index = buildEmojiIndex(data);
  it("matches every query word by prefix over the name and the keywords", () => {
    expect(searchEmojiIndex(index, "grin").map((e) => e.emoji)).toEqual(["😀", "😄"]);
    expect(searchEmojiIndex(index, "smil").map((e) => e.emoji)).toEqual(["😀", "😄"]); // keyword
    expect(searchEmojiIndex(index, "check mark").map((e) => e.emoji)).toEqual(["✅"]);
    expect(searchEmojiIndex(index, "zzz")).toEqual([]);
    expect(searchEmojiIndex(index, " ")).toHaveLength(3);
  });
  it("the committed emoji.json is built from emoji-test.txt: names, keywords, every entry one emoji", () => {
    const real = realEmoji as unknown as EmojiData;
    expect(real.emoji.length).toBeGreaterThan(1500);
    expect(real.groups.length).toBeGreaterThan(5);
    const found = searchEmojiIndex(buildEmojiIndex(real), "check mark button");
    expect(found.some((e) => e.emoji === "✅")).toBe(true);
    expect(real.emoji.every((e) => isEmoji(e.emoji))).toBe(true);
  });
});

describe("the picker", () => {
  let host: HTMLDivElement;
  let root: Root;
  const glyph = (id: string) => [["path", { d: `M0 0h${id.length}`, key: id }]];
  const iconSet = () =>
    Promise.resolve(
      Object.fromEntries(
        ["Home01Icon", "Rocket01Icon", "RocketLaunchIcon"].map((n) => [n, glyph(n)]),
      ) as never,
    );
  const emojiData = () =>
    Promise.resolve({
      groups: ["Smileys"],
      emoji: [
        { emoji: "😀", name: "grinning face", keywords: ["smiling"], group: 0 },
        { emoji: "✅", name: "check mark button", keywords: [], group: 0 },
      ],
    } as EmojiData);
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  async function show(props: Partial<React.ComponentProps<typeof IconPicker>> = {}) {
    const onPick = vi.fn();
    const onRemove = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <IconPicker
          label="Pick"
          value={null}
          onPick={onPick}
          onRemove={onRemove}
          onClose={onClose}
          loadIcons={iconSet}
          loadEmojiData={emojiData}
          {...props}
        />,
      );
    });
    await flush();
    return { onPick, onRemove, onClose };
  }
  const q = (sel: string) => host.querySelector<HTMLElement>(sel);
  const input = (label: string) => q(`input[aria-label="${label}"]`) as HTMLInputElement;
  const type = (el: HTMLInputElement, text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = (el: Element, k: string) =>
    act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });
  const tab = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;
  const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("searches icons and picks `icon:<name>`", async () => {
    const { onPick } = await show();
    expect(options().map((o) => o.dataset.iconName)).toEqual([
      "Home01Icon",
      "Rocket01Icon",
      "RocketLaunchIcon",
    ]);
    await type(input("Search icons"), "rocket");
    expect(options().map((o) => o.dataset.iconName)).toEqual(["Rocket01Icon", "RocketLaunchIcon"]);
    await key(input("Search icons"), "Enter");
    expect(onPick).toHaveBeenLastCalledWith("icon:Rocket01Icon");
  });

  it("the Emoji tab searches by name and by keyword and picks `emoji:<emoji>`", async () => {
    const { onPick } = await show();
    await act(async () => tab("Emoji").click());
    await flush();
    expect(options().map((o) => o.dataset.emoji)).toEqual(["😀", "✅"]);
    await type(input("Search emoji"), "check");
    expect(options().map((o) => o.dataset.emoji)).toEqual(["✅"]);
    await type(input("Search emoji"), "smiling"); // a keyword, not in the name
    expect(options().map((o) => o.dataset.emoji)).toEqual(["😀"]);
    await act(async () => {
      options()[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(onPick).toHaveBeenLastCalledWith("emoji:😀");
  });

  it("type or paste accepts one emoji and refuses text", async () => {
    const { onPick } = await show();
    await act(async () => tab("Emoji").click());
    await flush();
    const field = input("Type or paste an emoji");
    await type(field, "hello");
    await key(field, "Enter");
    expect(onPick).not.toHaveBeenCalled();
    expect(q('[role="alert"]')?.textContent).toBe("Not an emoji");
    await type(field, "😀😀");
    await key(field, "Enter");
    expect(onPick).not.toHaveBeenCalled();
    await type(field, " 🚀 ");
    await key(field, "Enter");
    expect(onPick).toHaveBeenLastCalledWith("emoji:🚀");
  });

  it("opens on the tab of the current value; Remove icon only shows with one", async () => {
    await show({ value: "emoji:✅" });
    expect(tab("Emoji").getAttribute("aria-selected")).toBe("true");
    expect(options().find((o) => o.getAttribute("aria-selected") === "true")?.dataset.emoji).toBe(
      "✅",
    );
    const remove = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Remove icon",
    );
    expect(remove).toBeDefined();
  });

  it("Remove icon reports it; with no icon the button is absent", async () => {
    const { onRemove } = await show({ value: "icon:Home01Icon" });
    await act(async () =>
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Remove icon")!.click(),
    );
    expect(onRemove).toHaveBeenCalledOnce();
    await show({ value: null });
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Remove icon")).toBe(
      false,
    );
  });

  it("Escape closes from the search, the paste field and a tab, and goes no further", async () => {
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer); // above the React root: what a document-level Escape handler sees
    const { onClose } = await show();
    await key(input("Search icons"), "Escape");
    await key(tab("Emoji"), "Escape");
    await act(async () => tab("Emoji").click());
    await flush();
    await key(input("Type or paste an emoji"), "Escape");
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener("keydown", outer);
  });

  it("a single-tab picker shows no tab bar", async () => {
    await show({ tabs: ["icons"] });
    expect(q('[role="tablist"]')).toBeNull();
  });

  it("IconGlyph draws an emoji as text and nothing for a bad value", async () => {
    await act(async () => {
      root.render(
        <>
          <IconGlyph value="emoji:✅" />
          <IconGlyph value="junk" />
        </>,
      );
    });
    expect(host.querySelectorAll("[data-icon-glyph]")).toHaveLength(1);
    expect(host.textContent).toBe("✅");
  });
});
