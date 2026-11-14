// End-to-end: configuring Copilot Agent Mode's agents (Claude, Codex, OpenCode) inside Writer.
// UNMODIFIED Copilot 4.0.20, trusted scratch vault, FAKE claude / codex-acp / opencode binaries.
//   SPEC=copilot-agents-config.spec.js sh fixtures/copilot-fake-claude/run.sh
//
// Covers: Claude is detected; every "Configure" button opens a VISIBLE dialog (the host owns the
// modal layout); Auto-detect / Save path / Sign in / Copy / external links / "Open folder" have
// an observable effect for Claude and for the other agents; no plugin or page errors.
// Native pickers do not exist in Copilot's agent settings (no Browse button), so none is driven.
// Open/reveal requests are observed through WRITER_E2E_OPEN_LOG (Rust e2e feature only).
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.WRITER_E2E_COPILOT_VAULT;
const AGENTS = process.env.WRITER_E2E_AGENTS_DIR;
const OPEN_LOG = process.env.WRITER_E2E_OPEN_LOG;
const CLAUDE_LOG = process.env.WRITER_E2E_FAKE_CLAUDE_LOG;
const SHOTS = process.env.WRITER_E2E_SHOTS || join(HERE, "../.cache/shots");
const PAGE = '[data-plugin-settings-page="copilot"]';

const shot = async (name) => {
  try {
    mkdirSync(SHOTS, { recursive: true });
    await browser.saveScreenshot(join(SHOTS, `copilot-agents-${name}.png`));
  } catch {
    /* best effort */
  }
};
const lines = (file) =>
  file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
const savedBackends = () => {
  try {
    const d = JSON.parse(readFileSync(join(VAULT, ".obsidian/plugins/copilot/data.json"), "utf8"));
    return JSON.stringify(d.agentMode?.backends ?? null);
  } catch (e) {
    return String(e);
  }
};
const agentLog = () => lines(join(AGENTS, "agents-invocations.log"));

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
  const item = await $(`[cmdk-item][data-value="${id}"]`);
  await item.waitForExist({ timeout: 8_000 });
  await item.click();
}

/** Clicks the first button-like element with exactly this text under `root`; throws with what IS there. */
const clickText = async (root, text) => {
  const res = await browser.execute(
    (r, t) => {
      const scope = document.querySelector(r) ?? document;
      const all = Array.from(
        scope.querySelectorAll("button, [role=tab], [role=radio], a, [role=button]"),
      );
      const el = all.find((e) => e.textContent.trim() === t || e.getAttribute("aria-label") === t);
      if (el) el.click();
      return {
        clicked: !!el,
        have: all.map((e) => e.textContent.trim() || e.getAttribute("aria-label")),
      };
    },
    root,
    text,
  );
  if (!res.clicked)
    throw new Error(
      `no "${text}" under ${root}; have: ${JSON.stringify(res.have.filter(Boolean))}`,
    );
  return true;
};
const textOf = (sel) => browser.execute((s) => document.querySelector(s)?.innerText ?? "", sel);
const MODAL = ".modal-container";

async function openOptions() {
  await runCommand("open-settings");
  const options = await $("[data-community-plugins]").$("button=Options");
  await options.waitForExist({ timeout: 40_000 });
  await options.click();
  await $(PAGE).waitForExist({ timeout: 10_000 });
  await browser.waitUntil(async () => (await textOf(PAGE)).includes("Default agent"), {
    timeout: 20_000,
    timeoutMsg: "Copilot agent settings never rendered",
  });
}
async function selectAgent(name) {
  ok(await clickText(PAGE, name), `no ${name} tab`);
  await browser.waitUntil(
    async () => {
      const t = await textOf(PAGE);
      return t.includes("Quick Chat") && t.includes(name);
    },
    { timeout: 5_000 },
  );
  await browser.pause(400);
}
async function openConfigure(name) {
  await selectAgent(name);
  ok(await clickText(PAGE, `Configure`), `no Configure button for ${name}`);
  await $(MODAL).waitForExist({ timeout: 8_000 });
  await browser.waitUntil(async () => (await textOf(MODAL)).includes(`Configure ${name}`), {
    timeout: 8_000,
    timeoutMsg: `dialog for ${name}: ${await textOf(MODAL)}`,
  });
}
async function closeModal() {
  ok(await clickText(MODAL, "Done"), "no Done button");
  await browser.waitUntil(async () => !(await $(MODAL).isExisting()), { timeout: 5_000 });
}
const waitText = async (sel, needle, timeout = 15_000) => {
  try {
    await browser.waitUntil(async () => (await textOf(sel)).includes(needle), { timeout });
  } catch {
    throw new Error(
      `"${needle}" never appeared in ${sel}: ${(await textOf(sel)).slice(0, 700)} | notices: ${await browser.execute(
        () =>
          Array.from(document.querySelectorAll("[class*=notice]"))
            .map((e) => e.textContent)
            .join(" / "),
      )} | agents log: ${JSON.stringify(agentLog())} | saved backends: ${savedBackends()} | console: ${JSON.stringify(await browser.execute(() => (window.__e2eLogs || []).slice(-15)))} | plugin errors: ${JSON.stringify(await browser.execute(() => window.__writerPluginErrors || []))} | page errors: ${JSON.stringify(await browser.execute(() => window.__e2eErrors))}`,
    );
  }
};

