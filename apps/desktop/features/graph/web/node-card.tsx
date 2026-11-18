// The info card of a selected node (a click selects it): title, folder, tags and the actions
// Open, Open in new tab, Focus and Unpin. Open follows the link gesture table through
// `linkHandlers` (middle and Cmd/Ctrl click open a new tab), never a hand-written button check.
import { linkHandlers } from "@/lib/link-activation";
import { openNode } from "./actions";
import type { NodeSpec } from "./model";
import { TOOL_BUTTON } from "./surface-tools";

export function NodeCard({
  node,
  pinned,
  onFocus,
  onUnpin,
}: {
  node: NodeSpec;
  pinned: boolean;
  onFocus?: () => void;
  onUnpin: () => void;
}) {
  const missing = node.kind === "missing";
  return (
    <div
      className="absolute bottom-2 left-2 z-10 w-[240px] rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-card)] p-2 text-[12px]"
      data-testid="graph-node-card"
    >
      <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">
        {node.label}
      </div>
      {node.folder && <div className="truncate text-[var(--text-muted)]">{node.folder}</div>}
      {node.tags.length > 0 && (
        <div className="mt-0.5 truncate text-[var(--text-muted)]">{node.tags.join("  ")}</div>
      )}
      {node.kind !== "tag" && (
        <div className="mt-1 flex flex-wrap gap-1">
          <button
            type="button"
            className={TOOL_BUTTON}
            {...linkHandlers({ kind: "custom", open: (intent) => void openNode(node, intent) })}
          >
            {missing ? "Create note" : "Open"}
          </button>
          {!missing && (
            <button
              type="button"
              className={TOOL_BUTTON}
              onClick={() => void openNode(node, "new-tab-active")}
            >
              New tab
            </button>
          )}
          {onFocus && (
            <button type="button" className={TOOL_BUTTON} onClick={onFocus}>
              Focus
            </button>
          )}
          {pinned && (
            <button type="button" className={TOOL_BUTTON} onClick={onUnpin}>
              Unpin
            </button>
          )}
        </div>
      )}
    </div>
  );
}
