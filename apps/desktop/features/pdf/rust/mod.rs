//! The Rust half of the built-in feature `pdf` (spec `SPECs/pdf-spec.md`, ADR 2026-11-18 "let
//! features contribute file kinds and text extractors to search"). The reader is TypeScript
//! (pdf.js, `../web/`); this half adds the `pdf` file kind to listing and search: PDFs are found
//! by name and by their text, which `extract.rs` reads with `pdf_oxide`. It has no Tauri command,
//! event or hook, so no plugin and no capability file: a registry entry that contributes data.
//!
//! The kind is listed by the core setting `files.show-pdfs` (listing PDFs is core, the pdf spec),
//! and its file extensions are `documentExtensions` of `shared/attachments.json`, the one list.

mod extract;

/// A small PDF built in memory, for the index tests (nothing is fetched or checked in).
#[cfg(test)]
pub(crate) use extract::fixture_pdf;

use crate::features::Feature;
use crate::index::kinds::FileKind;
use tauri::Runtime;

pub struct Pdf;

impl<R: Runtime> Feature<R> for Pdf {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn file_kinds(&self) -> &'static [FileKind] {
        &extract::KINDS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::MockRuntime;

    #[test]
    fn the_manifest_names_exactly_the_kinds_the_feature_contributes() {
        let m = Feature::<MockRuntime>::manifest(&Pdf).unwrap();
        let ids: Vec<&str> = Feature::<MockRuntime>::file_kinds(&Pdf)
            .iter()
            .map(|k| k.id)
            .collect();
        assert_eq!(ids, ["pdf"]);
        assert_eq!(m.rust.file_kinds, ids);
    }
}
