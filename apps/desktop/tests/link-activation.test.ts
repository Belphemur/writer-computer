// @vitest-environment jsdom
// The one gesture table (SPECs/link-activation-spec.md section 1) and its three bindings.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  newTab: vi.fn(),
  openUrl: vi.fn(),
  active: vi.fn<() => string | null>(() => null),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }));
vi.mock("../src/hooks/editor-api", () => ({
  navigateToFile: h.navigate,
  openFileInNewTab: h.newTab,
  getActiveFilePath: h.active,
}));

import {
  activateLink,
  bindLinkActivation,
  keyIntent,
  linkActivationExtension,
  linkHandlers,
  linkIntent,
  openPathAtAnchor,
  type LinkIntent,
  type LinkTarget,
} from "../src/lib/link-activation";
import { consumePendingAnchor, registerAnchorReveal } from "../src/lib/pending-anchor";
import { dispatchMouse } from "@tests/helpers/events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  Object.values(h).forEach((m) => m.mockClear());
  document.body.replaceChildren();
});

const none = { metaKey: false, ctrlKey: false, shiftKey: false };
const BG: LinkIntent = "new-tab-background";
const ACTIVE: LinkIntent = "new-tab-active";

describe("linkIntent: the gesture table", () => {
  const cases: [string, "macos" | "windows" | "linux", object, LinkIntent | null][] = [
    ["left", "macos", { button: 0 }, "current"],
    ["left (no button field)", "macos", {}, "current"],
    ["middle", "macos", { button: 1 }, BG],
    ["middle + shift", "macos", { button: 1, shiftKey: true }, BG],
    ["Cmd+click", "macos", { button: 0, metaKey: true }, BG],
    ["Cmd+Shift+click", "macos", { button: 0, metaKey: true, shiftKey: true }, ACTIVE],
    ["Ctrl+click is the context menu on macOS", "macos", { button: 0, ctrlKey: true }, "current"],
    ["Shift+click alone", "macos", { button: 0, shiftKey: true }, "current"],
    ["right button", "macos", { button: 2 }, null],
    ["left", "windows", { button: 0 }, "current"],
    ["middle", "windows", { button: 1 }, BG],
    ["Ctrl+click", "windows", { button: 0, ctrlKey: true }, BG],
    ["Ctrl+Shift+click", "windows", { button: 0, ctrlKey: true, shiftKey: true }, ACTIVE],
    ["Cmd (Meta) alone is not the modifier", "windows", { button: 0, metaKey: true }, "current"],
    ["Ctrl+click", "linux", { button: 0, ctrlKey: true }, BG],
    ["right button", "linux", { button: 2 }, null],
  ];
  it.each(cases)("%s on %s", (_name, platform, gesture, expected) => {
    expect(linkIntent({ ...none, ...gesture }, platform)).toBe(expected);
  });

  it("Enter is a left click and Cmd/Ctrl+Enter a modifier click; other keys are not links", () => {
    expect(keyIntent({ key: "Enter", ...none }, "macos")).toBe("current");
    expect(keyIntent({ key: "Enter", ...none, metaKey: true }, "macos")).toBe(BG);
    expect(keyIntent({ key: "Enter", ...none, ctrlKey: true, shiftKey: true }, "linux")).toBe(
      ACTIVE,
    );
    expect(keyIntent({ key: "a", ...none }, "macos")).toBeNull();
  });
});

