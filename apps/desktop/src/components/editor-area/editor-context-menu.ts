import { Menu } from "@tauri-apps/api/menu/menu";
import { PredefinedMenuItem } from "@tauri-apps/api/menu/predefinedMenuItem";
import { MenuItem } from "@tauri-apps/api/menu/menuItem";
import { Submenu } from "@tauri-apps/api/menu/submenu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import {
  detectPlatform,
  revealLabelForPlatform,
  type Platform,
} from "@/components/sidebar/context-menu-utils";
import {
  chordToAccelerator,
  editorCommands,
  type EditorCommand,
  type EditorCommandId,
} from "./markdown-formatting";
import { TABLE_MENU_LAYOUT, tableCommands, type TableCommandId } from "./table-editing";

// -- Editor body menu --

export type EditorBodyMenuActionId =
  | "cut"
  | "copy"
  | "paste"
  | "select-all"
  | "open-link"
  | "copy-link";

export interface EditorBodyMenuHandlers {
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onOpenLink?: () => void;
  onCopyLink?: () => void;
  onRunCommand?: (id: EditorCommandId) => void;
  /** Set when the click landed in a table: adds the "Table" submenu. */
  onTableCommand?: (id: TableCommandId) => void;
}

// Menu ids stay stable for tests and telemetry; text and accelerator come from
// the command registry. `"---"` is a separator; the optional third element
// overrides the registry label where the submenu context wants different
// wording ("Insert link…" under Format, "Link…" under Insert).
type CommandMenuLayout = ReadonlyArray<"---" | readonly [string, EditorCommandId, string?]>;

const FORMAT_SUBMENU: CommandMenuLayout = [
  ["fmt.bold", "format.bold"],
  ["fmt.italic", "format.italic"],
  ["fmt.strikethrough", "format.strikethrough"],
  ["fmt.code", "format.code"],
  "---",
  ["fmt.link", "format.link", "Insert link\u2026"],
  "---",
  ["fmt.clear", "format.clearFormatting"],
];

const PARAGRAPH_SUBMENU: CommandMenuLayout = [
  ["para.h1", "format.heading1"],
  ["para.h2", "format.heading2"],
  ["para.h3", "format.heading3"],
  ["para.h4", "format.heading4"],
  ["para.h5", "format.heading5"],
  ["para.h6", "format.heading6"],
  ["para.paragraph", "format.paragraph"],
  "---",
  ["para.bullet", "format.bulletList"],
  ["para.numbered", "format.numberedList"],
  ["para.task", "format.taskList"],
  "---",
  ["para.blockquote", "format.blockquote"],
  ["para.codeblock", "format.codeBlock"],
];

const INSERT_SUBMENU: CommandMenuLayout = [
  ["ins.link", "format.link"],
  ["ins.table", "insert.table"],
  ["ins.hr", "insert.horizontalRule"],
  "---",
  ["ins.date", "insert.today"],
  ["ins.time", "insert.now"],
];

const EDITOR_COMMAND_SUBMENUS: ReadonlyArray<readonly [string, CommandMenuLayout]> = [
  ["Format", FORMAT_SUBMENU],
  ["Paragraph", PARAGRAPH_SUBMENU],
  ["Insert", INSERT_SUBMENU],
];

function buildCommandItems(
  layout: CommandMenuLayout,
  run: (id: EditorCommandId) => void,
): MenuItemSpec[] {
  return layout.map((entry) => {
    if (entry === "---") return { kind: "separator" };
    const [id, commandId, label] = entry;
    const command: EditorCommand = editorCommands[commandId];
    return {
      kind: "item",
      id,
      text: label ?? command.label,
      action: () => run(commandId),
      ...(command.chord ? { accelerator: chordToAccelerator(command.chord) } : {}),
    };
  });
}

export function buildEditorBodyMenuItemsSpec(
  handlers: EditorBodyMenuHandlers,
  hasLink: boolean,
): MenuItemSpec[] {
  const items: MenuItemSpec[] = [
    { kind: "item", id: "cut", text: "Cut", action: handlers.onCut },
    { kind: "item", id: "copy", text: "Copy", action: handlers.onCopy },
    { kind: "item", id: "paste", text: "Paste", action: handlers.onPaste },
  ];

  if (handlers.onTableCommand) {
    const run = handlers.onTableCommand;
    items.push({ kind: "separator" });
    items.push({
      kind: "submenu",
      text: "Table",
      items: TABLE_MENU_LAYOUT.map((entry): MenuItemSpec => {
        if (entry === "---") return { kind: "separator" };
        const command = tableCommands[entry];
        return {
          kind: "item",
          id: entry,
          text: command.label,
          action: () => run(entry),
          ...("chord" in command ? { accelerator: chordToAccelerator(command.chord) } : {}),
        };
      }),
    });
  }

  if (handlers.onRunCommand) {
    const run = handlers.onRunCommand;
    items.push({ kind: "separator" });
    for (const [text, layout] of EDITOR_COMMAND_SUBMENUS) {
      items.push({ kind: "submenu", text, items: buildCommandItems(layout, run) });
    }
  }

  items.push({ kind: "separator" });
  items.push({ kind: "item", id: "select-all", text: "Select all", action: handlers.onSelectAll });

  if (hasLink && handlers.onOpenLink && handlers.onCopyLink) {
    items.push({ kind: "separator" });
    items.push({
      kind: "item",
      id: "open-link",
      text: "Open link",
      action: handlers.onOpenLink,
    });
    items.push({
      kind: "item",
      id: "copy-link",
      text: "Copy link",
      action: handlers.onCopyLink,
    });
  }

  return items;
}

