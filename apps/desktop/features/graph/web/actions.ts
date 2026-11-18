// What a node does: open (every click through `src/lib/link-activation.ts`, never a hand-written
// button check), the right-click menu, "Focus here", "Attach to agent chat" (through the
// `agent.context` service, absent while the agent feature is off) and "Create note" for a missing
// note. Slice paths are vault-relative; tabs hold absolute paths, joined here once.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import { openGraphTab } from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { activateLink, linkIntent, type LinkIntent } from "@/lib/link-activation";
import { getService } from "@/lib/features/services";
import { revealPathInSidebar } from "@/lib/reveal-in-sidebar";
import * as tauri from "@/lib/tauri";
import type { AgentContextService } from "@features/agent/web/api";
import type { NodeAttrs } from "./model";
import { useGraphConfig } from "./store";

const AGENT_CONTEXT = "agent.context";

export const absolutePath = (relative: string): string | null => {
  const root = getWorkspaceRoot();
  return root === null ? null : `${root.replace(/[\\/]+$/, "")}/${relative.replace(/^[\\/]+/, "")}`;
};

/** The intent of a pointer event on a node (left, middle, Cmd/Ctrl, Cmd/Ctrl+Shift), or null. */
export const intentOf = (e: MouseEvent | TouchEvent): LinkIntent | null =>
  e instanceof MouseEvent ? linkIntent(e) : "current";

/** What a click on a node does: a plain click selects it (the info card shows), Shift+click adds to
 *  or removes from the selection, middle and Cmd/Ctrl clicks open it for their intent. */
export function nodeClick(
  intent: LinkIntent,
  shiftKey: boolean,
  selection: ReadonlySet<string>,
  path: string,
): { open: LinkIntent } | { selection: Set<string> } {
  if (intent !== "current") return { open: intent };
  const next = new Set(shiftKey ? selection : []);
  if (!shiftKey || !next.delete(path)) next.add(path);
  return { selection: next };
}

/** Opens a node's note or file for `intent`. A missing note is created first (it opens as a new,
 *  empty note); tags have nothing to open. */
export async function openNode(
  node: Pick<NodeAttrs, "kind" | "path" | "label">,
  intent: LinkIntent,
) {
  if (node.kind === "tag") return;
  if (node.kind === "missing") {
    const abs = absolutePath(`${node.label}.md`);
    if (abs) {
      await tauri.createFile(abs);
      activateLink({ kind: "note", path: abs }, intent);
    }
    return;
  }
  const abs = absolutePath(node.path);
  if (abs) activateLink({ kind: node.kind === "note" ? "note" : "file", path: abs }, intent);
}

/** Attach notes to the active agent chat; resolves false when the agent feature is off. */
export async function attachToAgent(paths: readonly string[]): Promise<boolean> {
  const service = getService<AgentContextService>(AGENT_CONTEXT);
  if (!service) return false;
  await service.attachNotes(paths);
  return true;
}

export const canAttachToAgent = () => getService<AgentContextService>(AGENT_CONTEXT) !== undefined;

export interface MenuHandlers {
  /** Re-center the graph on a note with its neighbourhood (global graph: "Focus here"). */
  focusHere?: (path: string) => void;
  /** The selection (the node plus any shift-clicked ones) to attach. */
  selection: () => string[];
}

/** The right-click menu of a node (spec section 4). */
export function nodeMenu(node: NodeAttrs, handlers: MenuHandlers): MenuItemSpec[] {
  if (node.kind === "tag") return [];
  const isMissing = node.kind === "missing";
  const items: MenuItemSpec[] = [
    {
      kind: "item",
      id: "graph-open",
      text: isMissing ? "Create note" : "Open",
      action: () => void openNode(node, "current"),
    },
  ];
  if (!isMissing) {
    items.push({
      kind: "item",
      id: "graph-open-new-tab",
      text: "Open in new tab",
      action: () => void openNode(node, "new-tab-active"),
    });
    items.push({
      kind: "item",
      id: "graph-reveal",
      text: "Reveal in sidebar",
      action: () => {
        const abs = absolutePath(node.path);
        if (abs) void revealPathInSidebar(abs, { showSidebar: true });
      },
    });
    if (handlers.focusHere) {
      items.push({
        kind: "item",
        id: "graph-focus",
        text: "Focus here",
        action: () => handlers.focusHere!(node.path),
      });
    }
    items.push({
      kind: "item",
      id: "graph-copy-link",
      text: "Copy link",
      action: () => void writeText(`[[${node.label}]]`),
    });
    if (canAttachToAgent()) {
      items.push({ kind: "separator" });
      items.push({
        kind: "item",
        id: "graph-attach",
        text: "Attach to agent chat",
        action: () => {
          const picked = handlers.selection();
          void attachToAgent(picked.length ? picked : [node.path]);
        },
      });
    }
  }
  return items;
}

/** Opens the graph tab: on `center`'s local graph at the remembered depth, or on the whole vault
 *  without a note (the tab's "Whole vault" toggle drops the depth). */
export async function openGlobalGraph(center?: string) {
  if (!center) return openGraphTab({});
  const config = useGraphConfig.getState();
  await config.load();
  openGraphTab({ center, depth: useGraphConfig.getState().config.global.display.depth });
}
