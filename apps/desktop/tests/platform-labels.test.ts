import { describe, expect, test } from "vite-plus/test";
import {
  installGitLabelForPlatform,
  openFolderLabelForPlatform,
  revealLabelForPlatform,
  secretStoreLabelForPlatform,
} from "../src/lib/platform-labels";

// The one table of OS-specific words (`lib/platform-labels.ts`): a surface never spells "Finder",
// "Keychain" or an install hint itself.
describe("platform labels", () => {
  test("the file manager is named per OS", () => {
    expect(revealLabelForPlatform("macos")).toBe("Reveal in Finder");
    expect(revealLabelForPlatform("windows")).toBe("Reveal in Explorer");
    expect(revealLabelForPlatform("linux")).toBe("Show in Folder");
    expect(openFolderLabelForPlatform("linux")).toBe("Open in File Manager");
  });

  test("the secret store is the Keychain, the Credential Manager or the keyring", () => {
    expect(secretStoreLabelForPlatform("macos")).toBe("Keychain");
    expect(secretStoreLabelForPlatform("windows")).toBe("Credential Manager");
    expect(secretStoreLabelForPlatform("linux")).toBe("keyring");
  });

  test("missing git points at the package manager on Linux", () => {
    expect(installGitLabelForPlatform("linux")).toBe("Install git with your package manager");
    expect(installGitLabelForPlatform("windows")).toContain("git-scm.com");
    expect(installGitLabelForPlatform("macos")).toBe("Install git");
  });

  test("no label names another OS's app", () => {
    for (const os of ["windows", "linux"] as const) {
      for (const label of [
        revealLabelForPlatform(os),
        openFolderLabelForPlatform(os),
        secretStoreLabelForPlatform(os),
      ]) {
        expect(label).not.toMatch(/Finder|Keychain/);
      }
    }
  });
});
