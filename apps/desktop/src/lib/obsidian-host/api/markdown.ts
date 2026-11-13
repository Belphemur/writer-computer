// Adapted from opensidian (GPL-3.0-or-later).
// MarkdownRenderer / MarkdownRenderChild. Rendering itself is delegated to the host
// (`setMarkdownRenderer` in functions.ts); the default is an escaped-paragraph placeholder.
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
    _app: App,
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: Component,
  ): Promise<void> {
    renderMarkdownInto(markdown, el);
  },
  async renderMarkdown(
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: Component,
  ): Promise<void> {
    renderMarkdownInto(markdown, el);
  },
};
