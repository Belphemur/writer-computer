//! The `pdf` file kind and its text extractor (`pdf_oxide` 0.3.78, no default features: no ICC, no
//! legacy crypto, no OCR, no rendering). Plain text in reading order, one page per chunk, each
//! starting with a page-break line (`index::kinds::PAGE_BREAK`), so a hit knows its page.
//!
//! Caps (ADR 2026-11-18): files above [`MAX_BYTES`] are named only, at most [`MAX_PAGES`] pages
//! are read (the rest of the file stays unsearched), and the text is cut at the body cap by the
//! index. An encrypted or malformed PDF is named only. A page that fails to extract is skipped,
//! not the document.

use crate::attachments;
use crate::code_files as cf;
use crate::index::kinds::{
    Extract, ExtractError, Extracted, FileKind, Gate, NameRule, TextSource, PAGE_BREAK,
};
use pdf_oxide::document::PdfDocument;
use pdf_oxide::object::Object;
use std::path::Path;

/// Files above this many bytes are named only.
pub const MAX_BYTES: u64 = 100 * 1024 * 1024;
/// Pages read from one document.
pub const MAX_PAGES: usize = 2_000;
/// The extracted text stops once it has this many bytes (the index cuts at its own cap; reading
/// more pages than can be kept is wasted work).
const STOP_AT_BYTES: usize = crate::index::FTS_MAX_BODY_BYTES;

/// The PDFs the listing setting and the reader know: `documentExtensions` of
/// `shared/attachments.json`, the one list.
struct DocumentRule;
static DOCUMENT_RULE: DocumentRule = DocumentRule;

impl NameRule for DocumentRule {
    fn matches(&self, policy: &cf::Policy, name: &str) -> bool {
        cf::is_document_name_with(policy, name)
    }
    fn exts(&self, _policy: &cf::Policy) -> Vec<String> {
        attachments::document_extensions().to_vec()
    }
    fn names(&self, _policy: &cf::Policy) -> Vec<String> {
        Vec::new()
    }
}

/// The document info title, when the file has one.
fn info_title(doc: &PdfDocument) -> Option<String> {
    let trailer = doc.trailer().as_dict()?;
    let info = match trailer.get("Info")? {
        Object::Reference(r) => doc.load_object(*r).ok()?,
        other => other.clone(),
    };
    let raw = info.as_dict()?.get("Title")?.as_string()?;
    let title = decode_text_string(raw);
    let title = title.trim();
    (!title.is_empty()).then(|| title.chars().take(200).collect())
}

/// A PDF text string: UTF-16 with a byte-order mark, UTF-8 with its mark, or PDFDocEncoding
/// (read as Latin-1, which agrees with it on the characters titles use).
fn decode_text_string(raw: &[u8]) -> String {
    if let Some(rest) = raw.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .chunks(2)
            .filter(|c| c.len() == 2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Some(rest) = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    raw.iter().map(|&b| b as char).collect()
}

fn extract(_path: &Path, bytes: &[u8]) -> Result<Extracted, ExtractError> {
    let doc = PdfDocument::from_bytes(bytes.to_vec()).map_err(|_| ExtractError::Malformed)?;
    if doc.is_encrypted() {
        return Err(ExtractError::Encrypted);
    }
    let pages = doc.page_count().map_err(|_| ExtractError::Malformed)?;
    let mut body = String::new();
    for page in 0..pages.min(MAX_PAGES) {
        if page > 0 {
            body.push('\n');
        }
        body.push_str(PAGE_BREAK);
        body.push('\n');
        if let Ok(text) = doc.extract_text(page) {
            body.push_str(text.trim_end());
        }
        if body.len() >= STOP_AT_BYTES {
            break;
        }
    }
    Ok(Extracted {
        title: info_title(&doc),
        body,
        links: Vec::new(),
    })
}

/// The kinds of this feature, for `Feature::file_kinds`.
pub static KINDS: [FileKind; 1] = [FileKind {
    id: "pdf",
    label: "PDFs",
    icon: "Pdf02Icon",
    matches: &[],
    names: Some(&DOCUMENT_RULE),
    listed_by: Gate::Setting(cf::SETTING_PDFS),
    // listing is core's (`files.show-pdfs`); reading the text is the feature's: off, a PDF stays
    // listed by name and its text is dropped at the next sync
    content_by: Gate::Feature("pdf"),
    // the extracted text is the only text there is: the index keeps it for the lines under a hit
    text: TextSource::Stored,
    extract: Some(Extract {
        run: extract,
        max_bytes: || MAX_BYTES,
    }),
}];

/// A one-text-object-per-page PDF, built in memory for tests (nothing is fetched or checked in).
#[cfg(test)]
pub(crate) fn fixture_pdf(pages: &[&str], title: Option<&str>) -> Vec<u8> {
    let mut objects: Vec<String> = Vec::new();
    let n = pages.len();
    // 1 catalog, 2 pages, 3 font, then per page a page object and a content stream
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 4 + i * 2)).collect();
    objects.push(format!(
        "<< /Type /Pages /Kids [{}] /Count {n} >>",
        kids.join(" ")
    ));
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into());
    for (i, text) in pages.iter().enumerate() {
        let content = format!("BT /F1 18 Tf 72 720 Td ({text}) Tj ET");
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {} 0 R \
             /Resources << /Font << /F1 3 0 R >> >> >>",
            5 + i * 2
        ));
        objects.push(format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        ));
    }
    let mut trailer_extra = String::new();
    if let Some(t) = title {
        objects.push(format!("<< /Title ({t}) >>"));
        trailer_extra = format!(" /Info {} 0 R", objects.len());
    }
    pdf_from_objects(&objects, &trailer_extra)
}

