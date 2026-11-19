// The CodeMirror side: a `linter` source that sends the note to the Rust checker, debounced, and
// draws what comes back. This module is the lazy `spellcheck.linter` editor extension (the feature's
// entry stays import-light).
//
// - Stale answers: each request carries a growing version; Rust refuses one older than an answer
//   it already gave for the note (`stale`, then one retry), and `@codemirror/lint` itself drops an
//   answer when the document changed while it was away.
// - Re-checks without an edit: a dictionary installed, a word added, a rule ignored, a language
//   picked, a setting changed or the LanguageTool plugin turning up or off bump `epoch` (or change
//   the settings signature); a `ViewPlugin` listens and runs the linter at once (`forceLinting`):
//   nothing was typed, so the typing pause does not apply.
import { forceLinting, linter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { subscribeCommunityPlugins } from "@/lib/community-plugins";
import { editorNotePath, liveEditorViews } from "@/lib/editor-views";
import { vaultRelative } from "@/lib/attachments";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { logger } from "@/lib/logger";
import { getFileName } from "@/lib/paths";
import { useSettingsStore } from "@/stores/settings-store";
import { addWord, check, ignoreWord } from "../ipc";
import {
  anyKindEnabled,
  checkSignature,
  ignoredRules,
  KEYS,
  writerCheckerActive,
} from "../lib/settings";
import { groupFindings } from "../lib/issue-groups";
import { useSpellStore } from "../lib/spell-store";
import { toDiagnostics, withoutWord, type ActionHandlers } from "./diagnostics";
import { spellTooltipTheme } from "./tooltip-theme";

/** Notes longer than this are not checked (a transfer of megabytes per pause is not worth it). */
export const MAX_CHECK_CHARS = 1_000_000;
/** Pause after the last edit before a check, in milliseconds. */
export const CHECK_DELAY_MS = 750;

let version = 0;

/** Silences a misspelled word: the underlines go at once (in every open editor, or only in the
 *  ones showing `filePath`), then the write runs and the re-check after it confirms. The one path
 *  of "Add to dictionary" (vault-wide) and "Ignore" (one note). */
function silenceWord(
  word: string,
  filePath: string | null,
  write: () => Promise<unknown>,
  failure: string,
) {
  for (const [view, getPath] of liveEditorViews) {
    if (filePath !== null && getPath() !== filePath) continue;
    const kept = withoutWord(view.state, word);
    if (kept) view.dispatch(setDiagnostics(view.state, kept));
  }
  write().then(
    () => useSpellStore.getState().bump(),
    (e: unknown) => showEditorNotice(`${failure} "${word}": ${String(e)}`),
  );
}

export const handlers: ActionHandlers = {
  addWord: (word) => silenceWord(word, null, () => addWord(word), "Could not add"),
  ignoreWord: (word, filePath) =>
    silenceWord(word, filePath, () => ignoreWord(notePath(filePath), word), "Could not ignore"),
  ignoreRule: (ruleId) => {
    const rules = ignoredRules();
    if (rules.includes(ruleId)) return;
    // the settings write bumps the signature, which re-checks every editor
    void useSettingsStore.getState().setSetting(KEYS.ignoredRules, [...rules, ruleId]);
  },
};

/** Vault-relative path of a note, or its file name outside a vault. */
function notePath(abs: string): string {
  const root = getWorkspaceRoot();
  return root ? vaultRelative(abs, root) : getFileName(abs);
}

export async function runCheck(view: EditorView): Promise<Diagnostic[]> {
  if (!writerCheckerActive() || !anyKindEnabled()) return [];
  const doc = view.state.doc;
  if (doc.length > MAX_CHECK_CHARS) return [];
  const abs = view.state.facet(editorNotePath)();
  if (!abs) return [];
  const text = doc.toString();
  const language = useSpellStore.getState().overrides[abs] ?? null;
  try {
    // a refused (stale) answer means a newer request for the note is in flight: ask once more
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await check({ path: notePath(abs), text, version: ++version, language });
      if (answer.stale) continue;
      useSpellStore.getState().setResult(abs, {
        blocks: answer.blocks,
        missing: answer.missing,
        groups: groupFindings(answer.findings, text),
      });
      return toDiagnostics(answer.findings, doc.length, handlers);
    }
  } catch (e) {
    logger.warn("spellcheck", `the check failed: ${String(e)}`);
  }
  return [];
}

/** Tells the editor to check again when something other than the text changed. */
const followChanges = ViewPlugin.define((view) => {
  // nothing was typed, so there is no pause to wait for: check now
  const nudge = () => forceLinting(view);
  let signature = checkSignature();
  const stops = [
    useSpellStore.subscribe((s, prev) => {
      if (s.epoch !== prev.epoch) nudge();
    }),
    useSettingsStore.subscribe((s) => {
      const next = checkSignature(s.settings);
      if (next === signature) return;
      signature = next;
      nudge();
    }),
    subscribeCommunityPlugins(nudge),
  ];
  return { destroy: () => stops.forEach((stop) => stop()) };
});

export function spellcheckExtension() {
  return [
    linter((view) => runCheck(view), { delay: CHECK_DELAY_MS }),
    spellTooltipTheme,
    followChanges,
  ];
}

export default spellcheckExtension;
