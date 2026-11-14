// End-to-end: a community plugin's options open in their OWN editor tab. Uses the same fixture as
// copilot-fake-claude.spec.js (UNMODIFIED Copilot 4.0.20, trusted scratch vault):
//   SPEC=copilot-settings-tab.spec.js sh fixtures/copilot-fake-claude/run.sh
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.WRITER_E2E_COPILOT_VAULT;
const SHOTS = process.env.WRITER_E2E_SHOTS || join(HERE, "../.cache/shots");
const PAGE = '[data-plugin-settings-page="copilot"]';
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

const tabTitles = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll("[role=button] > span"))
      .map((e) => e.textContent.trim())
      .filter((t) => t.endsWith("options")),
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

  it("Options opens a 'Copilot options' tab that renders real Copilot settings", async function () {
    await runCommand("open-settings");
    const section = await $("[data-community-plugins]");
    await section.waitForExist({ timeout: 10_000 });
    const options = await section.$("button=Options");
    await options.waitForExist({ timeout: 40_000 });
    await options.click();

    const page = await $(PAGE);
    await page.waitForExist({ timeout: 10_000 });
    // No inline accordion any more: the settings page holds no plugin UI.
    strictEqual(
      await browser.execute(
        () => document.querySelector("[data-community-plugins] .vertical-tab-content") !== null,
      ),
      false,
    );
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
    deepStrictEqual(await tabTitles(), ["Copilot options"]);
    await shot("opened");
  });

  it("clicking Options again focuses the same tab; closing it tears the plugin UI down", async function () {
    await runCommand("open-settings");
    const options = await $("[data-community-plugins]").$("button=Options");
    await options.click();
    await $(PAGE).waitForExist();
    deepStrictEqual(await tabTitles(), ["Copilot options"]);

    // Close the options tab (its close button sits in the tab row).
    const closed = await browser.execute(() => {
      const tab = Array.from(document.querySelectorAll("[role=button]")).find(
        (e) => e.querySelector(":scope > span")?.textContent.trim() === "Copilot options",
      );
      const btn = tab?.querySelector("button");
      btn?.click();
      return !!btn;
    });
    ok(closed, "no close button on the options tab");
    await browser.waitUntil(async () => !(await $(PAGE).isExisting()), { timeout: 5_000 });
    deepStrictEqual(await tabTitles(), []);
  });

  it("disabling Copilot leaves a 'Plugin not loaded' state in an open options tab", async function () {
    await runCommand("open-settings");
    await (await $("[data-community-plugins]").$("button=Options")).click();
    await $(PAGE).waitForExist();
    // The toggle lives on the Settings page: focus it, switch Copilot off, come back.
    await runCommand("open-settings");
    await (await $('[aria-label="Enable Copilot"]')).click();
    await browser.execute(() =>
      Array.from(document.querySelectorAll("[role=button]"))
        .find((e) => e.querySelector(":scope > span")?.textContent.trim() === "Copilot options")
        ?.click(),
    );
    const notLoaded = await $(`${PAGE} [data-plugin-not-loaded]`);
    await notLoaded.waitForExist({ timeout: 20_000 });
    ok((await notLoaded.getText()).includes("Plugin not loaded"));
    strictEqual(
      await browser.execute((sel) => document.querySelector(`${sel} .vertical-tab-content`), PAGE),
      null,
    );
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