describe("Copilot agent configuration (Claude, Codex, OpenCode)", function () {
  this.timeout(180_000);

  before(async function () {
    if (!VAULT || !AGENTS || !OPEN_LOG) {
      console.log(
        "SKIP: run via `SPEC=copilot-agents-config.spec.js sh fixtures/copilot-fake-claude/run.sh`",
      );
      this.skip();
    }
    rmSync(OPEN_LOG, { force: true });
    mkdirSync(join(VAULT, "copilot"), { recursive: true });
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 30_000 });
    await browser.execute(() => {
      window.__e2eErrors = [];
      const show = (v) => (v && v.stack ? `${v.name}: ${v.message}\n${v.stack}` : String(v));
      window.__e2eLogs = [];
      for (const k of ["log", "info", "warn", "debug"]) {
        const orig = console[k].bind(console);
        console[k] = (...a) => {
          window.__e2eLogs.push(`${k}: ${a.map(show).join(" ")}`.slice(0, 500));
          orig(...a);
        };
      }
      const ce = console.error.bind(console);
      console.error = (...a) => {
        window.__e2eErrors.push(a.map(show).join(" ").slice(0, 2000));
        ce(...a);
      };
      window.addEventListener("error", (e) => window.__e2eErrors.push(show(e.error || e.message)));
      window.addEventListener("unhandledrejection", (e) =>
        window.__e2eErrors.push(`unhandledrejection: ${show(e.reason)}`),
      );
      // Clipboard writes are recorded (and not performed).
      window.__clip = [];
      navigator.clipboard.writeText = async (t) => void window.__clip.push(String(t));
    });
    await openOptions();
  });

  afterEach(async () => {
    // A failed step must not leave a dialog open for the next one.
    await browser.execute(() => document.querySelector(".modal-close-button")?.click());
  });

  it("Claude is detected at the fake binary and its panel is ready", async function () {
    await selectAgent("Claude");
    await waitText(PAGE, "Ready");
    const text = await textOf(PAGE);
    const fake = realpathSync(join(VAULT, ".bin/claude"));
    ok(
      text.includes(`${VAULT}/.bin/claude`) || text.includes(fake),
      `the panel does not show the fake claude path: ${text.slice(0, 600)}`,
    );
    const data = JSON.parse(
      readFileSync(join(VAULT, ".obsidian/plugins/copilot/data.json"), "utf8"),
    );
    ok(
      Object.values(data.agentMode.deviceProfiles).some(
        (p) => p.claudeCliPath && realpathSync(p.claudeCliPath) === fake,
      ),
      "claudeCliPath is not the fake",
    );
    await shot("1-claude-ready");
  });

  it("every agent's Configure button opens a visible, centred dialog", async function () {
    for (const name of ["OpenCode", "Claude", "Codex"]) {
      await openConfigure(name);
      const box = await browser.execute((sel) => {
        const c = document.querySelector(sel);
        const m = c.querySelector(".modal");
        const r = m.getBoundingClientRect();
        const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          position: getComputedStyle(c).position,
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          w: window.innerWidth,
          h: window.innerHeight,
          hit: !!mid && m.contains(mid),
        };
      }, MODAL);
      strictEqual(box.position, "fixed", `${name}: ${JSON.stringify(box)}`);
      ok(
        box.left >= 0 && box.top >= 0 && box.right <= box.w && box.bottom <= box.h && box.hit,
        `${name} dialog is not on screen: ${JSON.stringify(box)}`,
      );
      await shot(`2-configure-${name}`);
      await closeModal();
    }
  });

  it("Claude: Auto-detect finds an install, Save path takes the typed fake, Copy copies the install command", async function () {
    await openConfigure("Claude");
    ok(await clickText(MODAL, "Auto-detect"));
    // Candidates are probed with the SYNC fs API from the host's preloaded cache: a real install
    // in a well-known dir (e.g. /opt/homebrew/bin) must be found, whatever else is on PATH.
    await waitText("body", "Found claude at");
    ok(
      /Found claude at \/\S*claude/.test(await textOf("body")),
      (await textOf("body")).slice(-500),
    );
    // Auto-detect persists what it found; put the fake back so the next steps are hermetic.
    const fake = realpathSync(join(VAULT, ".bin/claude"));
    await (await $(`${MODAL} input[type="text"]`)).setValue(fake);
    ok(await clickText(MODAL, "Apply"), "no Apply button");
    await waitText("body", "Claude CLI path saved");
    await browser.waitUntil(
      async () =>
        readFileSync(join(VAULT, ".obsidian/plugins/copilot/data.json"), "utf8").includes(
          ".bin/claude",
        ),
      { timeout: 10_000, timeoutMsg: "the typed Claude path was not persisted" },
    );
    ok(await clickText(MODAL, "Copy"), "no Copy button in the Claude dialog");
    await browser.waitUntil(async () => (await browser.execute(() => window.__clip.length)) > 0, {
      timeout: 5_000,
    });
    const clip = await browser.execute(() => window.__clip);
    ok(
      clip.some((c) => c.includes("claude-code")),
      `clipboard: ${JSON.stringify(clip)}`,
    );
    await shot("3-claude-detect");
    await closeModal();
  });

  it("Claude: Sign in runs `claude auth login` and opens the login URL in the system browser", async function () {
    writeFileSync(join(VAULT, ".bin/signed-out"), "");
    try {
      await openConfigure("Claude");
      await waitText(MODAL, "Sign in with your browser", 20_000);
      rmSync(OPEN_LOG, { force: true });
      ok(await clickText(MODAL, "Sign in with your browser"), "no Sign in button");
      await browser.waitUntil(
        async () =>
          lines(CLAUDE_LOG).some((l) => {
            const e = JSON.parse(l);
            return e.event === "start" && e.argv && e.argv.join(" ").startsWith("auth login");
          }),
        { timeout: 15_000, timeoutMsg: "claude auth login was never spawned" },
      );
      await shot("4-claude-signin");
      // The URL the CLI printed reaches the system browser: automatically, or by following the
      // link Copilot shows (an anchor with target=_blank).
      const opened = () =>
        lines(OPEN_LOG).some((l) => l.startsWith("url\thttps://example.com/oauth"));
      await browser.waitUntil(
        async () =>
          opened() ||
          (await browser.execute(() =>
            Array.from(document.querySelectorAll(".modal a[href]")).some((a) =>
              a.href.startsWith("https://example.com/oauth"),
            ),
          )),
        { timeout: 15_000, timeoutMsg: `no login URL: ${await textOf(MODAL)}` },
      );
      if (!opened())
        await browser.execute(() => {
          Array.from(document.querySelectorAll(".modal a[href]"))
            .find((a) => a.href.startsWith("https://example.com/oauth"))
            .click();
        });
      await browser.waitUntil(async () => opened(), {
        timeout: 8_000,
        timeoutMsg: `open log: ${JSON.stringify(lines(OPEN_LOG))}`,
      });
    } finally {
      rmSync(join(VAULT, ".bin/signed-out"), { force: true });
      await browser.execute(() => document.querySelector(".modal-close-button")?.click());
    }
  });

  it("Codex: Auto-detect reports where it looked; a typed custom adapter is validated and saved", async function () {
    await openConfigure("Codex");
    ok(await clickText(MODAL, "My own installation"));
    await waitText(MODAL, "Auto-detect");
    // Copilot's Codex Auto-detect only checks its own candidate list (not PATH): nothing there
    // is the fake, and the dialog says so and lists the directories it searched.
    ok(await clickText(MODAL, "Auto-detect"));
    await waitText(MODAL, "A supported codex-acp adapter was not found", 20_000);
    await waitText(MODAL, "Searched:");
    await shot("5-codex-not-found");
    // The typed (off-PATH) adapter: stat + access, then `realpathSync` and `provenance.json`,
    // which Copilot reads synchronously next to the adapter, must work for an arbitrary path.
    const typed = realpathSync(join(AGENTS, "typed/bin/codex-acp"));
    const input = await $(`${MODAL} input[type="text"]`);
    await input.setValue(typed);
    ok(await clickText(MODAL, "Apply"), "no Apply button");
    // Accepted (a rejected adapter says "not supported"); the fake is not signed in to anything.
    await waitText(MODAL, "Sign in required", 20_000);
    const data = readFileSync(join(VAULT, ".obsidian/plugins/copilot/data.json"), "utf8");
    ok(data.includes("typed/bin/codex-acp"), "the typed Codex path was not persisted");
    await shot("6-codex-typed");
    // The adapter was started (its ACP session) and the dialog offers Codex's browser sign-in.
    // Clicking it runs the bundled Codex runtime next to the adapter, which a fake cannot stand in
    // for: the real login is for a person to verify.
    ok(
      agentLog().some((l) => l.startsWith("codex-acp\t")),
      `codex-acp never ran: ${agentLog()}`,
    );
    ok(/Sign in with your browser/.test(await textOf(MODAL)), await textOf(MODAL));
    ok(await clickText(MODAL, "Clear"), "no Clear button after a saved path");
    await waitText(MODAL, "Not set up", 10_000);
    await closeModal();
  });

  it("OpenCode: a typed custom path runs `opencode --version` and is saved", async function () {
    await openConfigure("OpenCode");
    ok(await clickText(MODAL, "My own installation"));
    await waitText(MODAL, "Auto-detect");
    const typed = realpathSync(join(AGENTS, "typed/bin/opencode"));
    const input = await $(`${MODAL} input[type="text"]`);
    await input.setValue(typed);
    ok(await clickText(MODAL, "Apply"), "no Apply button");
    await waitText(MODAL, "Ready", 20_000);
    ok(
      agentLog().some((l) => l.startsWith("opencode\t--version")),
      `opencode --version never ran: ${JSON.stringify(agentLog())}`,
    );
    await shot("7-opencode-typed");
    ok(await clickText(MODAL, "Auto-detect"));
    await waitText("body", "Found opencode at", 20_000);
    await closeModal();
  });

  it("Managed by Copilot offers Download & install (not clicked: a real download the host cannot store)", async function () {
    await openConfigure("Codex");
    ok(await clickText(MODAL, "Managed by Copilot"));
    await waitText(MODAL, "Download & install");
    // Clicking would start a real download into a folder outside the vault, which Writer refuses
    // (README: "Managed by Copilot" is unsupported; use "My own installation").
    ok(/Managed by Copilot/.test(await textOf(MODAL)));
    await closeModal();
  });

  it("settings links and folder buttons reach the system", async function () {
    rmSync(OPEN_LOG, { force: true });
    await selectAgent("Claude");
    ok(await clickText(PAGE, "See plans"), "no See plans button");
    await browser.waitUntil(
      async () => lines(OPEN_LOG).some((l) => l.startsWith("url\thttps://")),
      {
        timeout: 8_000,
        timeoutMsg: `window.open never reached the opener: ${JSON.stringify(lines(OPEN_LOG))}`,
      },
    );
    const folder = await $('[aria-label="Open Copilot folder"]');
    await folder.waitForExist({ timeout: 5_000 });
    await folder.click();
    await browser.waitUntil(
      async () =>
        lines(OPEN_LOG).some((l) => l.startsWith("path\treveal\t") && l.endsWith("/copilot")),
      { timeout: 8_000, timeoutMsg: `open log: ${JSON.stringify(lines(OPEN_LOG))}` },
    );
    await shot("8-links");
  });

  it("recorded no plugin errors and no page errors", async function () {
    const errs = await browser.execute(() => window.__writerPluginErrors || []);
    deepStrictEqual(errs, [], JSON.stringify(errs));
    const page = (await browser.execute(() => window.__e2eErrors)).filter(
      (e) => !e.includes("DialogContent"),
    );
    deepStrictEqual(page, [], page.join("\n"));
  });
});