#[cfg(test)]
pub(crate) fn pdf_from_objects(objects: &[String], trailer_extra: &str) -> Vec<u8> {
    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{o}\nendobj\n", i + 1));
    }
    let xref = out.len();
    out.push_str(&format!(
        "xref\n0 {}\n0000000000 65535 f \n",
        objects.len() + 1
    ));
    for off in offsets {
        out.push_str(&format!("{off:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R{trailer_extra} >>\nstartxref\n{xref}\n%%EOF\n",
        objects.len() + 1
    ));
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(bytes: &[u8]) -> Result<Extracted, ExtractError> {
        extract(Path::new("a.pdf"), bytes)
    }

    #[test]
    fn a_text_pdf_gives_its_words_and_its_title() {
        let out = run(&fixture_pdf(&["Harbour budget zebra"], Some("Annual plan"))).unwrap();
        assert!(out.body.contains("zebra"), "{:?}", out.body);
        assert_eq!(out.title.as_deref(), Some("Annual plan"));
    }

    #[test]
    fn pages_are_separated_by_a_page_break_line() {
        let out = run(&fixture_pdf(
            &["first page", "second page", "third page"],
            None,
        ))
        .unwrap();
        // a leading break, then one before each following page
        let pages: Vec<&str> = out.body.split(PAGE_BREAK).skip(1).collect();
        assert_eq!(pages.len(), 3, "{:?}", out.body);
        assert!(
            pages[0].contains("first") && pages[1].contains("second") && pages[2].contains("third")
        );
        assert!(out.title.is_none());
    }

    #[test]
    fn an_encrypted_or_malformed_pdf_is_named_only() {
        let objects: Vec<String> = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".into(),
            "<< /Type /Pages /Kids [] /Count 0 >>".into(),
            "<< /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >>".into(),
        ];
        let encrypted = pdf_from_objects(&objects, " /Encrypt 3 0 R");
        assert!(matches!(
            run(&encrypted),
            Err(ExtractError::Encrypted | ExtractError::Malformed)
        ));
        assert_eq!(run(b"not a pdf at all"), Err(ExtractError::Malformed));
        assert_eq!(run(b""), Err(ExtractError::Malformed));
        let mut cut = fixture_pdf(&["hello"], None);
        cut.truncate(cut.len() / 2);
        // a truncated file is either rebuilt or refused, never a panic
        let _ = run(&cut);
    }

    #[test]
    fn the_page_cap_stops_a_long_document() {
        assert_eq!(MAX_PAGES, 2_000);
        let texts: Vec<String> = (0..5).map(|i| format!("page{i}")).collect();
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        assert_eq!(
            run(&fixture_pdf(&refs, None))
                .unwrap()
                .body
                .matches("page")
                .count(),
            5
        );
    }

    #[test]
    fn text_strings_decode_utf16_and_latin1() {
        assert_eq!(
            decode_text_string(&[0xFE, 0xFF, 0x00, 0x41, 0x00, 0xE9]),
            "Aé"
        );
        assert_eq!(decode_text_string(b"Plain"), "Plain");
        assert_eq!(decode_text_string(&[0x43, 0xE9]), "Cé");
    }
}
