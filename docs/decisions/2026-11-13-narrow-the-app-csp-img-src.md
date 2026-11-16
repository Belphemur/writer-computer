---
status: proposed
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Narrow the app CSP `img-src` that currently allows any https host

> Backfilled on 2026-11-16 from `SPECs/obsidian-plugins-spec.md` ("Marketplace UI polish": "narrowing is an open app-wide decision"). Date = `32b37aa`, which documented the open question. Nothing is decided.

## Context and Problem Statement

`app.security.csp` in `apps/desktop/src-tauri/tauri.conf.json` has `img-src 'self' data: asset: https://asset.localhost https: writer-plugin: http://writer-plugin.localhost`. `https:` lets any https host serve images. `data:` was added on 2026-05-03 (`ba4cc7f`) so the inline SVG task checkmark works in production builds. Notes and plugin READMEs can embed remote images, so a README can trigger arbitrary https image requests (a tracking-pixel risk).

## Considered Options

- Keep `https:`: remote images in notes keep working; leaks requests to any host.
- Allowlist hosts: breaks remote images in users' notes.
- Proxy remote images through Rust with an allowlist or a per-image consent: strongest, largest change.
- Narrow only plugin-rendered content (READMEs already restrict images to http(s) in `render-readme.ts`): does not change the app-wide directive.

## Decision Outcome

Not decided. It is an app-wide trade-off between remote images in notes and request leakage.

### Consequences

- Until decided, remote images load from any https host in notes and READMEs.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src/components/plugin-browser/render-readme.ts`, `apps/desktop/src/lib/safe-html.ts`.

### Verification

- [ ] A note with a remote image still renders, or the loss is documented in the user docs.
- [ ] A README image from a non-allowed host is not requested.

## More Information

- Related: [`2026-11-13-render-plugin-markdown-with-marked-and-dompurify.md`](2026-11-13-render-plugin-markdown-with-marked-and-dompurify.md), [`2026-11-13-serve-plugin-code-over-the-writer-plugin-scheme.md`](2026-11-13-serve-plugin-code-over-the-writer-plugin-scheme.md).
