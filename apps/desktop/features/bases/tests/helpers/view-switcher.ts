import { act } from "react";

/** Test helpers for the Bases view dropdown (trigger in `host`, popover portaled to `document.body`). */
export const trigger = (host: ParentNode) =>
  host.querySelector<HTMLButtonElement>("[data-view-switcher]")!;
export const popover = () => document.body.querySelector<HTMLElement>("[data-view-popover]");
export const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
export const optionNames = () => options().map((o) => o.dataset.viewOption);
export const searchBox = () =>
  document.body.querySelector<HTMLInputElement>('input[role="combobox"]');

export async function open(host: ParentNode) {
  await act(async () => trigger(host).click());
}

export async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
}

export async function pickView(host: ParentNode, name: string) {
  await open(host);
  await act(async () =>
    options()
      .find((o) => o.dataset.viewOption === name)!
      .click(),
  );
}
