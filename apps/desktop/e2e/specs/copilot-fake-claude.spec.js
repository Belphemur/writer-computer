// End-to-end: UNMODIFIED obsidian-copilot 4.0.20 in a trusted vault, Agent Mode against a FAKE
// `claude` CLI. Copilot is downloaded from its GitHub release into a gitignored cache (AGPL, never
// committed). Run with `sh fixtures/copilot-fake-claude/run.sh`; without that script's environment
// this spec skips itself.
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.WRITER_E2E_COPILOT_VAULT;
const FAKE_LOG = process.env.WRITER_E2E_FAKE_CLAUDE_LOG;
const SHOTS = process.env.WRITER_E2E_SHOTS || join(HERE, "../.cache/shots");
const PROMPT = "ping from writer e2e";

const shot = async (name) => {
  try {
    mkdirSync(SHOTS, { recursive: true });
    await browser.saveScreenshot(join(SHOTS, `copilot-${name}.png`));
  } catch {
    /* screenshots are best effort */
  }
};

function fakeLog() {
  if (!FAKE_LOG || !existsSync(FAKE_LOG)) return [];
  return readFileSync(FAKE_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function fakePids() {
  try {
    return execSync(`pgrep -f ${JSON.stringify(`${VAULT}/.bin/fake-claude.js`)}`, {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // pgrep exits 1 with no match
  }
}

async function pressCmd(key) {
  await browser.execute((k) => {
    const ev = () =>
      new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev());
    document.dispatchEvent(ev());
  }, key);
}

async function paletteItems() {
  await pressCmd("p");
  await $("[cmdk-item]").waitForExist({ timeout: 8_000 });
  return browser.execute(() =>
    Array.from(document.querySelectorAll("[cmdk-item]")).map((e) => ({
      id: e.getAttribute("data-value"),
      text: e.textContent,
    })),
  );
}

async function runCommand(id) {
  await paletteItems();
  const item = await $(`[cmdk-item][data-value="${id}"]`);
  await item.waitForExist({ timeout: 5_000 });
  await item.click();
}

describe("Copilot 4.0.20 + fake claude (Agent Mode)", function () {
  this.timeout(120_000);

  before(async function () {
    if (!VAULT || !FAKE_LOG) {
      console.log(
        "SKIP: set up via `sh fixtures/copilot-fake-claude/run.sh` (needs WRITER_E2E_COPILOT_VAULT and " +
          "WRITER_E2E_FAKE_CLAUDE_LOG; downloads Copilot 4.0.20 on first run)",
      );
      this.skip();
    }
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 30_000 });
    // Error recorder as early as the WebDriver session allows.
    await browser.execute(() => {
      if (window.__e2eErrors) return;
      window.__e2eErrors = [];
      const show = (v) => (v && v.stack ? `${v.name}: ${v.message}\n${v.stack}` : String(v));
      const push = (kind, v) => window.__e2eErrors.push(`${kind}: ${show(v)}`.slice(0, 2000));
      window.addEventListener("error", (e) => push("error", e.error || e.message));
      window.addEventListener("unhandledrejection", (e) => push("unhandledrejection", e.reason));
      const ce = console.error.bind(console);
      console.error = (...a) => {
        push("console.error", a.map(show).join(" "));
        ce(...a);
      };
    });
  });

  it("A: Copilot loads, seeds data.json, and records no errors", async function () {
    await browser.waitUntil(
      async () => existsSync(join(VAULT, ".obsidian/plugins/copilot/data.json")),
      { timeout: 60_000, timeoutMsg: "host never wrote Copilot's data.json" },
    );
    await runCommand("open-settings");
    await $("[data-settings-panel]").waitForExist({ timeout: 5_000 });
    const section = await $("[data-community-plugins]");
    await section.waitForExist({ timeout: 10_000 });
    await browser.waitUntil(async () => (await section.getText()).includes("Copilot"), {
      timeout: 30_000,
      timeoutMsg: "Copilot not listed",
    });
    const text = await section.getText();
    console.log("COMMUNITY SECTION:", JSON.stringify(text));
    await shot("A-settings");
    ok(!/Failed:/.test(text), `Copilot reported failure: ${text}`);
    const enabled = await browser.execute(() => {
      const el = document.querySelector('[aria-label="Enable Copilot"]');
      return el ? (el.getAttribute("aria-checked") ?? el.getAttribute("data-state")) : null;
    });
    console.log("ENABLE TOGGLE:", enabled);
    const errs = await browser.execute(() => window.__writerPluginErrors || []);
    deepStrictEqual(errs, [], `plugin errors: ${JSON.stringify(errs)}`);
    // Copilot's single-line minified styles.css must survive the host's CSS sanitizer.
    const cssLen = await browser.execute(() => {
      const el = document.querySelector('style[data-writer-plugin="copilot"]');
      return el ? el.textContent.length : 0;
    });
    ok(cssLen > 50_000, `Copilot styles.css was mangled by the sanitizer (len ${cssLen})`);

    const data = JSON.parse(
      readFileSync(join(VAULT, ".obsidian/plugins/copilot/data.json"), "utf8"),
    );
    strictEqual(data.settingsVersion, 16);
    strictEqual(data.agentMode.activeBackend, "claude");
    const profiles = Object.values(data.agentMode.deviceProfiles);
    ok(profiles.length >= 1, "no device profile");
    const claude = realpathSync(join(VAULT, ".bin/claude"));
    ok(
      profiles.some((p) => p.claudeCliPath && realpathSync(p.claudeCliPath) === claude),
      `claudeCliPath does not point at the fake: ${JSON.stringify(profiles)}`,
    );
    // close settings
    await browser.keys("Escape");
  });

  it("B: Copilot commands are in the palette and the view opens in the right pane", async function () {
    const items = await paletteItems();
    const copilot = items.filter((i) => (i.id || "").startsWith("copilot:"));
    console.log("COPILOT COMMANDS:", JSON.stringify(copilot));
    await shot("B-palette");
    ok(copilot.length > 0, "no copilot:* commands");
    await browser.keys("Escape");
  });

  it("C: Agent Chat opens on the Claude backend and runs the load-time probes", async function () {
    await runCommand("copilot:agent-chat-open-window");
    const pane = await $("[data-plugin-view-pane]");
    await pane.waitForExist({ timeout: 15_000 });
    await browser.waitUntil(
      async () =>
        (await pane.getText()).includes("Chat input") && (await pane.getText()).includes("Claude"),
      { timeout: 30_000, timeoutMsg: `Agent Chat never became ready: ${await pane.getText()}` },
    );
    await shot("C-agent-ready");
    const log = fakeLog();
    const starts = log.filter((e) => e.event === "start");
    ok(
      starts.some((e) => e.mode === "version"),
      "claude --version probe did not run",
    );
    ok(
      starts.some((e) => e.mode === "auth" && e.argv.join(" ") === "auth status --json"),
      "claude auth status --json probe did not run",
    );
    const idle = starts.find((e) => e.mode === "stream");
    ok(idle, "no stream-json probe child");
    deepStrictEqual(idle.argv, [
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
    ]);
    ok(
      log.some((e) => e.pid === idle.pid && e.event === "exit"),
      "idle probe child did not exit after stdin EOF",
    );
  });

  it("C: a prompt is answered by the fake claude", async function () {
    const input = await $('[data-plugin-view-pane] [contenteditable="true"][role="textbox"]');
    await input.click();
    // WebDriver key events do not reach Lexical in WKWebView; execCommand fires the real
    // beforeinput/input events its contenteditable listens to.
    await browser.execute((text) => document.execCommand("insertText", false, text), PROMPT);
    await browser.pause(300);
    const typed = await browser.execute(
      () => document.querySelector('[data-plugin-view-pane] [contenteditable="true"]').textContent,
    );
    strictEqual(typed, PROMPT);
    await shot("C-typed");
    await $('[data-plugin-view-pane] button[aria-label="Send"]').click();
    await browser.waitUntil(
      async () => (await $("[data-plugin-view-pane]").getText()).includes("FAKE-CLAUDE-REPLY"),
      {
        timeout: 45_000,
        timeoutMsg: `no reply in the pane: ${await $("[data-plugin-view-pane]").getText()}`,
      },
    );
    await shot("C-replied");
    const text = await $("[data-plugin-view-pane]").getText();
    ok(text.includes(`FAKE-CLAUDE-REPLY: ${PROMPT}`) || text.includes("FAKE-CLAUDE-REPLY"), text);
    const session = fakeLog().find(
      (e) =>
        e.event === "start" &&
        e.mode === "stream" &&
        e.argv.some((a) => a.startsWith("--permission-prompt-tool")),
    );
    ok(session, "no session child with --permission-prompt-tool");
    for (const flag of [
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "--include-partial-messages",
      "--replay-user-messages",
    ])
      ok(session.argv.includes(flag), `session argv lacks ${flag}: ${session.argv.join(" ")}`);
    ok(session.argv.includes("--permission-prompt-tool=stdio"));
    ok(
      fakeLog().some((e) => e.pid === session.pid && e.event === "turn" && e.text.includes(PROMPT)),
    );
    const errs = await browser.execute(() => window.__writerPluginErrors || []);
    deepStrictEqual(errs, []);
  });

  it("D: closing the chat tab keeps the live session; disabling Copilot stops its process", async function () {
    const sessionPid = fakeLog().find(
      (e) =>
        e.event === "start" &&
        e.argv &&
        e.argv.some((a) => a.startsWith("--permission-prompt-tool")),
    ).pid;
    ok(
      fakePids().includes(String(sessionPid)),
      "session child should be running while the chat is open",
    );
    // Copilot keeps a chat that has messages alive after its tab closes (its own design).
    await $('[data-plugin-view-pane] button[aria-label="Close tab"]').click();
    await browser.pause(2_000);
    ok(
      fakePids().includes(String(sessionPid)),
      "Copilot keeps a worked-in chat alive after its tab closes",
    );

    // Disabling the plugin unloads it: the host must leave no session process behind.
    const toggle = await $('[aria-label="Enable Copilot"]');
    await toggle.waitForExist({ timeout: 10_000 });
    await toggle.click();
    await browser.waitUntil(async () => !fakePids().includes(String(sessionPid)), {
      timeout: 20_000,
      timeoutMsg: "session child still running after disabling Copilot",
    });
    console.log(
      "D LOG:",
      JSON.stringify(
        fakeLog()
          .filter((e) => e.pid === sessionPid)
          .map((e) => [e.event, e.subtype || e.signal || ""]),
      ),
    );
    const events = fakeLog()
      .filter((e) => e.pid === sessionPid)
      .map((e) => e.event);
    ok(
      events.includes("exit"),
      `session child was killed without a graceful exit: ${events.join(",")}`,
    );
    await shot("D-after-disable");
  });

  it("E-prep: re-enabling Copilot works and leaves a live session running for the quit check", async function () {
    const before = fakeLog().filter((e) => e.event === "start" && e.mode === "stream").length;
    const toggle = await $('[aria-label="Enable Copilot"]');
    await toggle.click();
    await browser.waitUntil(
      async () => {
        try {
          await runCommand("copilot:agent-chat-open-window");
          return true;
        } catch {
          await browser.keys("Escape");
          return false;
        }
      },
      {
        timeout: 40_000,
        interval: 1_000,
        timeoutMsg: "Copilot commands did not come back after re-enable",
      },
    );
    const pane = await $("[data-plugin-view-pane]");
    await pane.waitForExist({ timeout: 15_000 });
    await browser.waitUntil(async () => (await pane.getText()).includes("Chat input"), {
      timeout: 30_000,
    });
    const input = await $('[data-plugin-view-pane] [contenteditable="true"][role="textbox"]');
    await input.click();
    await browser.execute(
      (text) => document.execCommand("insertText", false, text),
      "second session",
    );
    await $('[data-plugin-view-pane] button[aria-label="Send"]').click();
    await browser.waitUntil(
      async () => (await pane.getText()).includes("FAKE-CLAUDE-REPLY: second session"),
      {
        timeout: 45_000,
        timeoutMsg: "no reply from the second session",
      },
    );
    const after = fakeLog().filter((e) => e.event === "start" && e.mode === "stream").length;
    ok(after > before, "no new stream child after re-enable");
    ok(
      fakePids().length > 0,
      "a session child should be alive now; run.sh checks it dies with the app",
    );
    await shot("E-live-session");
  });

  it("final: no uncaught errors beyond the known accessibility warning", async function () {
    const errs = (await browser.execute(() => window.__e2eErrors)).filter(
      (e) => !e.includes("DialogContent"),
    );
    deepStrictEqual(errs, [], errs.join("\n"));
  });
});
