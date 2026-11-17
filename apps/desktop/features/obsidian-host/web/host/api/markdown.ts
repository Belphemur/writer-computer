// Adapted from opensidian (GPL-3.0-or-later).
// MarkdownRenderer / MarkdownRenderChild. Rendering itself is delegated to the host
// (`setMarkdownRenderer` in functions.ts; the real one is api/markdown-render.ts, installed by
// the PluginHost); the default is an escaped-paragraph placeholder.
import { Component } from "./core";
import { renderMarkdownInto } from "./functions";
import type { App } from "./app";

export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) {
    super();
  }
}

export const MarkdownRenderer = {
  /** Renders `markdown` into `el`. `component` owns any listeners the renderer attaches. */
  async render(
    app: App,
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    component: Component,
  ): Promise<void> {
    await renderMarkdownInto(markdown, el, { app, sourcePath, component });
  },
  async renderMarkdown(
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    component: Component,
  ): Promise<void> {
    await renderMarkdownInto(markdown, el, { sourcePath, component });
  },
};
