import { useCallback } from "react";
import { createPillElement, type PillModel } from "@/lib/agent/pill";
import { bindLinkActivation } from "@/lib/link-activation";
import { vaultTarget } from "./agent-links";

/** Draws a pill into `host`: the same DOM the composer's widget builds (`createPillElement`). A
 *  pill with a note to open is a link button when `link` is set (left, middle and modifier
 *  clicks, `lib/link-activation.ts`). */
export function mountPill(host: HTMLElement, model: PillModel, link = false): void {
  const clickable = model.target !== null && link;
  const el = createPillElement(model, { as: clickable ? "button" : "span" });
  if (clickable) bindLinkActivation(el, () => vaultTarget(model.target!));
  host.replaceChildren(el);
}

/** A pill in React content (the transcript), mounted by a callback ref. */
export function PillView({ model, link = false }: { model: PillModel; link?: boolean }) {
  const key = JSON.stringify([model, link]);
  const mount = useCallback(
    (host: HTMLElement | null) => {
      if (host) mountPill(host, model, link);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures model and link
    [key],
  );
  return <span ref={mount} className="contents" />;
}
