// End-to-end: UNMODIFIED obsidian-copilot 4.0.20 inside Writer. Run with
//   SPEC=copilot-history-and-tabs.spec.js sh fixtures/copilot-fake-claude/run.sh
// Covers: A) recent chats survive an app restart, B) a view opened with getLeaf(true) is a real
// editor tab, C) open-note opens the note in the main editor, D) the plugin's active note follows
// Writer's navigation.
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.WRITER_E2E_COPILOT_VAULT;
const SHOTS = process.env.WRITER_E2E_SHOTS || join(HERE, "../.cache/shots");
const PROMPT = "history probe from writer e2e";
const CHATS = "copilot/copilot-conversations";

const shot = async (name) => {
  try {
    mkdirSync(SHOTS, { recursive: true });
    await browser.saveScreenshot(join(SHOTS, `copilot-hist-${name}.png`));
  } catch {
    /* best effort */
  }
};

async function pressCmd(key) {
  await browser.execute((k) => {
    const ev = () =>
      new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev());
    document.dispatchEvent(ev());
  }, key);
}

async function runCommand(id) {
  await pressCmd("p");
  await $("[cmdk-item]").waitForExist({ timeout: 8_000 });
  const item = await $(`[cmdk-item][data-value="${id}"]`);
  await item.waitForExist({ timeout: 5_000 });
  await item.click();
}

async function waitForCopilot() {
  await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 30_000 });
  await browser.waitUntil(
    async () => {
      try {
        await pressCmd("p");
        await $("[cmdk-item]").waitForExist({ timeout: 3_000 });
        const has = await browser.execute(() =>
          Boolean(document.querySelector('[cmdk-item][data-value^="copilot:"]')),
        );
        await browser.keys("Escape");
        return has;
      } catch {
        return false;
      }
    },
    { timeout: 60_000, interval: 1_000, timeoutMsg: "Copilot commands never appeared" },
  );
}

const SURFACE = "[data-plugin-view-pane], [data-plugin-view-tab]";
const surfaceText = () =>
  browser.execute(
    (sel) => Array.from(document.querySelectorAll(sel), (e) => e.textContent).join("\n"),
    SURFACE,
  );

async function openAgentChat() {
  await runCommand("copilot:agent-chat-open-window");
  const pane = await $(SURFACE);
  await pane.waitForExist({ timeout: 15_000 });
  await browser.waitUntil(async () => (await surfaceText()).includes("Chat input"), {
    timeout: 30_000,
    timeoutMsg: `Agent Chat never became ready: ${await surfaceText()}`,
  });
  return pane;
}

const tabTitles = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll('button[aria-label^="Close "]'))
      .filter((b) => !b.closest("[data-plugin-view-tab], [data-plugin-view-pane]"))
      .map((b) => (b.getAttribute("aria-label") || "").slice("Close ".length)),
  );

const dataJson = () => join(VAULT, ".obsidian/plugins/copilot/data.json");

const indexInVault = () => {
  const dir = join(VAULT, ".obsidian/plugins/copilot/home");
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true }).filter((f) =>
        String(f).endsWith("agent-chat-index.json"),
      )
    : [];
};

async function recordConsole() {
  await browser.execute(() => {
    if (window.__e2eConsole) return;
    window.__e2eConsole = [];
    for (const m of ["warn", "error"]) {
      const orig = console[m].bind(console);
      console[m] = (...a) => {
        window.__e2eConsole.push(
          `${m}: ${a.map((x) => (x && x.stack ? x.stack : String(x))).join(" ")}`.slice(0, 1500),
        );
        orig(...a);
      };
    }
  });
}
const consoleLog = () => browser.execute(() => window.__e2eConsole || []);

const chatFiles = () => {
  const dir = join(VAULT, CHATS);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
};

