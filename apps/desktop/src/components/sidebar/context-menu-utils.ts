import { type Platform } from "@/lib/platform";

export { detectPlatform, type Platform } from "@/lib/platform";

// The one table of OS-specific words in the UI: the file manager's name for the menus and links,
// the secret store, and how to get git. A surface asks here; it never spells "Finder" or "Keychain".
const PLATFORM_MENU_LABELS = {
  macos: {
    reveal: "Reveal in Finder",
    openFolder: "Open in Finder",
    secretStore: "Keychain",
    installGit: "Install git",
  },
  windows: {
    reveal: "Reveal in Explorer",
    openFolder: "Open in Explorer",
    secretStore: "Credential Manager",
    installGit: "Install git from git-scm.com",
  },
  linux: {
    reveal: "Show in Folder",
    openFolder: "Open in File Manager",
    secretStore: "keyring",
    installGit: "Install git with your package manager",
  },
} satisfies Record<
  Platform,
  { reveal: string; openFolder: string; secretStore: string; installGit: string }
>;

export function revealLabelForPlatform(platform: Platform): string {
  return PLATFORM_MENU_LABELS[platform].reveal;
}

export function openFolderLabelForPlatform(platform: Platform): string {
  return PLATFORM_MENU_LABELS[platform].openFolder;
}

/** "Keychain" on macOS, "Credential Manager" on Windows, "keyring" on Linux. */
export function secretStoreLabelForPlatform(platform: Platform): string {
  return PLATFORM_MENU_LABELS[platform].secretStore;
}

/** Where git comes from when it is missing; on macOS the setup page has its own button. */
export function installGitLabelForPlatform(platform: Platform): string {
  return PLATFORM_MENU_LABELS[platform].installGit;
}
