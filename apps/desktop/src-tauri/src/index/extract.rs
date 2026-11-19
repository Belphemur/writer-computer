//! Running a kind's text extractor for the index (ADR 2026-11-18 "let features contribute file
//! kinds and text extractors to search").
//!
//! The extractors themselves belong to the kinds (`index::kinds::Extract`): the code-files
//! feature reads text, the pdf feature reads PDFs, the excalidraw feature reads drawings. This
//! module is the one place that runs them, behind the one containment point: a panic or an error
//! leaves the file listed by name with no content, is logged as a kind and an error class (never
//! the path or the text), and never reaches the index writer. An extractor is core-side code run
//! per file, not a feature boundary, so it does not mark the feature `failed` for the session: a
//! single malformed PDF must not switch the PDF reader off.

use super::fts::FTS_MAX_BODY_BYTES;
use super::kinds::{Extract, ExtractError, Extracted, FileKind};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

/// Run the kind's extractor over bytes already read, contained. `Err` means "named only".
///
/// Secret-looking names are never read for content, whatever the kind (a note keeps its existing
/// behaviour: it has no extractor and is parsed by the note parser).
pub(crate) fn run_bytes(
    kind: &FileKind,
    extract: &Extract,
    abs: &Path,
    name: &str,
    bytes: &[u8],
) -> Result<Extracted, ExtractError> {
    let result = if crate::code_files::is_secret_name(name) {
        Err(ExtractError::SecretName)
    } else {
        catch_unwind(AssertUnwindSafe(|| (extract.run)(abs, bytes)))
            .unwrap_or(Err(ExtractError::Panicked))
    };
    log_named_only(kind, &result);
    result
}

/// Read the file (unless it is above the kind's size cap or a secret name) and run the
/// extractor, contained. The bytes come back for the content hash.
pub(crate) fn run(
    kind: &FileKind,
    extract: &Extract,
    abs: &Path,
    name: &str,
    size: u64,
) -> Result<(Extracted, Vec<u8>), ExtractError> {
    let early = if crate::code_files::is_secret_name(name) {
        Some(ExtractError::SecretName)
    } else if size > (extract.max_bytes)() {
        Some(ExtractError::TooLarge)
    } else {
        None
    };
    if let Some(e) = early {
        log_named_only::<()>(kind, &Err(e));
        return Err(e);
    }
    // an unreadable file is a file the extractor cannot read: named only
    let Ok(bytes) = std::fs::read(abs) else {
        log_named_only::<()>(kind, &Err(ExtractError::Malformed));
        return Err(ExtractError::Malformed);
    };
    run_bytes(kind, extract, abs, name, &bytes).map(|out| (out, bytes))
}

/// Log a file left without content: only the kind and the class, never the path or the text.
fn log_named_only<T>(kind: &FileKind, result: &Result<T, ExtractError>) {
    match result {
        Err(ExtractError::Panicked) => log::warn!("search: a {} extractor panicked", kind.id),
        Err(e) => log::debug!("search: a {} file is named only ({})", kind.id, e.class()),
        Ok(_) => {}
    }
}

/// Cut `text` to the body cap at a char boundary (extracted text is truncated, not dropped like
/// an over-long note body).
pub(crate) fn cap_body(mut text: String) -> String {
    if text.len() > FTS_MAX_BODY_BYTES {
        let mut cut = FTS_MAX_BODY_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::kinds::{Gate, TextSource};
    use tempfile::TempDir;

    fn boom(_: &Path, _: &[u8]) -> Result<Extracted, ExtractError> {
        panic!("extractor bug")
    }
    fn ok(_: &Path, b: &[u8]) -> Result<Extracted, ExtractError> {
        Ok(Extracted {
            title: None,
            body: String::from_utf8_lossy(b).into_owned(),
            links: Vec::new(),
        })
    }
    fn kind() -> FileKind {
        FileKind {
            id: "probe",
            label: "Probe",
            icon: "File02Icon",
            matches: &[".probe"],
            names: None,
            listed_by: Gate::Always,
            content_by: Gate::Always,
            text: TextSource::Stored,
            extract: None,
        }
    }

    #[test]
    fn a_panicking_extractor_is_contained_and_the_next_file_still_runs() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("a.probe");
        std::fs::write(&file, "hello").unwrap();
        let k = kind();
        let bad = Extract {
            run: boom,
            max_bytes: || 1 << 20,
        };
        assert_eq!(
            run(&k, &bad, &file, "a.probe", 5).unwrap_err(),
            ExtractError::Panicked
        );
        let good = Extract {
            run: ok,
            max_bytes: || 1 << 20,
        };
        let (out, bytes) = run(&k, &good, &file, "a.probe", 5).unwrap();
        assert_eq!((out.body.as_str(), bytes.len()), ("hello", 5));
    }

    #[test]
    fn secret_names_and_oversized_files_are_never_read() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("secrets.probe");
        std::fs::write(&file, "token").unwrap();
        let k = kind();
        let good = Extract {
            run: ok,
            max_bytes: || 10,
        };
        assert_eq!(
            run(&k, &good, &file, "secrets.probe", 5).unwrap_err(),
            ExtractError::SecretName
        );
        assert_eq!(
            run(&k, &good, &file, "big.probe", 11).unwrap_err(),
            ExtractError::TooLarge
        );
        assert_eq!(
            run(&k, &good, &dir.path().join("gone.probe"), "gone.probe", 1).unwrap_err(),
            ExtractError::Malformed
        );
    }

    #[test]
    fn the_body_is_cut_at_the_cap_on_a_char_boundary() {
        let text = "é".repeat(FTS_MAX_BODY_BYTES);
        let cut = cap_body(text);
        assert!(cut.len() <= FTS_MAX_BODY_BYTES && cut.len() > FTS_MAX_BODY_BYTES - 4);
        assert_eq!(cap_body("short".into()), "short");
    }
}
