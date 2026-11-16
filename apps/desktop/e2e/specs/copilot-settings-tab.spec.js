// End-to-end: a community plugin's options are a section of the Settings sidebar (UNVERIFIED after
// the settings-sidebar refactor: not run in a real window yet). Uses the same fixture as
// copilot-fake-claude.spec.js (UNMODIFIED Copilot 4.0.20, trusted scratch vault):
//   SPEC=copilot-settings-tab.spec.js sh fixtures/copilot-fake-claude/run.sh
import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.WRITER_E2E_COPILOT_VAULT;
const SHOTS = process.env.WRITER_E2E_SHOTS || join(HERE, "../.cache/shots");
const PAGE = '[data-settings-panel] [role="tabpanel"]';
const NAV_COPILOT = '[data-settings-nav] [role="tab"]';
// Copilot's own SettingsMainV2 tab labels (src/settings/v2/SettingsMainV2.tsx @ 4.0.20).
const COPILOT_TABS = ["Basic", "BYOK", "Commands", "Skills", "Connectors", "Advanced"];

const shot = async (name) => {
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(join(SHOTS, `copilot-settings-tab-${name}.png`));
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
  const item = await $(`[cmdk-item][data-value="${id}"]`);
  await item.waitForExist({ timeout: 8_000 });
  await item.click();
}

const navLabels = () =>
  browser.execute(
    (sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.textContent.trim()),
    NAV_COPILOT,
  );
const clickNav = (label) =>
  browser.execute(
    (sel, l) =>
      Array.from(document.querySelectorAll(sel))
        .find((e) => e.textContent.trim().startsWith(l))
        ?.click(),
    NAV_COPILOT,
    label,
  );

describe("Plugin options open in their own tab (Copilot 4.0.20)", function () {
  this.timeout(120_000);

  before(async function () {
    if (!VAULT) {
      console.log(
        "SKIP: run via `SPEC=copilot-settings-tab.spec.js sh fixtures/copilot-fake-claude/run.sh`",
      );
      this.skip();
    }
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 30_000 });
    await browser.execute(() => {
      window.__e2eErrors = [];
      const show = (v) => (v && v.stack ? `${v.name}: ${v.message}\n${v.stack}` : String(v));
      const ce = console.error.bind(console);
      console.error = (...a) => {
        window.__e2eErrors.push(a.map(show).join(" ").slice(0, 2000));
        ce(...a);
      };
      window.addEventListener("error", (e) => window.__e2eErrors.push(show(e.error || e.message)));
    });
  });

  it("the Copilot sidebar entry renders real Copilot settings in the content pane", async function () {
    await runCommand("open-settings");
    await $("[data-settings-nav]").waitForExist({ timeout: 10_000 });
    await browser.waitUntil(async () => (await navLabels()).includes("Copilot"), {
      timeout: 40_000,
      timeoutMsg: `no Copilot entry in the sidebar: ${await navLabels()}`,
    });
    await clickNav("Copilot");
    const page = await $(PAGE);
    await browser.waitUntil(
      async () => {
        const text = await page.getText();
        return COPILOT_TABS.every((t) => text.includes(t));
      },
      { timeout: 20_000, timeoutMsg: `Copilot settings never rendered: ${await page.getText()}` },
    );
    const size = await browser.execute((sel) => {
      const el = document.querySelector(`${sel} .vertical-tab-content`);
      const r = el.getBoundingClientRect();
      return { connected: el.isConnected, w: r.width, h: r.height };
    }, PAGE);
    ok(size.connected && size.w > 300 && size.h > 200, `cramped/empty: ${JSON.stringify(size)}`);
    await shot("opened");
  });

  it("Options in Manage plugins selects the Copilot section; leaving it tears the plugin UI down", async function () {
    await clickNav("Manage plugins");
    await (await $("[data-community-plugins]").$("button=Options")).click();
    await browser.waitUntil(
      async () => await $(`${PAGE} [data-plugin-settings-host="copilot"]`).isExisting(),
      { timeout: 10_000 },
    );
    await clickNav("Editor");
    await browser.waitUntil(
      async () => !(await $(`${PAGE} [data-plugin-settings-host="copilot"]`).isExisting()),
      { timeout: 5_000 },
    );
  });

  it("disabling Copilot removes its sidebar entry", async function () {
    await clickNav("Manage plugins");
    await (await $('[aria-label="Enable Copilot"]')).click();
    await browser.waitUntil(async () => !(await navLabels()).includes("Copilot"), {
      timeout: 20_000,
    });
    await shot("disabled");
  });

  it("recorded no plugin errors and no uncaught page errors", async function () {
    const errs = await browser.execute(() => window.__writerPluginErrors || []);
    deepStrictEqual(errs, [], JSON.stringify(errs));
    const page = (await browser.execute(() => window.__e2eErrors)).filter(
      (e) => !e.includes("DialogContent"),
    );
    deepStrictEqual(page, [], page.join("\n"));
  });
});
