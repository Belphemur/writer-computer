// End-to-end: popups of UNMODIFIED obsidian-copilot 4.0.20 must stay inside the window. The chat
// input sits at the bottom of the right pane, so its typeahead (@ mentions, [[ notes, / commands)
// and its Radix dropdowns open upward. Run with
//   SPEC=copilot-popups.spec.js sh fixtures/copilot-fake-claude/run.sh
// Screenshots go to WRITER_E2E_SHOTS (default e2e/.cache/shots).
import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.WRITER_E2E_COPILOT_VAULT;
const SHOTS = process.env.WRITER_E2E_SHOTS || join(HERE, "../.cache/shots");
const PANE = "[data-plugin-view-pane]";
const INPUT = `${PANE} [contenteditable="true"][role="textbox"]`;

const shot = async (name) => {
  try {
    mkdirSync(SHOTS, { recursive: true });
    await browser.saveScreenshot(join(SHOTS, `popups-${name}.png`));
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

/** Floating elements the page currently shows outside #root (body children and the host layer's). */
function floatingRects() {
  return browser.execute(() => {
    const out = [];
    const consider = (el, where) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden") return;
      if (cs.position !== "fixed" && cs.position !== "absolute") return;
      if (el.matches("script, style, #root, #writer-popup-layer, .modal-container")) return;
      out.push({
        where,
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 80),
        role: el.getAttribute("role"),
        translate: el.style.translate || "",
        style: el.getAttribute("style"),
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        vw: window.innerWidth,
        vh: window.innerHeight,
      });
    };
    for (const el of document.body.children) {
      consider(el, "body");
      if (el.id === "writer-popup-layer") for (const c of el.children) consider(c, "layer");
    }
    return out;
  });
}

/** The guard works on a timer: poll until every floating element is inside, then return the last read. */
async function settledRects() {
  let rects = await floatingRects();
  const deadline = Date.now() + 3_000;
  while (rects.some((r) => !inside(r)) && Date.now() < deadline) {
    await browser.pause(100);
    rects = await floatingRects();
  }
  return rects;
}

const inside = (r) => r.top >= 0 && r.left >= 0 && r.bottom <= r.vh && r.right <= r.vw;

async function type(text) {
  await $(INPUT).click();
  await browser.execute((t) => document.execCommand("insertText", false, t), text);
  await browser.pause(700);
}

async function clearInput() {
  await browser.keys("Escape");
  await browser.execute(() => {
    document.execCommand("selectAll");
    document.execCommand("delete");
  });
  await browser.pause(300);
}

describe("Copilot popups stay inside the window", function () {
  this.timeout(180_000);

  before(async function () {
    if (!VAULT) {
      console.log("SKIP: run via fixtures/copilot-fake-claude/run.sh");
      this.skip();
    }
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
    await browser.execute(() => {
      window.__popupErrors = [];
      window.addEventListener("error", (e) => window.__popupErrors.push(String(e.message)));
    });
    await runCommand("copilot:agent-chat-open-window");
    await $(PANE).waitForExist({ timeout: 15_000 });
    await browser.waitUntil(async () => (await $(PANE).getText()).includes("Chat input"), {
      timeout: 30_000,
    });
  });

  for (const [w, h] of [
    [1280, 800],
    [900, 520],
  ]) {
    for (const trigger of ["@", "[[", "/"]) {
      it(`${trigger} typeahead at the bottom of the pane, window ${w}x${h}`, async function () {
        await browser.setWindowSize(w, h);
        await browser.pause(600);
        await type(trigger);
        const rects = await settledRects();
        console.log(`POPUPS ${trigger} ${w}x${h}:`, JSON.stringify(rects));
        await shot(
          `${trigger.replace(/\W/g, "x") || "slash"}-${trigger === "/" ? "slash" : "t"}-${w}x${h}`,
        );
        await clearInput();
        ok(rects.length > 0 || trigger === "/", `no popup appeared for ${trigger}`);
        for (const r of rects) ok(inside(r), `popup outside the window: ${JSON.stringify(r)}`);
      });
    }

    it(`pane dropdowns (menus/listboxes) stay inside the window, ${w}x${h}`, async function () {
      await browser.setWindowSize(w, h);
      await browser.pause(600);
      const triggers = await browser.execute((sel) => {
        const pane = document.querySelector(sel);
        const els = Array.from(pane.querySelectorAll("button[aria-haspopup], [role=combobox]"));
        els.forEach((e, i) => e.setAttribute("data-e2e-trigger", String(i)));
        return els.map((e, i) => ({
          i,
          label: e.getAttribute("aria-label") || e.textContent.trim(),
        }));
      }, PANE);
      console.log(`DROPDOWN TRIGGERS ${w}x${h}:`, JSON.stringify(triggers));
      for (const t of triggers.slice(0, 6)) {
        await $(`[data-e2e-trigger="${t.i}"]`).click();
        await browser.pause(500);
        const rects = await settledRects();
        console.log(`DROPDOWN ${t.label} ${w}x${h}:`, JSON.stringify(rects));
        await shot(`dropdown-${t.i}-${w}x${h}`);
        for (const r of rects)
          ok(inside(r), `${t.label}: popup outside the window: ${JSON.stringify(r)}`);
        await browser.keys("Escape");
        await browser.pause(200);
      }
    });
  }

  it("no plugin errors were recorded", async function () {
    const errs = await browser.execute(() => window.__writerPluginErrors || []);
    deepStrictEqual(errs, [], JSON.stringify(errs));
    const pageErrors = await browser.execute(() => window.__popupErrors || []);
    console.log("PAGE ERRORS:", JSON.stringify(pageErrors));
  });
});
