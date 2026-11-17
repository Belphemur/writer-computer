import { useCallback } from "react";
import { createPillElement, type PillModel } from "@/lib/agent/pill";

/** Draws a pill into `host`: the same DOM the composer's widget builds (`createPillElement`). A
 *  pill with a note to open is a button when `onOpen` is given. */
export function mountPill(
  host: HTMLElement,
  model: PillModel,
  onOpen?: (target: string) => void,
): void {
  const clickable = model.target !== null && onOpen !== undefined;
  const el = createPillElement(model, { as: clickable ? "button" : "span" });
  if (clickable) el.addEventListener("click", () => onOpen(model.target!));
  host.replaceChildren(el);
}

/** A pill in React content (the transcript), mounted by a callback ref. */
export function PillView({
  model,
  onOpen,
}: {
  model: PillModel;
  onOpen?: (target: string) => void;
}) {
  const clickable = model.target !== null && onOpen !== undefined;
  const key = JSON.stringify([model, clickable]);
  const mount = useCallback(
    (host: HTMLElement | null) => {
      if (host) mountPill(host, model, onOpen);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures model and clickable; `onOpen` is a stable function
    [key],
  );
  return <span ref={mount} className="contents" />;
}
