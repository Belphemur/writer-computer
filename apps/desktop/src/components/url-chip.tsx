import type { ReactNode } from "react";
import { linkHandlers } from "@/lib/link-activation";
import { urlHref, urlLabel } from "@/lib/url-value";
import { openPropertyUrl } from "./editor-area/property-links";

/**
 * One URL as a link chip: host and path as the label (scheme and `www.` dropped, truncated, the
 * full value in the title), a click opens it in the system browser through link activation
 * (`lib/link-activation.ts`: plain, Cmd/Ctrl and middle click as every link). A value that is no
 * URL is shown as written, dimmed and marked "Not a URL", never a link and never rewritten.
 * The one chip of the properties panel and of Bases cells; the caller gives the pill its look
 * (`className`) and may add controls (a remove button) as `children`.
 */
export function UrlChip({
  value,
  className,
  tabbable = true,
  children,
}: {
  value: string;
  className: string;
  /** False where the surroundings own keyboard focus (a grid cell). */
  tabbable?: boolean;
  children?: ReactNode;
}) {
  const href = urlHref(value);
  return (
    <span className={className} data-url-chip data-invalid={href === null || undefined}>
      {href === null ? (
        <span title="Not a URL" className="min-w-0 truncate opacity-70">
          {value}
        </span>
      ) : (
        <button
          type="button"
          tabIndex={tabbable ? undefined : -1}
          title={value}
          {...linkHandlers({ kind: "custom", open: () => void openPropertyUrl(href) })}
          // a press on the link must not move focus or start a selection or an edit around it
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className="min-w-0 cursor-pointer truncate bg-transparent p-0 text-left text-[var(--accent)] underline-offset-2 hover:underline focus-visible:underline"
        >
          {urlLabel(value)}
        </button>
      )}
      {children}
    </span>
  );
}
