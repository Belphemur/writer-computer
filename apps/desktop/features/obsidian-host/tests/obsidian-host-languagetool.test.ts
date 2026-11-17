// @vitest-environment jsdom
// The REAL installed LanguageTool plugin (read-only, never copied or modified) through PluginHost,
// a real CodeMirror editor and a faked LanguageTool server: after a check, putting the caret in the
// error opens the plugin's suggestion card as a CodeMirror tooltip. Regression for "the suggestion
// popup is white text on CodeMirror's light tooltip surface": the host's sheet must restyle exactly
// that element, and with a selector CodeMirror's injected `.cm-tooltip` rule cannot outrank.
// Skipped when the plugin is not installed at the usual place on this machine.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installDomHelpers } from "../web/host/api/dom";
import { setNetIpc } from "../web/host/api/network";
import { OBSIDIAN_THEME_CSS } from "../web/host/api/theme-compat";
import { detachedBridge } from "../web/host/api/views";
import {
  getPluginCompartmentValue,
  pluginExtensionCompartment,
  setPluginEditorExtensions,
} from "../web/host/editor-bridge";
import { PluginHost, type ScriptLoader } from "../web/host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../web/host/testing";

const ID = "obsidian-languagetool-plugin";
const DIR = join(homedir(), "Documents/Vault/PersonalVault/.obsidian/plugins", ID);

describe("plugin tooltips take Writer's surface", () => {
  // CodeMirror's baseTheme rule is `.ͼ2 .cm-tooltip` (two classes) and is injected unlayered.
  const rule = /(\.cm-tooltip[^{]*)\{([^}]*)\}/.exec(
    OBSIDIAN_THEME_CSS.slice(OBSIDIAN_THEME_CSS.indexOf(".cm-tooltip.cm-tooltip")),
  );

  it("styles background, text and border from Writer tokens", () => {
    expect(rule).not.toBeNull();
    const body = rule![2]!;
    expect(body).toContain("background-color: var(--background-secondary)");
    expect(body).toContain("color: var(--text-normal)");
    expect(body).toContain("border-color: var(--background-modifier-border)");
  });

  it("outranks CodeMirror's two-class tooltip rule, leaves Writer's autocomplete alone", () => {
    const selector = rule![1]!.trim();
    // :not(.x) counts as .x in specificity
    const classes = [...selector.matchAll(/\.[\w-]+/g)].length;
    expect(classes).toBeGreaterThanOrEqual(3);
    const own = document.createElement("div");
    own.className = "cm-tooltip cm-tooltip-autocomplete";
    const plugin = document.createElement("div");
    plugin.className = "lt-predictions-container-glass cm-tooltip";
    expect(own.matches(selector)).toBe(false);
    expect(plugin.matches(selector)).toBe(true);
  });
});

describe.skipIf(!existsSync(join(DIR, "main.js")))("real LanguageTool plugin", () => {
  it("opens its suggestion card for the error under the caret, and the sheet restyles it", async () => {
    installDomHelpers(window);
    const source = readFileSync(join(DIR, "main.js"), "utf8");
    const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
    const loadScript: ScriptLoader = async (url) => {
      const pid = decodeURIComponent(url.split("/")[3]);
      // oxlint-disable-next-line typescript/no-implied-eval -- evaluates the wrapper like a script tag
      new Function(
        `__writerPluginDefine(${JSON.stringify(pid)}, function (module, exports, require, process, global, Buffer) {\n${source}\n});`,
      )();
    };
    const body = JSON.stringify({
      software: {},
      language: { code: "en-US", detectedLanguage: { code: "en-US" } },
      matches: [
        {
          message: "Possible spelling mistake found",
          shortMessage: "Spelling mistake",
          offset: 0,
          length: 4,
          replacements: [{ value: "hello" }],
          context: { text: "helo world", offset: 0, length: 4 },
          rule: { id: "MORFOLOGIK_RULE_EN_US", category: { id: "TYPOS", name: "Typo" } },
          sentence: "helo world",
        },
      ],
    });
    setNetIpc({
      request: async (r: { url: string }) => ({
        status: 200,
        headers: [["content-type", "application/json"]],
        url: r.url,
        body_base64: btoa(body),
      }),
      streamStart: async () => 0,
      streamCancel: async () => true,
    } as never);
    const ipc = new FakeHostIpc({
      enabled: [ID],
      plugins: [{ ...manifest, id: ID }],
      data: {
        [ID]: JSON.stringify({
          serverUrl: "http://lt.test",
          urlMode: "custom",
          glassBg: true,
          shouldAutoCheck: false,
          apiKeyStorage: "none",
          staticLanguage: "auto",
          englishVeriety: "en-US",
          motherTongue: "fr-BE",
        }),
      },
    });
    const host = new PluginHost({
      ipc,
      io: createMemoryVaultIo({ "a.md": "helo world\n" }),
      bridge: detachedBridge,
      loadScript,
      styles: { add: () => () => {} },
    } as never);
    await host.boot();
    const regs = host.services.registrations.list().filter((r) => r.kind === "editorExtension");
    expect(
      setPluginEditorExtensions(
        regs.map((r) => r.value as never),
        regs.map((r) => r.owner),
      ),
    ).toBeNull();
    const view = new EditorView({
      state: EditorState.create({
        doc: "helo world\n",
        extensions: [markdown(), pluginExtensionCompartment.of(getPluginCompartmentValue())],
      }),
      parent: document.body,
    });
    const plugin = host.getPlugin(ID) as unknown as {
      statusBarText: HTMLElement;
      runDetection(view: EditorView, md: unknown): Promise<void>;
    };
    plugin.statusBarText = document.body.appendChild(document.createElement("div"));
    await plugin.runDetection(view, { file: null, data: "helo world\n" });
    expect(document.querySelectorAll(".lt-underline")).toHaveLength(1);
    view.dispatch({ selection: { anchor: 2 } });
    const tip = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>(".lt-predictions-container-glass");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(tip.classList.contains("cm-tooltip")).toBe(true);
    expect(tip.querySelector(".lt-info-button svg")).not.toBeNull(); // "info" icon
    expect(tip.querySelector(".lt-ignore-btn")?.textContent).toContain(
      "Add to personal dictionary",
    );
    // The element the plugin builds is the one the host sheet restyles.
    const rule = /(\.cm-tooltip\.cm-tooltip[^{]*)\{/.exec(OBSIDIAN_THEME_CSS)![1]!.trim();
    expect(tip.matches(rule)).toBe(true);
    view.destroy();
    await host.shutdown();
  }, 30_000);
});
