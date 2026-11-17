// A plugin-registered CodeMirror extension (valid, throwing, or invalid) must never remove
// Prosemark's live-preview decorations. Run via fixtures/editor-plugin-isolation/run.sh, which
// builds a synthetic vault with the fixture plugins named in WRITER_E2E_ISO_PLUGINS.
import { ok } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PLUGINS = process.env.WRITER_E2E_ISO_PLUGINS;
const SHOTS = process.env.WRITER_E2E_SHOTS;

describe(`live preview with plugins: ${PLUGINS}`, function () {
  this.timeout(90_000);
  before(function () {
    if (!PLUGINS) this.skip();
  });

  it("renders Prosemark decorations in a note", async function () {
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 30_000 });
    // give the plugin host time to load + apply extensions
    await browser.pause(4000);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await browser.saveScreenshot(join(SHOTS, "pre-open.png"));
    }
    if (process.env.LOAD) {
      await browser.execute((busy) => {
        setInterval(() => {
          const t = performance.now();
          while (performance.now() - t < busy);
        }, 100);
      }, Number(process.env.LOAD));
    }
    if (process.env.STUCK_DRAG) {
      // pointerdown whose pointerup never arrives (lost to a popup / native drag / outside window)
      await browser.execute(() => {
        document.body.dispatchEvent(new Event("noop"));
      });
    }
    const row = await $("span=Synthetic");
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await $(".cm-content").waitForExist({ timeout: 15_000 });
    await browser.pause(2500);
    const probe = await browser.execute(() => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end } });
      return null;
    });
    void probe;
    await browser.pause(800);
    const dom = await browser.execute(() => ({
      headingLines: document.querySelectorAll(".cm-heading-line").length,
      hidden: document.querySelectorAll(".cm-hidden-token").length,
      removed: document.querySelectorAll(".cm-emphasis").length,
      callout: document.querySelectorAll("[class*=callout]").length,
      lines: document.querySelectorAll(".cm-line").length,
      goodWalks: window.__fxGoodWalks || 0,
      errors: (window.__writerPluginErrors || []).map((e) =>
        String(e.message || e.error || e).slice(0, 120),
      ),
    }));
    console.log("DOM " + JSON.stringify(dom));
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await browser.saveScreenshot(join(SHOTS, `${PLUGINS.replace(/,/g, "+")}.png`));
    }
    ok(dom.headingLines > 0, "no .cm-heading-line: heading decorations missing");
    ok(dom.hidden > 0, "no .cm-hidden-token: hide decorations missing");
    ok(dom.removed > 0, "no .cm-emphasis: emphasis decorations missing");
  });
});
