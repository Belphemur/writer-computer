// The git feature's web half: registers and unregisters cleanly (the kill switch removes the
// settings page, the status item and the panel), the manifest matches the code and the schemas,
// the status item says Local / Pending n / Paused / Error, the panel lists the changes, and
// Settings > Git shows the setup choices before setup and the short layout after it.
// @vitest-environment jsdom
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

const ipc = vi.hoisted(() => ({
  status: vi.fn(),
  setup: vi.fn(),
  commitNow: vi.fn(),
  setPaused: vi.fn(),
  setSigning: vi.fn(),
  stop: vi.fn(),
  history: vi.fn(),
  deleted: vi.fn(),
  versionDiff: vi.fn(),
  versionText: vi.fn(),
  restore: vi.fn(),
  syncNow: vi.fn(),
  mergeText: vi.fn(),
  setSyncPaused: vi.fn(),
  setRemote: vi.fn(),
  removeRemote: vi.fn(),
  tools: vi.fn(),
  installGit: vi.fn(),
  signIn: vi.fn(),
  setCredentials: vi.fn(),
  pluginDecision: vi.fn(),
  dismissNotices: vi.fn(),
}));
vi.mock("../web/ipc", () => ({ ...ipc, GIT_CHANGED: "changed", GIT_APPLYING: "applying" }));

import { DESKTOP, importsOf, sourceFiles } from "@tests/helpers/import-graph";
import { featurePaletteCommands } from "@/lib/features/palette";
import { createFeatureHost } from "@/lib/features/registry";
import { settingsSectionContributions } from "@/lib/features/settings-sections";
import { sidebarPanelContributions } from "@/lib/features/sidebar";
import { statusItemContributions } from "@/lib/features/status-items";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import schema from "@shared/settings.schema.json";
import manifest from "../feature.json";
import fragment from "../settings.schema.json";
import git from "../web";
import GitPanel from "../web/components/panel";
import { GitSection } from "../web/components/git-section";
import GitStatusItem from "../web/components/status-item";
import { fileLabel, summarize } from "../web/lib/state";
import { useGitStatus } from "../web/lib/status-store";
import { baseStatus } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host = createFeatureHost({ onError: () => {} });
const OWNER = "builtin:git";

const status = baseStatus;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useSettingsStore.setState({ settings: {} });
  useFeatureHealth.setState({ sessionOff: {}, safeMode: false });
  useGitStatus.getState().reset();
  useWorkspaceStore.setState({ root: "/vault" } as never);
  Object.values(ipc).forEach((f) => f.mockReset());
  ipc.deleted.mockResolvedValue([]);
  ipc.tools.mockResolvedValue({ git: true, forges: [], canInstallGit: false });
  // a refresh (the settings page asks on open) answers with what the store already holds
  ipc.status.mockImplementation(async () => useGitStatus.getState().status);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  for (const id of host.list()) await host.unregister(id);
});

const render = (node: React.ReactNode) => act(() => root.render(node));
const flush = () => act(async () => {});
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

const mine = () => ({
  commands: featurePaletteCommands.list().filter((x) => x.owner === OWNER).length,
  statusItems: statusItemContributions.list().filter((x) => x.owner === OWNER).length,
  panels: sidebarPanelContributions.list().filter((x) => x.owner === OWNER).length,
  sections: settingsSectionContributions.list().filter((x) => x.owner === OWNER).length,
});

describe("registration", () => {
  it("registers its contributions and the kill switch removes exactly them", async () => {
    host.register(git);
    expect(mine()).toEqual({ commands: 4, statusItems: 1, panels: 1, sections: 1 });
    await host.unregister("git");
    expect(mine()).toEqual({ commands: 0, statusItems: 0, panels: 0, sections: 0 });
  });

  it("reads the status while on and forgets it when off", async () => {
    ipc.status.mockResolvedValue(status());
    host.register(git);
    await host.activate("git");
    await flush();
    expect(useGitStatus.getState().status?.setUp).toBe(true);
    await host.unregister("git");
    expect(useGitStatus.getState().status).toBeNull();
  });
});

