//! The `code` file kind (ADR 2026-11-18 "let features contribute file kinds and text extractors
//! to search"): which names are code (the extension setting and `Dockerfile`-like names, through
//! `code_files`), and the extractor that makes a code file searchable by its text.

use crate::code_files as cf;
use crate::index::kinds::{Extract, ExtractError, Extracted, FileKind, Gate, NameRule, TextSource};
use std::path::Path;

struct CodeRule;
static CODE_RULE: CodeRule = CodeRule;

impl NameRule for CodeRule {
    fn matches(&self, policy: &cf::Policy, name: &str) -> bool {
        cf::is_code_name_with(policy, name)
    }
    fn exts(&self, policy: &cf::Policy) -> Vec<String> {
        if policy.code {
            policy.extensions.iter().cloned().collect()
        } else {
            Vec::new()
        }
    }
    fn names(&self, policy: &cf::Policy) -> Vec<String> {
        cf::code_file_names(policy)
    }
}

/// The file text. A binary file or one that is not UTF-8 is named only (the code-files guards);
/// the size guard is the kind's `max_bytes`.
fn extract(_path: &Path, bytes: &[u8]) -> Result<Extracted, ExtractError> {
    if cf::looks_binary(bytes) {
        return Err(ExtractError::NotText);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| ExtractError::NotText)?;
    Ok(Extracted {
        title: None,
        body: text.strip_prefix('\u{feff}').unwrap_or(text).to_string(),
        links: Vec::new(),
    })
}

/// The kinds of this feature, for `Feature::file_kinds`.
pub static KINDS: [FileKind; 1] = [FileKind {
    id: "code",
    label: "Code",
    icon: "CodeIcon",
    matches: &[],
    names: Some(&CODE_RULE),
    listed_by: Gate::Code,
    content_by: Gate::Code,
    // the lines under a hit are the file's own, so the index keeps no second copy
    text: TextSource::Disk,
    extract: Some(Extract {
        run: extract,
        max_bytes: cf::max_read_bytes,
    }),
}];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_extracted_and_binary_or_invalid_utf8_is_not() {
        let p = Path::new("a.py");
        assert_eq!(extract(p, b"print('hi')\n").unwrap().body, "print('hi')\n");
        assert_eq!(extract(p, b"\xef\xbb\xbfx = 1").unwrap().body, "x = 1");
        assert_eq!(extract(p, b"abc\0def"), Err(ExtractError::NotText));
        assert_eq!(extract(p, &[0x66, 0xff, 0xfe]), Err(ExtractError::NotText));
    }
}