// -- Tab menu --

export type TabMenuActionId =
  | "pin"
  | "unpin"
  | "close"
  | "close-others"
  | "close-all"
  | "set-display-title"
  | "reveal-in-sidebar"
  | "copy-path";

export interface TabMenuHandlers {
  onTogglePin: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  /** File-backed tabs only; the "Reveal" and "Copy path" group is left out without them. */
  onRevealInSidebar?: () => void;
  onCopyPath?: () => void;
  /** Markdown notes only: opens the display-title dialog (the frontmatter `title`). */
  onSetDisplayTitle?: () => void;
}

/** What the menu shows for the tab it was opened on (see `SPECs/pinned-tabs-spec.md`). */
export interface TabMenuState {
  pinned: boolean;
  /** The new-tab page cannot be pinned, so it gets no pin item. */
  pinnable: boolean;
  /** Is there another tab Close others would close (pinned tabs are never closed by it)? */
  closeOthersEnabled: boolean;
  /** Is there a tab Close all would close? */
  closeAllEnabled: boolean;
}

const DEFAULT_TAB_MENU_STATE: TabMenuState = {
  pinned: false,
  pinnable: true,
  closeOthersEnabled: true,
  closeAllEnabled: true,
};

export type TabMenuItemSpec =
  | { kind: "item"; id: TabMenuActionId; text: string; action: () => void; enabled?: boolean }
  | { kind: "separator" };

export function buildTabMenuItemsSpec(
  handlers: TabMenuHandlers,
  state: TabMenuState = DEFAULT_TAB_MENU_STATE,
): TabMenuItemSpec[] {
  const items: TabMenuItemSpec[] = [];
  if (state.pinnable) {
    items.push(
      {
        kind: "item",
        id: state.pinned ? "unpin" : "pin",
        text: state.pinned ? "Unpin tab" : "Pin tab",
        action: handlers.onTogglePin,
      },
      { kind: "separator" },
    );
  }
  items.push(
    // A pinned tab closes only after it is unpinned (the same rule as Cmd+W and middle click).
    { kind: "item", id: "close", text: "Close", action: handlers.onClose, enabled: !state.pinned },
    {
      kind: "item",
      id: "close-others",
      text: "Close others",
      action: handlers.onCloseOthers,
      enabled: state.closeOthersEnabled,
    },
    {
      kind: "item",
      id: "close-all",
      text: "Close all",
      action: handlers.onCloseAll,
      enabled: state.closeAllEnabled,
    },
  );
  if (handlers.onSetDisplayTitle) {
    items.push(
      { kind: "separator" },
      {
        kind: "item",
        id: "set-display-title",
        text: "Set display title...",
        action: handlers.onSetDisplayTitle,
      },
    );
  }
  if (handlers.onRevealInSidebar && handlers.onCopyPath) {
    items.push(
      { kind: "separator" },
      {
        kind: "item",
        id: "reveal-in-sidebar",
        text: "Reveal in sidebar",
        action: handlers.onRevealInSidebar,
      },
      { kind: "item", id: "copy-path", text: "Copy path", action: handlers.onCopyPath },
    );
  }
  return items;
}

// -- Document title menu --

export type TitleMenuActionId = "rename" | "reveal" | "copy-path";

export interface TitleMenuHandlers {
  onRename: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
}

export function buildTitleMenuItemsSpec(
  handlers: TitleMenuHandlers,
  platform: Platform = detectPlatform(),
): Array<
  { kind: "item"; id: TitleMenuActionId; text: string; action: () => void } | { kind: "separator" }
> {
  return [
    { kind: "item", id: "rename", text: "Rename", action: handlers.onRename },
    {
      kind: "item",
      id: "reveal",
      text: revealLabelForPlatform(platform),
      action: handlers.onReveal,
    },
    { kind: "item", id: "copy-path", text: "Copy path", action: handlers.onCopyPath },
  ];
}

// -- Shared popup helper --

export type MenuItemSpec =
  | {
      kind: "item";
      id: string;
      text: string;
      action: () => void;
      accelerator?: string;
      enabled?: boolean;
    }
  | { kind: "separator" }
  | { kind: "submenu"; text: string; items: MenuItemSpec[] };

async function buildMenuItems(
  spec: MenuItemSpec[],
): Promise<Array<MenuItem | PredefinedMenuItem | Submenu>> {
  return Promise.all(
    spec.map(async (entry) => {
      if (entry.kind === "separator") {
        return PredefinedMenuItem.new({ item: "Separator" });
      }
      if (entry.kind === "submenu") {
        const children = await buildMenuItems(entry.items);
        return Submenu.new({ text: entry.text, items: children });
      }
      return MenuItem.new({
        id: entry.id,
        text: entry.text,
        action: entry.action,
        ...(entry.accelerator ? { accelerator: entry.accelerator } : {}),
        ...(entry.enabled === false ? { enabled: false } : {}),
      });
    }),
  );
}

export async function showNativeContextMenu(
  spec: MenuItemSpec[],
  at?: { x: number; y: number },
): Promise<void> {
  const items = await buildMenuItems(spec);
  const menu = await Menu.new({ items });
  if (at) {
    await menu.popup(new LogicalPosition(at.x, at.y));
  } else {
    await menu.popup();
  }
}
