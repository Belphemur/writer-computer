// The copy button of a code block, one implementation for the note editor (a CodeMirror widget)
// and the agent chat (`markdown-host.tsx`): icon-only, "Copy" tooltip, a check for a moment after
// a copy. Plain DOM so both can mount it; the look is the `.code-copy` rule in App.css, each
// surface places it.
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { svgFromIcon } from "@/lib/icon-picker/icon-dom";
import { copyText } from "@/lib/copy-text";

export const CODE_COPY_CLASS = "code-copy";
export const CODE_COPY_DONE_CLASS = "is-copied";
export const CODE_COPY_FEEDBACK_MS = 1200;

const ICON_PX = 14;
const ICON_STROKE = "1.75";

const icon = (data: typeof Copy01Icon) => {
  const svg = svgFromIcon(data, ICON_PX);
  for (const path of svg.children) path.setAttribute("stroke-width", ICON_STROKE);
  return svg;
};

/** A button that copies `getText()` (read at click time, so an edited block copies what it holds
 *  now). A mouse press never takes focus, so a click leaves the editor's caret, selection and
 *  focus alone. */
export function createCodeCopyButton(
  getText: () => string,
  extraClass?: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = extraClass ? `${CODE_COPY_CLASS} ${extraClass}` : CODE_COPY_CLASS;
  button.title = "Copy";
  button.setAttribute("aria-label", "Copy code");
  button.append(icon(Copy01Icon));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const showCopied = (copied: boolean) => {
    clearTimeout(timer);
    button.classList.toggle(CODE_COPY_DONE_CLASS, copied);
    button.title = copied ? "Copied" : "Copy";
    button.replaceChildren(icon(copied ? Tick02Icon : Copy01Icon));
    if (copied) timer = setTimeout(() => showCopied(false), CODE_COPY_FEEDBACK_MS);
  };

  // `stopPropagation` keeps editor-level pointer handlers (drag select, caret placement) out.
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    void copyText(getText()).then((copied) => {
      if (copied && button.isConnected) showCopied(true);
    });
  });
  return button;
}
