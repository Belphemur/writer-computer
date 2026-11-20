// Fullscreen view of the mermaid canvas: a fresh copy of the canvas (pan + zoom + reset controls)
// in the shared bare full-screen shell (`lib/fullscreen-overlay.ts`: Esc, backdrop press, focus
// restore, one at a time). The canvas draws its own close button.
import { openFullscreen } from "@/lib/fullscreen-overlay";
import { mountMermaidCanvas } from "./mermaid-canvas";
import { renderMermaid } from "./mermaid-renderer";

// Long enough for the canvas's exit transition (180 ms) to finish.
const EXIT_MS = 240;

export function openMermaidFullscreen(source: string, ariaLabel: string): void {
  // An invalid diagram opens too and shows the same error as the inline frame.
  const diagram = renderMermaid(source);
  const { body, close } = openFullscreen({
    label: ariaLabel,
    variant: "bare",
    className: "cm-mermaid-fullscreen",
    exitMs: EXIT_MS,
  });
  const host = body;
  host.classList.add("cm-mermaid-canvas", "cm-mermaid-fullscreen-canvas");
  host.tabIndex = 0;
  mountMermaidCanvas(host, { diagram, ariaLabel, copySource: () => source, onClose: close });
  host.focus();
}
