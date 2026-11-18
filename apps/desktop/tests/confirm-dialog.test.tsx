// @vitest-environment jsdom
// The generic confirmation modal: Cancel/Escape close, confirm is async with a spinner, an error
// stays inside the dialog, focus starts on the confirm button, is trapped and is restored.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ConfirmDialog } from "@/components/confirm-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let opener: HTMLButtonElement;
beforeEach(() => {
  opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  opener.remove();
});

const btn = (t: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === t)!;
const press = (k: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });

function render(onConfirm: () => Promise<void>, onClose = vi.fn()) {
  act(() =>
    root.render(
      <ConfirmDialog
        title="Sure?"
        confirmLabel="Do it"
        destructive
        onConfirm={onConfirm}
        onClose={onClose}
      >
        <p>body text</p>
      </ConfirmDialog>,
    ),
  );
  return onClose;
}

describe("ConfirmDialog", () => {
  it("shows title and body, focuses the confirm button and restores focus on unmount", () => {
    render(async () => {});
    expect(document.querySelector("[role=alertdialog]")!.textContent).toContain("body text");
    expect(document.activeElement).toBe(btn("Do it"));
    act(() => root.unmount());
    expect(document.activeElement).toBe(opener);
    root = createRoot(container);
  });

  it("Cancel and Escape close without confirming", async () => {
    const onConfirm = vi.fn(async () => {});
    const onClose = render(onConfirm);
    await act(async () => btn("Cancel").click());
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirm shows a pending state once, then closes on success", async () => {
    let done!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (done = r)));
    const onClose = render(onConfirm);
    await act(async () => btn("Do it").click());
    await act(async () => btn("Do it").click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(btn("Do it").getAttribute("aria-busy")).toBe("true");
    expect((btn("Do it") as HTMLButtonElement).disabled).toBe(true);
    await press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => done());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an error stays in the dialog and allows a retry", async () => {
    const onConfirm = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("it is busy"))
      .mockResolvedValueOnce();
    const onClose = render(onConfirm);
    await act(async () => btn("Do it").click());
    expect(document.querySelector("[role=alert]")!.textContent).toBe("it is busy");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(btn("Do it"));
    await act(async () => btn("Do it").click());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter outside a button confirms", async () => {
    const onConfirm = vi.fn(async () => {});
    render(onConfirm);
    await act(async () => {
      document
        .querySelector("[role=alertdialog]")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Tab wraps inside the card", async () => {
    render(async () => {});
    expect(document.activeElement).toBe(btn("Do it"));
    await press("Tab");
    expect(document.activeElement).toBe(btn("Cancel"));
    btn("Cancel").focus();
    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(btn("Do it"));
  });
});
