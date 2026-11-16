---
status: accepted
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Render plugin markdown with `marked` and one shared DOMPurify core

> Backfilled on 2026-11-16. Date = `32b37aa` "Marketplace: loading state, visible selection, rendered README", the first commit that added `marked` (plugin READMEs). The same renderer family was extended to plugin chat messages in `6673b3d` (2026-11-14). Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md), "Marketplace UI polish" and "Chat messages showed raw markdown".

## Context and Problem Statement

Two places show markdown that Writer did not write: plugin READMEs in the marketplace, and `MarkdownRenderer.render` results for plugins (Copilot's chat shows `[[Note]]` links, `![[image]]` and `![[note]]` embeds, code fences, lists, callouts, tags, highlights, task lists). The first host version was an escaped-paragraph placeholder, so replies appeared as raw text. Both inputs are untrusted HTML-producing text.

## Decision

Render with `marked`, then sanitise with DOMPurify, through one shared core `apps/desktop/src/lib/safe-html.ts`.

- READMEs: `render-readme.ts` uses a strict allowlist (no style, class, id or `on*`; URLs http, https, mailto, tel; images http(s) only; links open in the browser).
- Plugin markdown: `api/markdown-render.ts` adds Obsidian syntax on top of `marked` (wiki links and embeds, callouts, tags, highlight, comments, math spans, task lists). Internal links open in a new main tab, external links go through `openExternalUrl`, `![[x.base]]` becomes an "Open base" link. It is installed by the plugin host through `setMarkdownRenderer`.
- Not supported yet: footnotes, syntax highlighting, block-reference (`#^id`) embeds.

## Consequences

- Good, because plugin and marketplace output cannot inject script or styles into Writer's page.
- Good, because one sanitiser core means one place to audit.
- Bad, because rendering differs slightly from Obsidian's (missing features above) and has not been verified with the real Copilot in the GUI.
- Neutral, because the editor's own markdown is rendered by CodeMirror decorations, not by this path.

## Implementation Plan

- **Affected paths**: `apps/desktop/src/lib/safe-html.ts`, `apps/desktop/src/lib/obsidian-host/api/markdown-render.ts`, `apps/desktop/src/components/plugin-browser/render-readme.ts`, `readme-view.tsx`.
- **Dependencies**: `marked`, `dompurify` (`apps/desktop/package.json`).
- **Patterns to avoid**: assigning unsanitised HTML to `innerHTML`; a second sanitiser configuration.

### Verification

- [ ] `vp test` passes `tests/obsidian-host-markdown-render.test.ts` and `tests/plugin-browser-render-readme.test.ts`.
- [ ] Manual with real Copilot: `a.internal-link` and `pre > code` render in a chat reply (open item in `TODOS.md`).
