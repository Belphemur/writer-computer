# Third-party notices

Components bundled in Writer that ask for a notice. Each keeps its own license; the full text ships with the package.

## pdf.js

- Package: `pdfjs-dist` 6.5.438 (pinned exactly in `pnpm-workspace.yaml`), loaded lazily by the `pdf` feature (`apps/desktop/features/pdf/`) and run in a same-origin worker from the app bundle.
- Project: <https://mozilla.github.io/pdf.js/>, source <https://github.com/mozilla/pdf.js>.
- License: Apache License, Version 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>), copyright the pdf.js authors and Mozilla Foundation.
- Use: renders PDF pages and their text layer for the PDF reader and embeds. Writer never writes a PDF.

## pdf_oxide

- Crate: `pdf_oxide` 0.3.78 (pinned exactly in `apps/desktop/src-tauri/Cargo.toml`, default features off: no ICC, legacy crypto, OCR, rendering or ML), compiled into the app and the `writer` CLI.
- Project: <https://crates.io/crates/pdf_oxide>.
- License: MIT OR Apache-2.0 (the crate's `LICENSE-MIT` and `LICENSE-APACHE`), copyright the pdf_oxide authors.
- Use: reads the text of a PDF so vault search finds a PDF by its content (the `pdf` file kind, `apps/desktop/features/pdf/rust/`). The text stays in the local vault index; Writer never writes a PDF.

## Dataview

The inline-field scanner (`apps/desktop/src-tauri/src/index/inline_fields.rs`) and the Dataview query grammar and function semantics implemented in `apps/desktop/src-tauri/src/dql/` and `bases/dialect.rs` are adapted from Dataview by Michael Brenan (blacksmithgu), https://github.com/blacksmithgu/obsidian-dataview.

MIT License

Copyright (c) 2021 Michael Brenan

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Tasks

The task grammar (emoji and Dataview signifiers, the end-anchored order-independent pass order), the status model, the recurrence phrases, the urgency weights and the toggle semantics implemented in `apps/desktop/src-tauri/src/tasks/` follow the Obsidian Tasks plugin by Clare Macrae, Ilyas Landikov and Martin Schenck, https://github.com/obsidian-tasks-group/obsidian-tasks. The ` ```tasks ` query grammar converted by `tasks/block.rs` is read from its public documentation.

MIT License

Copyright (c) 2021 Clare Macrae, Ilyas Landikov and Martin Schenck

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Spelling and grammar

- Harper (`harper-core`), Apache-2.0, Automattic. English grammar and spelling.
- spellbook, MPL-2.0, the Helix project. Reads Hunspell dictionaries.
- lingua (`lingua-rs`), Apache-2.0. Language detection (English and French models).
- Hunspell dictionaries from `wooorm/dictionaries` are not bundled. A dictionary the user chooses to install keeps its own licence, recorded in `<app data>/spellcheck/dictionaries/<id>/meta.json` and shown in Settings > Spelling before the download.

## Markdown lint

- Crate: `rumdl` 0.3.5 (pinned exactly in `apps/desktop/src-tauri/Cargo.toml`, default features off: no language server, no file watching), compiled into the app and the `writer` CLI; only `apps/desktop/src-tauri/src/lint/` names it.
- Project: <https://github.com/rvben/rumdl>.
- License: MIT, copyright the rumdl authors.
- Use: the Markdown rules and their fixes behind the built-in `lint` feature. It runs on text Writer hands it and never reads or writes files itself.
