import { useCallback } from "react";
import { createPillElement, type PillModel } from "@/lib/agent/pill";

/** A pill in React content (the transcript): the same DOM the composer's widget builds
 *  (`createPillElement`), mounted by a callback ref. A pill with a note to open is a button. */
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
      if (!host) return;
      const el = createPillElement(model, { as: clickable ? "button" : "span" });
      if (clickable) el.addEventListener("click", () => onOpen?.(model.target!));
      host.replaceChildren(el);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures model and clickable; `onOpen` is a stable function
    [key],
  );
  return <span ref={mount} className="contents" />;
}