describe("manifest contract", () => {
  it("lists the ids the definition registers, all prefixed", () => {
    const c = git.contributes!;
    expect(git.id).toBe(manifest.id);
    expect(manifest.contributes.statusItems).toEqual(c.statusItems!.map((x) => x.id));
    expect(manifest.contributes.sidebarPanels).toEqual(c.sidebarPanels!.map((x) => x.id));
    expect(manifest.contributes.commands.map((x) => x.id)).toEqual(c.commands!.map((x) => x.id));
    const ids = [...c.statusItems!, ...c.sidebarPanels!, ...c.commands!].map((x) => x.id);
    expect(ids.every((id) => id.startsWith("git."))).toBe(true);
  });

  it("cooperates only through points: it extends the agent's, owns none, requires nothing", () => {
    expect(manifest.extends).toEqual([
      "agent.turn-started",
      "agent.turn-finished",
      "agent.turn-baseline",
    ]);
    expect(Object.keys(manifest.offNotes).sort()).toEqual([...manifest.extends].sort());
    expect(manifest.offNotes["agent.turn-finished"]).toBe("Agent turns won't be saved in history");
    expect("requires" in manifest).toBe(false);
    // it offers one service and uses the agent's, which may be off
    expect(manifest.provides).toEqual(["git.history"]);
    expect(manifest.uses).toEqual(["agent.chats"]);
  });

  it("has its kill switch in the shared schema and every setting prefixed in the fragment", () => {
    expect(schema.settings.find((e) => e.key === "features.git.enabled")).toMatchObject({
      type: "boolean",
      scope: "global",
    });
    expect(fragment.settings.map((s) => s.key).sort()).toEqual([
      "git.agent-commits",
      "git.commit-after",
      "git.commit-message",
      "git.lfs",
      "git.lfs-threshold-mb",
      "git.sync-interval",
    ]);
    const after = fragment.settings.find((s) => s.key === "git.commit-after")!;
    expect(after).toMatchObject({ default: "1min", options: ["30s", "1min", "5min", "manual"] });
  });
});

