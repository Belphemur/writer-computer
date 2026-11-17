// @vitest-environment jsdom
// Processors in the HTML renderer (only for vault note content), the in-thread worker shim and
// the Obsidian DOM/prototype helpers Dataview needs. Synthetic only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../web/host/node/external-links", () => ({ openExternalUrl: () => true }));

import { createApp, type App } from "../web/host/api/app";
import { Component, createHostServices } from "../web/host/api/core";
import { installDomHelpers } from "../web/host/api/dom";
import { MarkdownRenderer } from "../web/host/api/markdown";
import { setMarkdownRenderer } from "../web/host/api/functions";
import { createMarkdownRenderer } from "../web/host/api/markdown-render";
import { detachedBridge } from "../web/host/api/views";
import { installInThreadWorkers } from "../web/host/api/worker-shim";
import {
  resetMarkdownProcessorCaches,
  setMarkdownProcessorHost,
} from "../web/host/markdown-processors";
import { createMemoryVaultIo } from "../web/host/testing";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("renderer runs processors only on note content", () => {
  let app: App;
  let calls: string[];
  const unloaded: string[] = [];
  const NOTE = "# Heading\n\n```fx\nsource text\n```\n\nAnd `=inline`.\n";
  beforeEach(async () => {
    calls = [];
    const services = createHostServices({ read: async () => null, write: async () => {} });
    app = createApp({
      io: createMemoryVaultIo({ "a.md": NOTE, "b.md": "Embeds: ![[a]]" }),
      services,
      bridge: detachedBridge,
    });
    await app.vault.load();
    const handler = (source: string, el: HTMLElement, ctx: any) => {
      calls.push(`block:${source.trim()}@${ctx.sourcePath}`);
      el.textContent = "RENDERED";
      ctx.addChild(Object.assign(new Component(), { onunload: () => unloaded.push("block") }));
    };
    const post = (el: HTMLElement) => {
      for (const c of Array.from(el.querySelectorAll("code")))
        if (c.textContent?.startsWith("="))
          c.replaceWith(Object.assign(document.createElement("b"), { textContent: "INLINE" }));
    };
    services.registrations.add("fx:codeBlockProcessor:fx", {
      owner: "fx",
      kind: "codeBlockProcessor",
      key: "fx",
      value: { fn: handler },
    });
    services.registrations.add("fx:postProcessor:1", {
      owner: "fx",
      kind: "postProcessor",
      key: "1",
      value: { fn: post },
    });
    setMarkdownProcessorHost({
      services,
      app,
      toVaultPath: (p) => p,
      getFrontmatter: () => undefined,
    });
    setMarkdownRenderer(createMarkdownRenderer({ app, resourceUrl: () => "x" }));
  });
  afterEach(() => {
    setMarkdownProcessorHost(null);
    resetMarkdownProcessorCaches();
  });

  const render = async (md: string, source: string, c = new Component()) => {
    const el = document.createElement("div");
    document.body.append(el);
    await MarkdownRenderer.render(app, md, el, source, c);
    return { el, c };
  };

  it("renders a note preview through both kinds of processor and unloads with the component", async () => {
    const c = new Component();
    c.load();
    const { el } = await render(NOTE, "a.md", c);
    expect(el.textContent).toContain("RENDERED");
    expect(el.textContent).toContain("INLINE");
    expect(calls).toEqual(["block:source text@a.md"]);
    expect(unloaded).toEqual([]);
    c.unload(); // the block's context (and the child the processor attached) goes with it
    expect(unloaded).toEqual(["block"]);
  });

  it("does not run them on generated markdown (chat output) even with a note path", async () => {
    const { el } = await render("```fx\nmalicious\n```\n\n`=x`", "a.md");
    expect(el.querySelector("pre code")).not.toBeNull();
    expect(el.textContent).not.toContain("RENDERED");
    expect(calls).toEqual([]);
  });

  it("runs them on an embedded vault note, with the embedded note's path", async () => {
    const { el } = await render("Embeds: ![[a]]", "b.md");
    await wait(10);
    expect(el.textContent).toContain("RENDERED");
    expect(calls).toEqual(["block:source text@a.md"]);
  });
});

describe("in-thread worker shim", () => {
  let uninstall: () => void;
  beforeEach(() => {
    let n = 0;
    (URL as any).createObjectURL = () => `blob:test/${++n}`;
    (URL as any).revokeObjectURL = () => {};
    uninstall = installInThreadWorkers();
  });
  afterEach(() => uninstall());

  it("runs a blob worker script on the main thread with copy semantics", async () => {
    const script = `
      onmessage = async (evt) => {
        evt.data.touched = true;           // must not leak into the sender's object
        postMessage({ echo: evt.data.value * 2, m: new Map([["k", 1]]) });
      };`;
    const url = URL.createObjectURL(new Blob([script], { type: "application/javascript" }));
    const w = new Worker(url, { name: "t" });
    const input = { value: 21 };
    const got = await new Promise<any>((resolve) => {
      w.onmessage = (e: MessageEvent) => resolve(e.data);
      w.postMessage(input);
    });
    expect(got.echo).toBe(42);
    expect(got.m).toBeInstanceOf(Map);
    expect("touched" in input).toBe(false);
    w.terminate();
  });

  it("restores the globals on uninstall", () => {
    const patched = URL.createObjectURL;
    uninstall();
    expect(URL.createObjectURL).not.toBe(patched);
    uninstall = installInThreadWorkers();
  });
});

describe("Obsidian DOM helpers", () => {
  let off: () => void;
  beforeEach(() => void (off = installDomHelpers()));
  afterEach(() => off());

  it("adds String#contains, Array#first/last, findAllSelf and onNodeInserted", async () => {
    expect(("abc" as any).contains("b")).toBe(true);
    expect(([1, 2, 3] as any).first()).toBe(1);
    expect(([1, 2, 3] as any).last()).toBe(3);
    const root = document.createElement("div");
    root.className = "r";
    root.innerHTML = '<p class="r">x</p>';
    expect((root as any).findAllSelf(".r")).toHaveLength(2);

    const el = document.createElement("span");
    let fired = 0;
    const remove = (el as any).onNodeInserted(() => fired++);
    document.body.append(el);
    await wait(10);
    expect(fired).toBe(1);
    el.remove();
    await wait(10);
    document.body.append(el);
    await wait(10);
    expect(fired).toBe(2);
    remove();
    el.remove();
    document.body.append(el);
    await wait(10);
    expect(fired).toBe(2);
  });
});
