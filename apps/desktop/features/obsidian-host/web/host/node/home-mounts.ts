// Home-directory mounts: app-level data some plugins keep in a dot directory of the user's home
// (Obsidian lets any plugin write there; Writer's `fs` confines writes to the vault). A mounted
// directory is served from a hidden folder inside the vault's plugin directory instead, so the
// plugin's persistence (e.g. Copilot's `~/.obsidian-copilot/vaults/<id>/agent-chat-index.json`, the list
// behind "Recent chats") works and survives restarts without opening the real home directory.
//
// To support another plugin, add one entry: `home` is relative to the home directory, `vault` is
// vault-relative and must live inside that plugin's own directory.

export interface HomeMount {
  /** Directory under the user's home, e.g. ".obsidian-copilot". */
  home: string;
  /** Vault-relative directory that backs it. */
  vault: string;
}

export const HOME_MOUNTS: readonly HomeMount[] = [
  { home: ".obsidian-copilot", vault: ".obsidian/plugins/copilot/home/.obsidian-copilot" },
];

/** Absolute path -> vault-relative path under a mount, or null when `abs` is not mounted. */
export function mountedVaultPath(
  homedir: string,
  abs: string,
  mounts: readonly HomeMount[] = HOME_MOUNTS,
): string | null {
  const home = homedir.replace(/\/+$/, "");
  for (const m of mounts) {
    const root = `${home}/${m.home}`;
    if (abs === root) return m.vault;
    if (abs.startsWith(`${root}/`)) return `${m.vault}/${abs.slice(root.length + 1)}`;
  }
  return null;
}

/** Vault-relative path under a mount -> absolute (virtual) path, or null. */
export function mountedAbsPath(
  homedir: string,
  rel: string,
  mounts: readonly HomeMount[] = HOME_MOUNTS,
): string | null {
  const home = homedir.replace(/\/+$/, "");
  for (const m of mounts) {
    if (rel === m.vault) return `${home}/${m.home}`;
    if (rel.startsWith(`${m.vault}/`)) return `${home}/${m.home}/${rel.slice(m.vault.length + 1)}`;
  }
  return null;
}