describe("activateLink", () => {
  it("notes and files: current tab, background tab, active tab", () => {
    activateLink({ kind: "note", path: "/v/a.md" }, "current");
    expect(h.navigate).toHaveBeenLastCalledWith("/v/a.md");
    activateLink({ kind: "file", path: "/v/a.md" }, BG);
    expect(h.newTab).toHaveBeenLastCalledWith("/v/a.md", { activate: false });
    activateLink({ kind: "note", path: "/v/a.md" }, ACTIVE);
    expect(h.newTab).toHaveBeenLastCalledWith("/v/a.md", { activate: true });
  });
  it("urls go to the system browser whatever the intent; custom targets get the intent", () => {
    for (const i of ["current", BG, ACTIVE] as LinkIntent[])
      activateLink({ kind: "url", href: "https://x.test" }, i);
    expect(h.openUrl).toHaveBeenCalledTimes(3);
    expect(h.navigate).not.toHaveBeenCalled();
    const open = vi.fn();
    activateLink({ kind: "custom", open }, BG);
    expect(open).toHaveBeenCalledWith(BG);
  });
});

const NOTE: LinkTarget = { kind: "note", path: "/v/a.md" };
const URL_T: LinkTarget = { kind: "url", href: "https://x.test" };

// jsdom reports a Linux user agent: Ctrl is the modifier. The platform split is covered above.
function assertBinding(el: Element, expectsUrl = false, claimsLeftPress = false) {
  const sink = expectsUrl ? h.openUrl : h.newTab;
  expect(dispatchMouse(el, "mousedown", { button: 1 }).defaultPrevented).toBe(true);
  expect(dispatchMouse(el, "auxclick", { button: 1 }).defaultPrevented).toBe(true);
  if (!expectsUrl) expect(sink).toHaveBeenLastCalledWith("/v/a.md", { activate: false });
  sink.mockClear();
  dispatchMouse(el, "click", { button: 0, ctrlKey: true });
  if (!expectsUrl) expect(sink).toHaveBeenLastCalledWith("/v/a.md", { activate: false });
  sink.mockClear();
  dispatchMouse(el, "click", { button: 0, ctrlKey: true, shiftKey: true });
  if (!expectsUrl) expect(sink).toHaveBeenLastCalledWith("/v/a.md", { activate: true });
  else expect(sink).toHaveBeenCalledTimes(1);
  sink.mockClear();
  dispatchMouse(el, "click", { button: 0 });
  if (expectsUrl) expect(h.openUrl).toHaveBeenCalledTimes(1);
  else expect(h.navigate).toHaveBeenLastCalledWith("/v/a.md");
  dispatchMouse(el, "auxclick", { button: 2 }); // other buttons do nothing
  expect(dispatchMouse(el, "mousedown", { button: 0 }).defaultPrevented).toBe(claimsLeftPress);
}

describe("React binding: linkHandlers", () => {
  it("opens notes and urls for every gesture", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        createElement(
          "div",
          null,
          createElement("button", { id: "n", ...linkHandlers(NOTE) }),
          createElement("button", { id: "u", ...linkHandlers(URL_T) }),
        ),
      ),
    );
    assertBinding(host.querySelector("#n")!);
    h.navigate.mockClear();
    h.openUrl.mockClear();
    assertBinding(host.querySelector("#u")!, true);
    act(() => root.unmount());
  });

  it("middleOnly leaves left and modifier clicks to the element", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(createElement("button", { ...linkHandlers(NOTE, { middleOnly: true }) })),
    );
    const b = host.querySelector("button")!;
    dispatchMouse(b, "click", { button: 0 });
    dispatchMouse(b, "click", { button: 0, ctrlKey: true });
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.newTab).not.toHaveBeenCalled();
    dispatchMouse(b, "auxclick", { button: 1 });
    expect(h.newTab).toHaveBeenCalledWith("/v/a.md", { activate: false });
    act(() => root.unmount());
  });
});

