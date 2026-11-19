//! The `drawing` file kind (ADR 2026-11-18 "let features contribute file kinds and text
//! extractors to search"): `.excalidraw.md` and plain `.excalidraw` drawings are found by the text
//! of their elements, read through the codec of `excalidraw_md.rs`.

use super::excalidraw_md::{self, Format};
use crate::code_files as cf;
use crate::index::kinds::{Extract, ExtractError, Extracted, FileKind, Gate, TextSource};
use std::path::Path;

/// Drawings above this are named only (the same read guard as code files).
fn max_bytes() -> u64 {
    cf::max_read_bytes()
}

/// The text of every live text element, one element per line. A drawing that does not parse is
/// named only.
fn extract(path: &Path, bytes: &[u8]) -> Result<Extracted, ExtractError> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let format = excalidraw_md::format_of(name).ok_or(ExtractError::Malformed)?;
    debug_assert!(matches!(format, Format::Md | Format::Plain));
    let text = String::from_utf8_lossy(bytes);
    let parsed = excalidraw_md::parse(&text, format).map_err(|_| ExtractError::Malformed)?;
    let lines: Vec<&str> = excalidraw_md::elements(&parsed.scene)
        .iter()
        .filter(|el| el["type"] == "text" && !excalidraw_md::is_deleted(el))
        .filter_map(|el| el["text"].as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect();
    Ok(Extracted {
        title: None,
        body: lines.join("\n"),
    })
}

/// The kinds of this feature, for `Feature::file_kinds`.
pub static KINDS: [FileKind; 1] = [FileKind {
    id: "drawing",
    label: "Drawings",
    icon: "DrawingModeIcon",
    matches: &[".excalidraw.md", ".excalidraw"],
    names: None,
    listed_by: Gate::Feature("excalidraw"),
    content_by: Gate::Feature("excalidraw"),
    text: TextSource::Stored,
    extract: Some(Extract {
        run: extract,
        max_bytes,
    }),
}];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plain(elements: serde_json::Value) -> Vec<u8> {
        json!({"type":"excalidraw","version":2,"elements":elements,"appState":{},"files":{}})
            .to_string()
            .into_bytes()
    }

    #[test]
    fn a_plain_drawing_gives_the_text_of_its_live_text_elements() {
        let bytes = plain(json!([
            {"id":"a","type":"text","text":"Harbour plan"},
            {"id":"b","type":"rectangle"},
            {"id":"c","type":"text","text":"gone","isDeleted":true},
            {"id":"d","type":"text","text":"  second label  "},
        ]));
        let out = extract(Path::new("Arch.excalidraw"), &bytes).unwrap();
        assert_eq!(out.body, "Harbour plan\nsecond label");
    }

    #[test]
    fn a_drawing_that_does_not_parse_is_named_only() {
        assert_eq!(
            extract(Path::new("x.excalidraw"), b"{ not json"),
            Err(ExtractError::Malformed)
        );
        assert_eq!(
            extract(Path::new("x.excalidraw.md"), b"just a note"),
            Err(ExtractError::Malformed)
        );
    }
}
