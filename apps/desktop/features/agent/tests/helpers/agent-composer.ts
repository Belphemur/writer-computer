// Drives the agent composer's CodeMirror view in jsdom (no layout: positions come from the model).
import { EditorView } from "@codemirror/view";
import { act } from "react";

export const COMPOSER = "[data-agent-composer]";

/** The composer's editable element and its view. */
export function composerEl(root: ParentNode = document): HTMLElement {
  return root.querySelector<HTMLElement>(COMPOSER)!;
}
export function composerView(root: ParentNode = document): EditorView {
  return EditorView.findFromDOM(composerEl(root))!;
}

/** Replaces the whole text as typing would (caret at `caret`, default the end). */
export function typeInComposer(view: EditorView, value: string, caret = value.length) {
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: caret },
      userEvent: "input.type",
    });
  });
}

export function pressKey(view: EditorView, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

export const composerText = (view: EditorView) => view.state.doc.toString();

/** Bound to the container the test renders into: `type`, `typeAt` (caret inside), `key`. */
export function composerDriver(container: () => ParentNode) {
  return {
    view: () => composerView(container()),
    el: () => composerEl(container()),
    type: (value: string, caret?: number) =>
      typeInComposer(composerView(container()), value, caret),
    key: (k: string, init?: KeyboardEventInit) => pressKey(composerView(container()), k, init),
    text: () => composerText(composerView(container())),
    caret: () => composerView(container()).state.selection.main.head,
  };
}