describe("DOM binding: bindLinkActivation", () => {
  it("delegates to the resolved target, ignores the rest, and disposes", () => {
    const c = document.createElement("div");
    c.innerHTML = '<a id="n">note</a><a id="u">url</a><span id="x">plain</span>';
    document.body.appendChild(c);
    const off = bindLinkActivation(c, (el) =>
      el.id === "n" ? NOTE : el.id === "u" ? URL_T : null,
    );
    assertBinding(c.querySelector("#n")!);
    h.navigate.mockClear();
    h.openUrl.mockClear();
    assertBinding(c.querySelector("#u")!, true);
    const plain = dispatchMouse(c.querySelector("#x")!, "auxclick", { button: 1 });
    expect(plain.defaultPrevented).toBe(false);
    off();
    h.newTab.mockClear();
    dispatchMouse(c.querySelector("#n")!, "auxclick", { button: 1 });
    expect(h.newTab).not.toHaveBeenCalled();
  });

  it("skips an event something inside already handled", () => {
    const c = document.createElement("div");
    c.innerHTML = '<a id="n">note</a>';
    document.body.appendChild(c);
    bindLinkActivation(c, () => NOTE);
    c.querySelector("a")!.addEventListener("click", (e) => e.preventDefault());
    dispatchMouse(c.querySelector("a")!, "click", { button: 0 });
    expect(h.navigate).not.toHaveBeenCalled();
  });
});

describe("CodeMirror binding: linkActivationExtension", () => {
  it("claims the press and opens on click, auxclick and modifier clicks", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "x",
        extensions: linkActivationExtension((e) =>
          e.target instanceof Element && e.target.id === "link" ? NOTE : null,
        ),
      }),
    });
    const link = document.createElement("span");
    link.id = "link";
    view.contentDOM.appendChild(link);
    assertBinding(link, false, true); // the editor also claims the left press (no caret move)
    h.newTab.mockClear();
    dispatchMouse(view.contentDOM, "auxclick", { button: 1 }); // not a link
    expect(h.newTab).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe("openPathAtAnchor: a heading link reveals its heading", () => {
  const reveal = vi.fn<(path: string, anchor: string) => boolean>();
  registerAnchorReveal(reveal);
  afterEach(() => {
    reveal.mockReset();
    h.active.mockReturnValue(null);
    consumePendingAnchor("/v/a.md");
  });

  it("scrolls the note already showing in place, without navigating", async () => {
    h.active.mockReturnValue("/v/a.md");
    reveal.mockReturnValue(true);
    await openPathAtAnchor("/v/a.md", "intro", "current");
    expect(reveal).toHaveBeenCalledWith("/v/a.md", "intro");
    expect(h.navigate).not.toHaveBeenCalled();
    expect(consumePendingAnchor("/v/a.md")).toBeUndefined();
  });

  it("parks the anchor for the editor that loads another note, which takes it exactly once", async () => {
    await openPathAtAnchor("/v/a.md", "intro", "current");
    expect(h.navigate).toHaveBeenCalledWith("/v/a.md");
    expect(consumePendingAnchor("/v/a.md")).toBe("intro");
    expect(consumePendingAnchor("/v/a.md")).toBeUndefined();
  });

  it.each([
    ["new-tab-background", false],
    ["new-tab-active", true],
  ] as const)(
    "%s opens a tab and keeps the anchor until the tab is shown",
    async (intent, activate) => {
      h.active.mockReturnValue("/v/a.md"); // the note is showing, but a new tab is asked for
      await openPathAtAnchor("/v/a.md", "intro", intent);
      expect(reveal).not.toHaveBeenCalled();
      expect(h.newTab).toHaveBeenCalledWith("/v/a.md", { activate });
      // Nothing consumed it yet: the background tab's editor does when it mounts on activation.
      expect(consumePendingAnchor("/v/a.md")).toBe("intro");
    },
  );

  it("without an anchor it is a plain open", async () => {
    await openPathAtAnchor("/v/a.md", null, "current");
    expect(h.navigate).toHaveBeenCalledWith("/v/a.md");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("drops the anchor when the open fails", async () => {
    h.navigate.mockRejectedValueOnce(new Error("boom"));
    await expect(openPathAtAnchor("/v/a.md", "intro", "current")).rejects.toThrow("boom");
    expect(consumePendingAnchor("/v/a.md")).toBeUndefined();
  });
});
