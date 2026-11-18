// The user's keyboard shortcuts: `hotkeys.json` in the app data dir, `{ version: 1, mac: {...},
// windows: {...}, linux: {...} }`, each map command id -> chords (a list replaces the defaults,
// `[]` removes them, an absent id means defaults). Rust validates and writes it atomically
// (`src-tauri/src/hotkeys.rs`); this module is the ONE write path on the web side: the Hotkeys
// page, the Obsidian host's `hotkeyManager.setHotkeys` and "Import from Obsidian" all go through
// `updateOverrides`, which changes only the current OS's section, keeps the others as they were
// and applies the result to the registry. Writes run one after the other; a failed write leaves
// the registry as it was and rejects.
import { listen } from "@tauri-apps/api/event";
import { logger } from "@/lib/logger";
import { hotkeysRead, hotkeysWrite } from "@/lib/tauri";
import { normalizeChord } from "./chord";
import { keybindings, osKey, type KeybindingRegistry, type OsKey } from "./registry";
import { detectPlatform } from "@/lib/platform";

type Section = Record<string, readonly string[]>;
type HotkeysFile = { version: 1 } & Record<OsKey, Section>;

const emptyFile = (): HotkeysFile => ({ version: 1, mac: {}, windows: {}, linux: {} });
const CHANGED_EVENT = "hotkeys:changed";

function parseFile(text: string): HotkeysFile {
  const raw = JSON.parse(text) as Partial<HotkeysFile>;
  const section = (s: unknown): Section =>
    Object.fromEntries(
      Object.entries((s ?? {}) as Record<string, unknown>).map(([id, keys]) => [
        id,
        (Array.isArray(keys) ? keys : []).filter((k): k is string => typeof k === "string"),
      ]),
    );
  return {
    version: 1,
    mac: section(raw.mac),
    windows: section(raw.windows),
    linux: section(raw.linux),
  };
}

/** Normalizes the chords of one command (a key this build cannot read is dropped). */
function cleanKeys(keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    try {
      const n = normalizeChord(k);
      if (!out.includes(n)) out.push(n);
    } catch {
      /* not a chord */
    }
  }
  return out;
}

export class HotkeyOverrides {
  private file = emptyFile();
  private chain: Promise<unknown> = Promise.resolve();
  private errorListeners = new Set<() => void>();
  /** Why the file could not be read at the last load (the defaults apply); null when it could. */
  loadError: string | null = null;

  constructor(
    private registry: KeybindingRegistry = keybindings,
    private os: () => OsKey = () => osKey(detectPlatform()),
    private io = { read: hotkeysRead, write: hotkeysWrite },
  ) {}

  private apply(file: HotkeysFile): void {
    this.registry.setOverrides(file[this.os()]);
  }

  /** Reads the file and applies this OS's section. An invalid file is reported (`loadError`) and
   *  the defaults stay in force until the next save, which keeps the bad file as `.bak`. */
  async load(): Promise<void> {
    let next = emptyFile();
    let error: string | null = null;
    try {
      const text = await this.io.read();
      if (typeof text === "string") next = parseFile(text);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      logger.warn("app", `hotkeys.json could not be read: ${error}`);
    }
    this.file = next;
    this.loadError = error;
    this.apply(next);
    for (const l of Array.from(this.errorListeners)) l();
  }

  /**
   * Changes this OS's overrides: `change` gets a copy of the section and edits it (`set(id, keys)`
   * or `set(id, null)` to go back to the defaults). Applied once the write has succeeded.
   */
  update(
    change: (section: Section, set: (id: string, keys: readonly string[] | null) => void) => void,
  ) {
    const run = async () => {
      const os = this.os();
      const section: Section = { ...this.file[os] };
      change(section, (id, keys) => {
        if (keys === null) delete section[id];
        else section[id] = cleanKeys(keys);
      });
      const next: HotkeysFile = { ...this.file, [os]: section };
      await this.io.write(JSON.stringify(next, null, 2));
      this.file = next;
      this.apply(next);
    };
    const result = this.chain.then(run);
    this.chain = result.catch((e) =>
      logger.error("app", `hotkeys.json could not be saved: ${String(e)}`),
    );
    return result;
  }

  /** Sets the keys of one command; `null` resets it to its defaults. */
  setKeys(id: string, keys: readonly string[] | null): Promise<void> {
    return this.update((_, set) => set(id, keys));
  }

  /** Back to every default on this OS (the other OS sections stay). */
  resetAll(): Promise<void> {
    return this.update((section) => {
      for (const id of Object.keys(section)) delete section[id];
    });
  }

  onLoaded(listener: () => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
}

/** The app's overrides. */
export const hotkeyOverrides = new HotkeyOverrides();

/** Loads the file and keeps every window in step (Rust emits an event after each save). */
export function startHotkeyOverrides(): () => void {
  void hotkeyOverrides.load();
  let off = () => {};
  let live = true;
  listen(CHANGED_EVENT, () => void hotkeyOverrides.load())
    .then((u) => (live ? (off = u) : u()))
    .catch((e) => logger.warn("app", `hotkeys: no change events (${String(e)})`));
  return () => {
    live = false;
    off();
  };
}