describe("Copilot 4.0.20: history, tabs, open-note, active note", function () {
  this.timeout(180_000);

  before(async function () {
    if (!VAULT) this.skip();
    await waitForCopilot();
    // Copilot reads its settings at load. Turn on markdown autosave (Copilot's own default; the
    // host seed turns it off) and restart the app. The open area stays at Copilot's default
    // ("Sidebar view").
    await browser.waitUntil(async () => existsSync(dataJson()), {
      timeout: 60_000,
      timeoutMsg: "the host never wrote Copilot's data.json",
    });
    const data = JSON.parse(readFileSync(dataJson(), "utf8"));
    data.autosaveChat = true;
    writeFileSync(dataJson(), JSON.stringify(data));
    await browser.reloadSession();
    await waitForCopilot();
    await recordConsole();
  });

  it("A1: a chat is saved, and the Copilot chat lives in the right side pane (no editor tab)", async function () {
    const tabsBefore = await tabTitles();
    await openAgentChat();
    ok(await $("[data-plugin-view-pane]").isExisting(), "Copilot chat is not in the side pane");
    ok(!(await $("[data-plugin-view-tab]").isExisting()), "Copilot chat became an editor tab");
    deepStrictEqual(await tabTitles(), tabsBefore, "opening the chat created an editor tab");
    await shot("A1-chat-in-sidebar");
    const input = await $('[data-plugin-view-pane] [contenteditable="true"][role="textbox"]');
    await input.click();
    await browser.execute((t) => document.execCommand("insertText", false, t), PROMPT);
    await $('[data-plugin-view-pane] button[aria-label="Send"]').click();
    await browser.waitUntil(async () => (await surfaceText()).includes("FAKE-CLAUDE-REPLY"), {
      timeout: 45_000,
    });
    await browser.waitUntil(async () => chatFiles().length > 0, {
      timeout: 30_000,
      timeoutMsg: "Copilot never wrote a chat note",
    });
    console.log("CHAT FILES:", chatFiles());
  });

  it("A1b: Copilot's session index (~/.obsidian-copilot/vaults/<id>/agent-chat-index.json) is persisted", async function () {
    await browser.waitUntil(async () => indexInVault().length > 0, {
      timeout: 15_000,
      timeoutMsg: `agent-chat-index.json was never written; plugin errors: ${JSON.stringify(await browser.execute(() => window.__writerPluginErrors || []))}; console: ${JSON.stringify(await consoleLog())}`,
    });
    const file = join(VAULT, ".obsidian/plugins/copilot/home", String(indexInVault()[0]));
    const index = JSON.parse(readFileSync(file, "utf8"));
    ok(index.entries.length >= 1, `the session index has no entries: ${JSON.stringify(index)}`);
    strictEqual(index.entries[0].backendId, "claude");
  });

  it("A2: recent chats are listed after the app restarts", async function () {
    await browser.reloadSession();
    await waitForCopilot();
    await openAgentChat();
    await shot("A2-after-restart");
    await browser.waitUntil(async () => (await surfaceText()).includes(PROMPT), {
      timeout: 20_000,
      timeoutMsg: `recent chats do not list the saved chat after restart; text: ${await surfaceText()}`,
    });
    await shot("A2-listed");
  });

  it("D: the plugin's active note follows navigation in Writer", async function () {
    const text = async () => (await surfaceText()).replace(/\s+/g, " ").toLowerCase();
    for (const name of ["alpha", "beta"]) {
      const row = await $(`[data-tree-path$="/${name}.md"]`);
      await row.waitForExist({ timeout: 10_000 });
      await row.click();
      await browser.waitUntil(async () => (await text()).includes(name), {
        timeout: 10_000,
        timeoutMsg: `Copilot's active note did not follow to ${name}: ${await text()}`,
      });
      await shot(`D-${name}`);
    }
    // Closing every tab leaves no active note: the badge disappears.
    for (let i = 0; i < 4; i++) {
      await browser.execute(() => {
        const b = Array.from(document.querySelectorAll('button[aria-label^="Close "]')).find(
          (x) => !x.closest("[data-plugin-view-pane]"),
        );
        if (b) b.click();
      });
    }
    await browser.waitUntil(async () => !(await text()).includes("beta"), {
      timeout: 10_000,
      timeoutMsg: `Copilot still shows an active note after all tabs closed: ${await text()}`,
    });
    await shot("D-closed");
    deepStrictEqual(await browser.execute(() => window.__writerPluginErrors || []), []);
  });

  it("C: Open chat note opens the note in a NEW tab of the main editor", async function () {
    const row = await $('[data-tree-path$="/alpha.md"]');
    await row.click();
    await browser.waitUntil(async () => (await tabTitles()).length >= 1);
    const before = await tabTitles();
    await browser.execute(() => {
      const b = document.querySelector('button[aria-label="Open chat note"]');
      if (!b) throw new Error("no 'Open chat note' button in the recent chats");
      b.click();
    });
    await browser.waitUntil(async () => (await tabTitles()).some((t) => t.startsWith("agent__")), {
      timeout: 15_000,
      timeoutMsg: `no editor tab for the chat note: ${JSON.stringify(await tabTitles())}`,
    });
    const after = await tabTitles();
    strictEqual(after.length, before.length + 1, `expected a new tab: ${before} -> ${after}`);
    for (const t of before) ok(after.includes(t), `the ${t} tab was replaced`);
    ok(await $("[data-plugin-view-pane]").isExisting(), "the chat must stay in the side pane");
    await shot("C-note-new-tab");
  });

  it("B: a view the plugin opens with getLeaf(true) is a real editor tab", async function () {
    // Copilot's "Editor" open area opens its view with getLeaf(true) + setViewState, the same call
    // its diff/apply view makes. (Default stays "Sidebar view"; only this test switches it.)
    const data = JSON.parse(readFileSync(dataJson(), "utf8"));
    data.defaultOpenArea = "editor";
    writeFileSync(dataJson(), JSON.stringify(data));
    await browser.reloadSession();
    await waitForCopilot();
    await runCommand("copilot:agent-chat-open-window");
    await $("[data-plugin-view-tab]").waitForExist({ timeout: 15_000 });
    ok(!(await $("[data-plugin-view-pane]").isExisting()), "the view landed in the side pane");
    const titles = await tabTitles();
    ok(
      titles.some((t) => /copilot|chat/i.test(t)),
      `no tab titled after the Copilot view: ${JSON.stringify(titles)}`,
    );
    await shot("B-main-tab");
    // Closing the tab closes the view.
    await browser.execute(() => {
      const b = Array.from(document.querySelectorAll('button[aria-label^="Close "]')).find(
        (x) =>
          /copilot/i.test(x.getAttribute("aria-label") || "") &&
          !x.closest("[data-plugin-view-tab]"),
      );
      if (!b) throw new Error("no close button on the Copilot tab");
      b.click();
    });
    await browser.waitUntil(async () => !(await tabTitles()).some((t) => /copilot/i.test(t)), {
      timeout: 10_000,
      timeoutMsg: `the Copilot tab is still open: ${await tabTitles()}`,
    });
    await browser.waitUntil(async () => !(await $("[data-plugin-view-tab]").isExisting()), {
      timeout: 10_000,
      timeoutMsg: "closing the tab did not close the view",
    });
  });
});
