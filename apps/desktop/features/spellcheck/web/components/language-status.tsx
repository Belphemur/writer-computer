// The footer item that shows the language of the paragraph at the cursor and lets the user set
// the note's language (ADR point 5): the list holds English and every installed dictionary, a pick
// applies at once, then asks whether to write it into the note's `lang:` property.
import { useCallback } from "react";
import {
  showNativeContextMenu,
  type MenuItemSpec,
} from "@/components/editor-area/editor-context-menu";
import { openSettings } from "@/hooks/editor-api";
import { findEditorView } from "@/lib/editor-views";
import { logger } from "@/lib/logger";
import { confirmAction } from "@/lib/tauri";
import type { StatusItemProps } from "@/lib/features/types";
import { useEditorStore } from "@/stores/editor-store";
import { dictionaries } from "../ipc";
import { languagePropertyChange } from "../lib/lang-property";
import { blockAt, languageName, sourceLabel } from "../lib/languages";
import { anyKindEnabled, writerCheckerActive } from "../lib/settings";
import { useSpellStore } from "../lib/spell-store";

/** Writes `lang: <tag>` into the note through its editor, like any other edit. */
export function writeLanguageProperty(path: string, tag: string): boolean {
  const view = findEditorView(path);
  if (!view) return false;
  view.dispatch({ changes: languagePropertyChange(view.state.doc.toString(), tag) });
  return true;
}

async function chooseLanguage(path: string, tag: string): Promise<void> {
  useSpellStore.getState().setOverride(path, tag);
  const save = await confirmAction(`Save lang: ${tag} in this note's properties?`, "Language");
  if (save && writeLanguageProperty(path, tag)) useSpellStore.getState().setOverride(path, null);
}

async function showLanguageMenu(path: string, current: string | null): Promise<void> {
  const list = await dictionaries();
  const mark = (tag: string, name: string) => (tag === current ? `${name} (current)` : name);
  const items: MenuItemSpec[] = [
    {
      kind: "item",
      id: "spellcheck-auto",
      text: "Automatic",
      action: () => useSpellStore.getState().setOverride(path, null),
    },
    { kind: "separator" },
    {
      kind: "item",
      id: "spellcheck-lang-en",
      text: mark("en", "English"),
      action: () => void chooseLanguage(path, "en"),
    },
    ...list
      .filter((d) => d.installed)
      .map((d): MenuItemSpec => ({
        kind: "item",
        id: `spellcheck-lang-${d.id}`,
        text: mark(d.id, d.name),
        action: () => void chooseLanguage(path, d.id),
      })),
    { kind: "separator" },
    {
      kind: "item",
      id: "spellcheck-add-language",
      text: "Add language...",
      action: () => openSettings("spellcheck"),
    },
  ];
  await showNativeContextMenu(items);
}

export default function LanguageStatus({ filePath }: StatusItemProps) {
  const result = useSpellStore((s) => s.results[filePath]);
  const cursor = useEditorStore((s) => s.openFiles.get(filePath)?.cursorPos ?? 0);
  const block = blockAt(result?.blocks, cursor);
  const onClick = useCallback(() => {
    showLanguageMenu(filePath, block?.lang ?? null).catch((e: unknown) =>
      logger.warn("spellcheck", `the language menu failed: ${String(e)}`),
    );
  }, [filePath, block?.lang]);
  if (!block || !writerCheckerActive() || !anyKindEnabled()) return null;
  const missing = result?.missing.includes(block.lang) ?? false;
  return (
    <button
      type="button"
      data-spellcheck-language
      onClick={onClick}
      title={
        missing ? `${languageName(block.lang)}: no dictionary installed` : sourceLabel(block.source)
      }
      className="rounded px-1 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
    >
      {languageName(block.lang)}
      {missing ? " (no dictionary)" : ""}
    </button>
  );
}