describe("imports", () => {
  const rel = (f: string) => f.replace(/.*\/apps\/desktop\//, "");

  it("only ipc.ts imports the generated bindings, and core never imports the feature", () => {
    const bindings: string[] = [];
    const core: string[] = [];
    for (const f of sourceFiles(resolve(DESKTOP, "src"))) {
      if (importsOf(f).some((i) => i.spec.includes("features/git"))) core.push(rel(f));
    }
    for (const f of sourceFiles(resolve(DESKTOP, "features/git/web"))) {
      if (importsOf(f).some((i) => i.spec.endsWith("/bindings"))) bindings.push(rel(f));
    }
    expect(core).toEqual([]);
    expect(bindings).toEqual(["features/git/web/ipc.ts"]);
  });

  it("imports no other feature's code but the types of its public api (it cooperates through points and services)", () => {
    const hits: string[] = [];
    for (const f of sourceFiles(resolve(DESKTOP, "features/git/web"))) {
      for (const i of importsOf(f)) {
        const api = i.typeOnly && i.spec.endsWith("/web/api");
        if (
          !api &&
          (/features\/(?!git\b)[a-z-]+\//.test(i.spec) || /@features\/(?!git\b)/.test(i.spec))
        ) {
          hits.push(`${rel(f)} ${i.spec}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("summarize", () => {
  it("is hidden until the vault has history", () => {
    expect(summarize(null)).toBeNull();
    expect(summarize(status({ setUp: false }))).toBeNull();
  });

  it("asks for the user's choice in a vault inside another repository or one that was stopped", () => {
    const off = { setUp: false, hasRepo: false };
    expect(summarize(status({ ...off, parentRepo: true }))).toMatchObject({
      label: "History off",
      setup: true,
    });
    expect(summarize(status({ ...off, stopped: true }))).toMatchObject({ setup: true });
  });

  it("says Local, Pending n, Paused or Error, an error first", () => {
    expect(summarize(status())).toMatchObject({ label: "Local", tone: "ok" });
    const two = [
      { path: "a.md", kind: "edit", from: null },
      { path: "b.md", kind: "add", from: null },
    ];
    expect(summarize(status({ changes: two }))).toMatchObject({ label: "Pending 2" });
    expect(summarize(status({ paused: true, changes: two }))).toMatchObject({ label: "Paused" });
    expect(summarize(status({ identityError: true, paused: true }))).toMatchObject({
      label: "Error",
      detail: "Set your git name and email",
    });
    expect(summarize(status({ error: "Git failed" }))).toMatchObject({
      label: "Error",
      detail: "Git failed",
    });
  });

  it("names a note by its title and another file with its extension", () => {
    expect(fileLabel("Notes/Plan.md")).toBe("Plan");
    expect(fileLabel("board.canvas")).toBe("board.canvas");
  });
});

describe("status item", () => {
  it("renders nothing without history, then Local, then Pending n", () => {
    render(<GitStatusItem />);
    expect(container.textContent).toBe("");
    act(() => useGitStatus.getState().apply(status()));
    expect(container.textContent).toBe("Local");
    act(() =>
      useGitStatus
        .getState()
        .apply(status({ changes: [{ path: "a.md", kind: "edit", from: null }] })),
    );
    expect(container.textContent).toBe("Pending 1");
  });

  it("an error shows its tone and a click opens the panel", () => {
    act(() => useGitStatus.getState().apply(status({ identityError: true })));
    render(<GitStatusItem />);
    const el = container.querySelector("[data-git-status]") as HTMLButtonElement;
    expect(el.dataset.gitStatus).toBe("error");
    expect(el.textContent).toBe("Error");
    act(() => el.click());
    expect(useUIStore.getState().sidebarPanel).toBe("git.panel");
  });
});

describe("panel", () => {
  it("lists the changed files, the last version time and commits now", async () => {
    const changed = status({
      lastCommit: Math.floor(Date.now() / 1000) - 120,
      changes: [
        { path: "Notes/Plan.md", kind: "edit", from: null },
        { path: "Archive/Plan.md", kind: "move", from: "Plan.md" },
      ],
    });
    act(() => useGitStatus.getState().apply(changed));
    ipc.commitNow.mockResolvedValue(status({ lastCommit: Math.floor(Date.now() / 1000) }));
    render(<GitPanel />);
    const rows = [...container.querySelectorAll("[data-git-change]")];
    expect(rows.map((r) => r.textContent)).toEqual(["PlanEdited", "PlanMoved"]);
    expect(container.textContent).toContain("Saved 2 mins ago");
    await act(async () => button("Commit now")!.click());
    expect(ipc.commitNow).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-git-change]")).toBeNull();
    expect(container.textContent).toContain("Local");
  });

  it("a merge or rebase shows a quiet Paused with the reason, and no commit is offered by hand", () => {
    expect(summarize(status({ operation: "merge in progress" }))).toMatchObject({
      label: "Paused",
      tone: "quiet",
      detail: "Paused: merge in progress",
    });
    act(() => useGitStatus.getState().apply(status({ operation: "rebase in progress" })));
    render(<GitPanel />);
    expect(container.querySelector("[data-git-operation]")?.textContent).toBe(
      "Paused: rebase in progress",
    );
  });

  it("lists the files left out for their size: the count, the names on click", () => {
    act(() => useGitStatus.getState().apply(status({ tooLarge: ["video.mov", "Data/dump.bin"] })));
    render(<GitPanel />);
    const toggle = button("Not versioned: too large (2)")!;
    expect(container.querySelector("[data-git-too-large] li")).toBeNull();
    act(() => toggle.click());
    expect(
      [...container.querySelectorAll("[data-git-too-large] li")].map((l) => l.textContent),
    ).toEqual(["video.mov", "Data/dump.bin"]);
  });

  it("caps the Deleted list at 200 and Show more lists the rest", async () => {
    const rows = Array.from({ length: 230 }, (_, i) => ({
      path: `n${i}.md`,
      rev: `r${i}`,
      time: 1,
    }));
    ipc.deleted.mockResolvedValue(rows);
    useWorkspaceStore.setState({ root: "/vault" } as never);
    act(() => useGitStatus.getState().apply(status()));
    render(<GitPanel />);
    await act(async () => {});
    expect(container.querySelectorAll("[data-git-deleted-file]").length).toBe(200);
    await act(async () =>
      (container.querySelector("[data-git-deleted-more]") as HTMLElement).click(),
    );
    expect(container.querySelectorAll("[data-git-deleted-file]").length).toBe(230);
    expect(container.querySelector("[data-git-deleted-more]")).toBeNull();
  });

  it("pauses and resumes", async () => {
    act(() => useGitStatus.getState().apply(status()));
    ipc.setPaused.mockResolvedValue(status({ paused: true }));
    render(<GitPanel />);
    await act(async () => button("Pause")!.click());
    expect(ipc.setPaused).toHaveBeenCalledWith(true);
    expect(button("Resume")).toBeDefined();
  });

  it("an identity error shows the hint and the commands, and Commit now is off", () => {
    act(() =>
      useGitStatus
        .getState()
        .apply(
          status({ identityError: true, changes: [{ path: "a.md", kind: "add", from: null }] }),
        ),
    );
    render(<GitPanel />);
    expect(container.textContent).toContain("Set your git name and email");
    expect(container.textContent).toContain("git config --global user.name");
    expect((button("Commit now") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("panel sync controls", () => {
  const linked = (patch = {}) => status({ remote: "origin", branch: "main", ...patch });

  it("without a remote offers Add a remote, no Sync now", () => {
    act(() => useGitStatus.getState().apply(status()));
    render(<GitPanel />);
    expect(button("Add a remote")).toBeTruthy();
    expect(button("Sync now")).toBeFalsy();
  });

  it("Sync now runs a sync, Pause sync flips and shows Resume sync", async () => {
    act(() => useGitStatus.getState().apply(linked()));
    ipc.syncNow.mockResolvedValue(linked({ lastSync: Math.floor(Date.now() / 1000) }));
    ipc.setSyncPaused.mockResolvedValue(linked({ syncPaused: true }));
    render(<GitPanel />);
    await act(async () => button("Sync now")!.click());
    expect(ipc.syncNow).toHaveBeenCalledTimes(1);
    await act(async () => button("Pause sync")!.click());
    expect(ipc.setSyncPaused).toHaveBeenCalledWith(true);
    expect(button("Resume sync")).toBeTruthy();
  });

  it("shows a one-line error whose Details copies the sanitized output", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    act(() =>
      useGitStatus.getState().apply(
        linked({
          syncError: {
            line: "Could not reach the remote",
            details: "fatal: x",
            offline: true,
            kind: "offline",
          },
        }),
      ),
    );
    render(<GitPanel />);
    expect(container.textContent).toContain("Could not reach the remote");
    await act(async () => button("Details")!.click());
    expect(writeText).toHaveBeenCalledWith("fatal: x");
  });
});

const forge = (patch = {}) => ({
  id: "fj",
  label: "Forgejo CLI",
  signIn: "Sign in with Forgejo",
  install: "Install Forgejo CLI",
  installUrl: "https://codeberg.org/forgejo-contrib/forgejo-cli",
  login: "fj auth login",
  state: "signed-in",
  hosts: ["codeberg.org", "git.example.test:3000"],
  ...patch,
});
const gh = (patch = {}) =>
  forge({
    id: "gh",
    label: "GitHub CLI",
    signIn: "Sign in with GitHub",
    install: "Install GitHub CLI",
    login: "gh auth login",
    hosts: [],
    ...patch,
  });
const steps = (...states: [string, string, string?, string?][]) =>
  states.map(([id, state, line = "", kind = ""]) => ({ id, state, line, kind }));

describe("Settings > Git: Sign in with a forge CLI", () => {
  const rows = () => [...container.querySelectorAll("[data-forge]")];

  it("shows each forge in its state: signed in per host, signed out, missing", async () => {
    ipc.tools.mockResolvedValue({
      git: true,
      canInstallGit: false,
      forges: [gh({ state: "missing" }), forge()],
    });
    act(() => useGitStatus.getState().apply(status()));
    render(<GitSection />);
    await flush();
    const text = rows().map((r) => r.textContent);
    // GitHub is not installed: its install link; Forgejo has two hosts: a row each
    expect(text[0]).toContain("Sign in with GitHub");
    expect(text[0]).toContain("Install GitHub CLI");
    expect(text).toHaveLength(3);
    expect(text[1]).toContain("codeberg.org");
    expect(text[2]).toContain("git.example.test:3000");
    expect(text[1]).toContain("Create private repository");

    ipc.tools.mockResolvedValue({
      git: true,
      canInstallGit: false,
      forges: [gh({ state: "signed-out" }), forge({ state: "signed-out", hosts: [] })],
    });
    act(() => root.unmount());
    root = createRoot(container);
    render(<GitSection />);
    await flush();
    const out = rows().map((r) => r.textContent);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("Run gh auth login");
    expect(out[1]).toContain("Run fj auth login");
    expect(container.textContent).not.toContain("Create private repository");
  });

  it("one click runs the action for that host and lists the steps, each in its state", async () => {
    ipc.tools.mockResolvedValue({ git: true, canInstallGit: false, forges: [forge()] });
    ipc.signIn.mockResolvedValue({
      steps: steps(
        ["remote", "done", "codeberg.org/me/vault"],
        ["credential", "done", "Forgejo CLI"],
        ["push", "done", "Synced"],
      ),
      taken: null,
      status: status({ remote: "codeberg.org/me/vault", branch: "main" }),
    });
    act(() => useGitStatus.getState().apply(status()));
    render(<GitSection />);
    await flush();
    const second = rows()[1]!.querySelector("button")!;
    await act(async () => second.click());
    expect(ipc.signIn).toHaveBeenCalledWith("fj", "git.example.test:3000", null, false);
    const listed = [...container.querySelectorAll("[data-step]")];
    expect(listed.map((s) => [s.getAttribute("data-step"), s.getAttribute("data-state")])).toEqual([
      ["remote", "done"],
      ["credential", "done"],
      ["push", "done"],
    ]);
    expect(container.textContent).toContain("Synced");
    expect(container.textContent).toContain("codeberg.org/me/vault");
  });

  it("the first failure stops the list: its words and kind, the rest waiting", async () => {
    ipc.tools.mockResolvedValue({ git: true, canInstallGit: false, forges: [gh()] });
    ipc.signIn.mockResolvedValue({
      steps: steps(
        ["remote", "done", "github.com/me/v"],
        ["credential", "done", "GitHub CLI"],
        ["push", "failed", "Authentication failed", "auth"],
      ),
      taken: null,
      status: status({ remote: "github.com/me/v", branch: "main" }),
    });
    act(() => useGitStatus.getState().apply(status()));
    render(<GitSection />);
    await flush();
    await act(async () => rows()[0]!.querySelector("button")!.click());
    const push = container.querySelector('[data-step="push"]')!;
    expect(push.getAttribute("data-state")).toBe("failed");
    expect(push.getAttribute("data-kind")).toBe("auth");
    expect(push.textContent).toContain("Authentication failed");
    expect(push.querySelector('[role="alert"]')).not.toBeNull();

    ipc.signIn.mockResolvedValue({
      steps: steps(
        ["remote", "failed", "Offline", "offline"],
        ["credential", "pending"],
        ["push", "pending"],
      ),
      taken: null,
      status: status(),
    });
    // the remote unlinked again (the form is back): a second try that fails at the first step
    act(() => useGitStatus.getState().apply(status()));
    await act(async () => rows()[0]!.querySelector("button")!.click());
    const waiting = [...container.querySelectorAll('[data-state="pending"]')];
    expect(waiting).toHaveLength(2);
    expect(waiting[0]!.textContent).toContain("Waiting");
  });

  it("a taken name offers Link existing or another name, and runs again with it", async () => {
    ipc.tools.mockResolvedValue({ git: true, canInstallGit: false, forges: [forge()] });
    ipc.signIn.mockResolvedValue({
      steps: steps(
        ["remote", "failed", "Name taken: vault", "taken"],
        ["credential", "pending"],
        ["push", "pending"],
      ),
      taken: "vault",
      status: status(),
    });
    act(() => useGitStatus.getState().apply(status()));
    render(<GitSection />);
    await flush();
    await act(async () => rows()[0]!.querySelector("button")!.click());
    expect(ipc.signIn).toHaveBeenLastCalledWith("fj", "codeberg.org", null, false);
    expect(button("Link existing vault")).toBeDefined();
    await act(async () => button("Link existing vault")!.click());
    expect(ipc.signIn).toHaveBeenLastCalledWith("fj", "codeberg.org", "vault", true);

    const input = container.querySelector(
      'input[aria-label="Repository name"]',
    ) as HTMLInputElement;
    expect((button("Create") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Notes 2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Create")!.click());
    expect(ipc.signIn).toHaveBeenLastCalledWith("fj", "codeberg.org", "Notes 2", false);
  });

  it("with a remote, the HTTPS source buttons are the table's, usable on the remote's host", async () => {
    ipc.tools.mockResolvedValue({
      git: true,
      canInstallGit: false,
      forges: [gh(), forge({ hosts: ["codeberg.org"] })],
    });
    act(() =>
      useGitStatus.getState().apply(
        status({
          remote: "codeberg.org/me/v",
          remoteHost: "codeberg.org",
          branch: "main",
          credentials: "fj",
        }),
      ),
    );
    render(<GitSection />);
    await flush();
    const fjButton = button("Forgejo CLI") as HTMLButtonElement;
    expect(fjButton.getAttribute("aria-pressed")).toBe("true");
    expect(fjButton.disabled).toBe(false);
    // GitHub CLI is signed in, and answers any GitHub host (it has no host list)
    expect((button("GitHub CLI") as HTMLButtonElement).disabled).toBe(false);
    ipc.tools.mockResolvedValue({
      git: true,
      canInstallGit: false,
      forges: [forge({ hosts: ["other.example"] })],
    });
    act(() => root.unmount());
    root = createRoot(container);
    render(<GitSection />);
    await flush();
    expect((button("Forgejo CLI") as HTMLButtonElement).disabled).toBe(true);
  });
  it("a remote with a port matches the CLI's host with that port", async () => {
    ipc.tools.mockResolvedValue({
      git: true,
      canInstallGit: false,
      forges: [forge({ hosts: ["git.example.test:3000"] })],
    });
    act(() =>
      useGitStatus.getState().apply(
        status({
          remote: "git.example.test:3000/me/v",
          remoteHost: "git.example.test:3000",
          branch: "main",
          credentials: "token",
        }),
      ),
    );
    render(<GitSection />);
    await flush();
    expect((button("Forgejo CLI") as HTMLButtonElement).disabled).toBe(false);
    // the same host without the port is another server
    act(() =>
      useGitStatus.getState().apply(
        status({
          remote: "git.example.test/me/v",
          remoteHost: "git.example.test",
          branch: "main",
        }),
      ),
    );
    expect((button("Forgejo CLI") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Settings > Git", () => {
  it("before setup offers the two choices; Use existing needs a repository", async () => {
    act(() => useGitStatus.getState().apply(status({ setUp: false, hasRepo: false })));
    ipc.setup.mockResolvedValue(status());
    render(<GitSection />);
    expect(container.querySelector("[data-git-setup]")).not.toBeNull();
    expect((button("Use") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => button("Set up")!.click());
    expect(ipc.setup).toHaveBeenCalledWith("local");
    expect(container.querySelector("[data-git-setup]")).toBeNull();
    expect(container.textContent).toContain("Remote");
  });

  it("uses an existing repository when there is one", async () => {
    act(() => useGitStatus.getState().apply(status({ setUp: false, hasRepo: true })));
    ipc.setup.mockResolvedValue(status());
    render(<GitSection />);
    await act(async () => button("Use")!.click());
    expect(ipc.setup).toHaveBeenCalledWith("existing");
  });

  it("a setup refused for a missing identity says how to set it", async () => {
    act(() => useGitStatus.getState().apply(status({ setUp: false, hasRepo: false })));
    ipc.setup.mockRejectedValue("Set your git name and email: git config ...");
    render(<GitSection />);
    await act(async () => button("Set up")!.click());
    expect(container.textContent).toContain("git config --global user.email");
  });

  it("after setup: status line, Remote None, Save versions, Agent turns, Advanced folded", () => {
    act(() => useGitStatus.getState().apply(status({ lastCommit: Math.floor(Date.now() / 1000) })));
    render(<GitSection />);
    const text = container.textContent ?? "";
    expect(text).toContain("Local");
    expect(text).toContain("Remote");
    expect(text).toContain("None");
    expect(text).toContain("Save versions");
    expect(text).toContain("Agent turns");
    expect(text).not.toContain("Sync now");
    const advanced = container.querySelector("[data-git-advanced]") as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(advanced.textContent).toContain("Commit message");
    expect(advanced.textContent).toContain("Edit .gitignore");
  });

  it("Advanced: Large files (LFS) over N MB, a toggle that writes both settings", () => {
    const setSetting = vi.fn();
    useSettingsStore.setState({
      settings: { "git.lfs": false, "git.lfs-threshold-mb": 100 },
      setSetting,
    } as never);
    act(() => useGitStatus.getState().apply(status()));
    render(<GitSection />);
    const row = container.querySelector("[data-git-lfs]") as HTMLElement;
    expect(row.textContent).toContain("Large files (LFS)");
    expect(row.textContent).toContain("over");
    expect(row.textContent).toContain("MB");
    expect((row.querySelector("input") as HTMLInputElement).value).toBe("100");
    expect(row.querySelector("[data-git-lfs-hint]")).toBeNull();
    const toggle = row.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    act(() => toggle.click());
    expect(setSetting).toHaveBeenCalledWith("git.lfs", true);
  });

  it("Sign commits: a suggestion shows the reason and the switch writes through the command", async () => {
    const signed = status({ signing: { on: true, key: true, suggested: false } });
    ipc.setSigning.mockResolvedValue(signed);
    act(() =>
      useGitStatus.getState().apply(status({ signing: { on: false, key: true, suggested: true } })),
    );
    render(<GitSection />);
    const row = container.querySelector("[data-git-signing]") as HTMLElement;
    expect(row.textContent).toContain("Sign commits");
    expect(row.textContent).toContain("This repo uses signed commits");
    const toggle = row.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    await act(async () => toggle.click());
    expect(ipc.setSigning).toHaveBeenCalledWith(true);
    expect(useGitStatus.getState().status?.signing.on).toBe(true);
  });

  it("Sign commits is disabled with a hint while git resolves no signing key", () => {
    act(() =>
      useGitStatus
        .getState()
        .apply(status({ signing: { on: false, key: false, suggested: true } })),
    );
    render(<GitSection />);
    const row = container.querySelector("[data-git-signing]") as HTMLElement;
    expect(row.textContent).toContain("Set up a signing key in git first");
    expect((row.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed signature shows its line, one Show logs and Details in Settings and in the panel", () => {
    const failed = status({
      error: "Signing failed: unlock your key",
      errorDetails: "incorrect passphrase",
    });
    act(() => useGitStatus.getState().apply(failed));
    render(<GitSection />);
    expect(container.textContent).toContain("Signing failed: unlock your key");
    expect(container.querySelectorAll("[data-show-logs]")).toHaveLength(1);
    const details = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent === "Details",
    );
    expect(details).toHaveLength(1);
    render(<GitPanel />);
    expect(container.textContent).toContain("Signing failed: unlock your key");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Details")).toBe(
      true,
    );
  });

  it("a failed signature reads as the status error", () => {
    expect(summarize(status({ error: "Signing failed: unlock your key" }))).toMatchObject({
      label: "Error",
      detail: "Signing failed: unlock your key",
    });
  });

  it("the LFS toggle is disabled with a hint while git-lfs is not installed", () => {
    const setSetting = vi.fn();
    useSettingsStore.setState({ settings: {}, setSetting } as never);
    act(() =>
      useGitStatus
        .getState()
        .apply(status({ lfs: { on: false, active: false, available: false, files: 0 } })),
    );
    render(<GitSection />);
    const row = container.querySelector("[data-git-lfs]") as HTMLElement;
    const toggle = row.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(row.textContent).toContain("Install git-lfs to use this");
    act(() => toggle.click());
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("the panel counts the files in LFS and says nothing without any", () => {
    act(() => useGitStatus.getState().apply(status()));
    render(<GitPanel />);
    expect(container.querySelector("[data-git-lfs-count]")).toBeNull();
    act(() =>
      useGitStatus
        .getState()
        .apply(status({ lfs: { on: false, active: false, available: true, files: 3 } })),
    );
    expect(container.querySelector("[data-git-lfs-count]")?.textContent).toBe(
      "Large files (LFS): 3",
    );
  });

  it("opening the page asks git for the commit identity again", async () => {
    act(() => useGitStatus.getState().apply(status()));
    render(<GitSection />);
    await flush();
    expect(ipc.status).toHaveBeenCalledWith(true);
  });

  it("without a vault it says so", () => {
    useWorkspaceStore.setState({ root: null } as never);
    render(<GitSection />);
    expect(container.textContent).toContain("Open a vault");
  });
});
