// Settings > Spelling: the checks, the installed languages (with "Add language" over the whole
// Hunspell catalog and each licence) and the personal dictionary. The
// plain settings are rows of the shared `SettingRows`; the lists that need actions are cards here.
// Text stays terse: labels, and one hint line.
import { useCallback, useEffect, useState } from "react";
import { SettingRows } from "@/components/settings-panel/setting-rows";
import { SelectControl } from "@/components/settings-panel/select-control";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { logger } from "@/lib/logger";
import { FEATURE_SETTINGS, type SettingDef } from "@/lib/settings-schema";
import {
  addWord,
  dictionaries,
  installDictionary,
  personalWords,
  removeDictionary,
  removeWord,
  type DictionaryInfo,
} from "../ipc";
import { KEYS } from "../lib/settings";
import { useSpellStore } from "../lib/spell-store";

const CARD =
  "overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]";
const ROW = "flex items-center justify-between gap-4 px-4 py-3 text-[13px]";
const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";
const MUTED = "text-[var(--text-muted)]";
const HEADING = "px-1 pb-2 pt-1 text-[13px] font-medium text-[var(--text-primary)]";

const PRIMARY = [
  KEYS.spelling,
  KEYS.grammar,
  KEYS.style,
  KEYS.dialect,
  KEYS.defaultLanguage,
  KEYS.folderLanguages,
] as string[];

function megabytes(bytes: number): string {
  return `${Math.max(0.1, bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const ADD_LABEL = "Add language...";

/** Installed languages, and a picker over every dictionary of the catalog. */
function Languages() {
  const [list, setList] = useState<DictionaryInfo[] | null>(null);
  const [pick, setPick] = useState(ADD_LABEL);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bump = useSpellStore((s) => s.bump);

  const load = useCallback(() => {
    dictionaries().then(setList, (e: unknown) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  const run = (id: string, job: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    job()
      .then(
        () => {
          load();
          bump();
        },
        (e: unknown) => {
          logger.warn("spellcheck", `dictionary ${id}: ${String(e)}`);
          setError(String(e));
        },
      )
      .finally(() => setBusy(null));
  };

  const installed = (list ?? []).filter((d) => d.installed);
  const available = (list ?? []).filter((d) => !d.installed);
  const label = (d: DictionaryInfo) => `${d.name} (${d.id}), ${megabytes(d.bytes)}`;
  const chosen = available.find((d) => label(d) === pick);

  return (
    <section aria-label="Languages">
      <h3 className={HEADING}>Languages</h3>
      <div className={CARD}>
        <div className={ROW}>
          <span>English</span>
          <span className={MUTED}>built in</span>
        </div>
        {installed.map((d) => (
          <div key={d.id} className={`${ROW} border-t border-[var(--line-subtler)]`}>
            <span>
              {d.name}{" "}
              <span className={MUTED}>
                ({d.id}), {d.license}
              </span>
            </span>
            <button
              type="button"
              className={BUTTON}
              disabled={busy !== null}
              onClick={() => run(d.id, () => removeDictionary(d.id))}
            >
              Remove
            </button>
          </div>
        ))}
        <div className={`${ROW} border-t border-[var(--line-subtler)]`}>
          <SelectControl
            value={pick}
            options={[ADD_LABEL, ...available.map(label)]}
            onChange={setPick}
            ariaLabel="Add language"
            disabled={busy !== null || list === null}
            className="min-w-[260px]"
          />
          <button
            type="button"
            className={BUTTON}
            disabled={!chosen || busy !== null}
            onClick={() => {
              if (!chosen) return;
              setPick(ADD_LABEL);
              run(chosen.id, () => installDictionary(chosen.id));
            }}
          >
            {busy ? "Downloading..." : "Install"}
          </button>
        </div>
        {chosen && (
          <p className={`border-t border-[var(--line-subtler)] px-4 py-2 text-[12px] ${MUTED}`}>
            Licence: {chosen.license}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="border-t border-[var(--line-subtler)] px-4 py-2 text-[12px] text-[var(--text-primary)]"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/** The vault's `.writer/dictionary.txt`, one word per row. */
function PersonalDictionary() {
  const root = useWorkspaceStore((s) => s.root);
  const [words, setWords] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bump = useSpellStore((s) => s.bump);

  useEffect(() => {
    if (!root) return;
    personalWords().then(setWords, (e: unknown) => setError(String(e)));
  }, [root]);

  if (!root) return null;
  const change = (job: Promise<string[]>) =>
    job.then(
      (next) => {
        setWords(next);
        setError(null);
        bump();
      },
      (e: unknown) => setError(String(e)),
    );

  return (
    <section aria-label="Personal dictionary">
      <h3 className={HEADING}>Dictionary</h3>
      <div className={CARD}>
        <form
          className={ROW}
          onSubmit={(e) => {
            e.preventDefault();
            const word = draft.trim();
            if (!word) return;
            void change(addWord(word)).then(() => setDraft(""));
          }}
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a word"
            aria-label="Add a word"
            className="h-9 w-64 rounded-lg border border-transparent bg-[var(--surface-input)] px-3 text-[13px] text-[var(--text-secondary)] font-[inherit] outline-none focus:border-[var(--focus-border)]"
          />
          <button type="submit" className={BUTTON} disabled={!draft.trim()}>
            Add
          </button>
        </form>
        {(words ?? []).map((w) => (
          <div key={w} className={`${ROW} border-t border-[var(--line-subtler)]`}>
            <span>{w}</span>
            <button type="button" className={BUTTON} onClick={() => void change(removeWord(w))}>
              Remove
            </button>
          </div>
        ))}
        {error && (
          <p
            role="alert"
            className="border-t border-[var(--line-subtler)] px-4 py-2 text-[12px] text-[var(--text-primary)]"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export function SpellingSection() {
  const defs = (FEATURE_SETTINGS.spellcheck ?? []) as readonly SettingDef[];
  const byKey = (keys: readonly string[]) => defs.filter((d) => keys.includes(d.key));
  const rest = byKey([KEYS.ignoredRules]);
  return (
    <div className="space-y-6">
      <SettingRows defs={byKey(PRIMARY)} />
      <p className={`px-1 text-[12px] ${MUTED}`}>
        Grammar: English only for now; other languages check spelling
      </p>
      <Languages />
      <PersonalDictionary />
      {rest.length > 0 && <SettingRows defs={rest} />}
    </div>
  );
}
