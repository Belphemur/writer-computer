//! Tauri-free write path for images dropped or pasted into a note (spec:
//! `SPECs/image-insertion-spec.md`): where the file goes (the
//! `files.attachment-folder` setting, an Obsidian vault's own attachment
//! setting as a read-only fallback), what it is called, and the checks (type,
//! size, confinement). Rules shared with the frontend live in
//! `shared/attachments.json` (twin `src/lib/attachments.ts`).
//!
//! Nothing here writes into `.obsidian` (`vault_ops::confine` refuses it); the
//! app.json is only read.

use crate::vault_ops::{self, VaultOpError};
use serde::Deserialize;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shared {
    max_bytes: u64,
    import_extensions: Vec<String>,
    render_extensions: Vec<String>,
    document_extensions: Vec<String>,
    document_max_bytes: u64,
    mime_extensions: std::collections::HashMap<String, String>,
    default_folder: String,
    max_file_bytes: u64,
    max_tree_bytes: u64,
    max_tree_files: usize,
}

static SHARED: LazyLock<Shared> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../shared/attachments.json"))
        .expect("shared/attachments.json is valid")
});

/// The cap on any file dropped from the OS (images keep [`max_bytes`]).
pub fn max_file_bytes() -> u64 {
    SHARED.max_file_bytes
}

/// The caps on a whole folder dropped on the sidebar: total bytes and file count.
pub fn max_tree() -> (u64, usize) {
    (SHARED.max_tree_bytes, SHARED.max_tree_files)
}

#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(String),
}

impl From<VaultOpError> for AttachmentError {
    fn from(e: VaultOpError) -> Self {
        AttachmentError::Invalid(e.to_string())
    }
}

impl From<io::Error> for AttachmentError {
    fn from(e: io::Error) -> Self {
        AttachmentError::Io(e.to_string())
    }
}

/// Where the bytes come from. A dropped Finder file is copied by path (never
/// through IPC); pasted and browser-dropped images arrive as bytes.
pub enum Source<'a> {
    Bytes(&'a [u8]),
    File(&'a Path),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    pub abs_path: PathBuf,
    /// Path relative to the root the file was confined to (the vault).
    pub rel_path: String,
    pub file_name: String,
}

/// The setting that picks the attachment folder (`shared/settings.schema.json`).
pub const SETTING_KEY: &str = "files.attachment-folder";

pub fn max_bytes() -> u64 {
    SHARED.max_bytes
}

/// Characters a link target or a file system cannot carry: `/ \ : * ? " < > |`
/// and the wikilink-breaking `# ^ [ ]`.
const FORBIDDEN: &[char] = &[
    '/', '\\', ':', '*', '?', '"', '<', '>', '|', '#', '^', '[', ']',
];

/// A safe single file name: forbidden characters become `-`, control characters
/// vanish, leading dots (hidden files) and surrounding space are trimmed.
pub fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if FORBIDDEN.contains(&c) { '-' } else { c })
        .collect();
    cleaned.trim().trim_start_matches('.').trim().to_string()
}

/// The lowercase extension of `name` when it is an importable image type.
pub fn image_extension(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    SHARED.import_extensions.contains(&ext).then_some(ext)
}

/// The extensions the webview can show as an image (`renderExtensions`): what the sidebar lists
/// as images (`code_files`, setting `files.show-images`) and the viewer opens.
pub fn render_extensions() -> &'static [String] {
    &SHARED.render_extensions
}

/// Is `name` one of the image types of [`render_extensions`] (case-blind)?
pub fn is_render_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| render_extensions().contains(&e.to_ascii_lowercase()))
}

/// The document types (`documentExtensions`, `pdf`): listed by `files.show-pdfs`, opened by the
/// PDF reader, attached in the agent composer.
pub fn document_extensions() -> &'static [String] {
    &SHARED.document_extensions
}

/// The largest document the reader opens (`documentMaxBytes`): a PDF is read whole into the webview.
pub fn document_max_bytes() -> u64 {
    SHARED.document_max_bytes
}

/// Is `name` one of the document types of [`document_extensions`] (case-blind)?
pub fn is_document_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| document_extensions().contains(&e.to_ascii_lowercase()))
}

/// `name`, `name 1`, `name 2`, ... : the `n`th candidate for a file name.
fn numbered(stem: &str, ext: &str, n: u32) -> String {
    let dot_ext = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    if n == 0 {
        format!("{stem}{dot_ext}")
    } else {
        format!("{stem} {n}{dot_ext}")
    }
}

/// What `files.attachment-folder` means once the Obsidian fallback is applied:
/// the Writer setting when set, else the vault's `attachmentFolderPath`, else
/// the default folder.
pub fn effective_setting(writer: &str, obsidian: Option<&str>) -> String {
    let writer = writer.trim();
    if !writer.is_empty() {
        return writer.to_string();
    }
    match obsidian.map(str::trim) {
        Some(o) if !o.is_empty() => o.to_string(),
        _ => SHARED.default_folder.clone(),
    }
}

/// The vault's Obsidian attachment setting, read-only. Missing file, bad JSON
/// or a missing key mean "no opinion".
pub fn read_obsidian_setting(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join(".obsidian").join("app.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("attachmentFolderPath")?
        .as_str()
        .map(str::to_owned)
}

fn trim_slashes(s: &str) -> &str {
    s.trim_matches('/')
}

/// The vault-relative folder (`""` is the vault root) for a note, from an
/// effective setting: `"./"` next to the note, `"./sub"` a subfolder of the
/// note's folder, `"/"` the vault root, anything else a folder from the root.
/// `note_dir_rel` is the note's folder relative to the vault.
pub fn resolve_folder(setting: &str, note_dir_rel: &str) -> String {
    let setting = setting.trim();
    let join = |base: &str, rest: &str| match (base.is_empty(), rest.is_empty()) {
        (true, _) => rest.to_string(),
        (false, true) => base.to_string(),
        (false, false) => format!("{base}/{rest}"),
    };
    if setting == "." || setting == "./" {
        return note_dir_rel.to_string();
    }
    if let Some(rest) = setting.strip_prefix("./") {
        return join(note_dir_rel, trim_slashes(rest));
    }
    trim_slashes(setting).to_string()
}

/// The note's folder relative to the canonical vault `root`.
pub fn note_dir_rel(root: &Path, note: &Path) -> Result<String, AttachmentError> {
    let dir = note
        .parent()
        .ok_or_else(|| AttachmentError::Invalid("the note has no folder".into()))?;
    let rel = dir
        .strip_prefix(root)
        .map_err(|_| AttachmentError::Invalid("the note is outside the vault".into()))?;
    let parts: Option<Vec<&str>> = rel.components().map(|c| c.as_os_str().to_str()).collect();
    Ok(parts
        .ok_or_else(|| AttachmentError::Invalid("the note path is not valid UTF-8".into()))?
        .join("/"))
}

fn check_size(len: u64) -> Result<(), AttachmentError> {
    if len > SHARED.max_bytes {
        return Err(AttachmentError::TooLarge(format!(
            "Image not saved: {:.1} MB is over the {} MB limit",
            len as f64 / (1024.0 * 1024.0),
            SHARED.max_bytes / (1024 * 1024)
        )));
    }
    Ok(())
}

/// Save one image into `folder` (vault-relative, `""` for the root) under
/// `root` (canonical), named after `name` (sanitised, `" 1"`, `" 2"` appended
/// on a collision). The type and size checks, confinement, directory creation
/// and the no-clobber create are all here: the one write path.
pub fn save(
    root: &Path,
    folder: &str,
    name: &str,
    source: Source<'_>,
) -> Result<Saved, AttachmentError> {
    save_typed(root, folder, name, source, false)
}

/// [`save`] for a file an agent chat takes: any type (the chat's drop accepts every file; what
/// the model reads as a block is decided elsewhere, `agent/files.rs`). The same write path, so
/// confinement, naming and no-clobber are shared; a note's attachment commands keep calling
/// [`save`] and stay image-only.
pub fn save_chat_file(
    root: &Path,
    folder: &str,
    name: &str,
    source: Source<'_>,
) -> Result<Saved, AttachmentError> {
    save_typed(root, folder, name, source, true)
}

fn save_typed(
    root: &Path,
    folder: &str,
    name: &str,
    source: Source<'_>,
    any_type: bool,
) -> Result<Saved, AttachmentError> {
    let clean = sanitize_name(name);
    if clean.is_empty() {
        return Err(AttachmentError::Invalid("the file has no name".into()));
    }
    if !any_type && image_extension(&clean).is_none() {
        return Err(AttachmentError::Unsupported(format!(
            "Not saved: \"{clean}\" is not a supported image type"
        )));
    }
    // The name keeps its own extension case ("Photo.JPG"); only the type check is case-blind.
    let ext = Path::new(&clean)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_string();
    let stem = Path::new(&clean)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "image".to_string());

    match &source {
        Source::Bytes(bytes) => check_size(bytes.len() as u64)?,
        Source::File(path) => {
            let meta = fs::metadata(path)?;
            if !meta.is_file() {
                return Err(AttachmentError::Invalid(
                    "the dropped item is not a file".into(),
                ));
            }
            check_size(meta.len())?;
        }
    }

    // Confine the folder before touching the disk (rejects `..`, escapes and `.obsidian`).
    let probe = if folder.is_empty() {
        clean.clone()
    } else {
        format!("{folder}/{clean}")
    };
    let confined = vault_ops::confine(root, &probe)?;
    let dir = confined
        .abs
        .parent()
        .ok_or_else(|| AttachmentError::Invalid("invalid attachment folder".into()))?
        .to_path_buf();
    fs::create_dir_all(&dir)?;
    // Re-check after creation: a pre-existing link in the folder chain resolves now.
    let dir = dir.canonicalize()?;
    if !dir.starts_with(root) {
        return Err(AttachmentError::Invalid(
            "the attachment folder is outside the vault".into(),
        ));
    }

    for n in 0..10_000u32 {
        let file_name = numbered(&stem, &ext, n);
        let target = dir.join(&file_name);
        let created = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target);
        let mut out = match created {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        };
        let written = match &source {
            Source::Bytes(bytes) => out.write_all(bytes),
            Source::File(path) => {
                fs::File::open(path).and_then(|mut f| io::copy(&mut f, &mut out).map(|_| ()))
            }
        };
        if let Err(e) = written.and_then(|_| out.flush()) {
            drop(out);
            let _ = fs::remove_file(&target);
            return Err(e.into());
        }
        let rel = target
            .strip_prefix(root)
            .ok()
            .and_then(|p| p.to_str())
            .map(|s| s.replace('\\', "/"))
            .unwrap_or(file_name.clone());
        return Ok(Saved {
            abs_path: target,
            rel_path: rel,
            file_name,
        });
    }
    Err(AttachmentError::Io(
        "too many files with that name in the attachment folder".into(),
    ))
}

// ---- Downloading an image from a URL ---------------------------------------------------------

/// A downloaded image, ready for [`save`]: `name` already carries the detected extension.
#[derive(Debug)]
pub struct Downloaded {
    pub name: String,
    pub bytes: Vec<u8>,
}

const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const MAX_REDIRECTS: usize = 5;

/// The image extension a Content-Type header names (parameters ignored), if it is an allowed type.
fn extension_for_content_type(content_type: &str) -> Option<String> {
    let mime = content_type.split(';').next()?.trim().to_ascii_lowercase();
    SHARED.mime_extensions.get(&mime).cloned()
}

/// The image extension the leading bytes say, for responses whose Content-Type is missing or
/// generic (`application/octet-stream`).
pub fn sniff_extension(bytes: &[u8]) -> Option<&'static str> {
    let starts = |magic: &[u8]| bytes.starts_with(magic);
    if starts(&[0x89, b'P', b'N', b'G']) {
        return Some("png");
    }
    if starts(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    if starts(b"GIF8") {
        return Some("gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    if bytes.len() >= 10 && starts(b"BM") && bytes[6..10] == [0, 0, 0, 0] {
        return Some("bmp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return match &bytes[8..12] {
            b"avif" | b"avis" => Some("avif"),
            b"heic" | b"heix" | b"heim" | b"heis" | b"mif1" => Some("heic"),
            _ => None,
        };
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]);
    let head = head.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg")) {
        return Some("svg");
    }
    None
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A file name offered by `Content-Disposition` (`filename*=UTF-8''x.png` or `filename="x.png"`).
fn disposition_name(header: &str) -> Option<String> {
    for part in header.split(';').map(str::trim) {
        let lower = part.to_ascii_lowercase();
        if lower.starts_with("filename*=") {
            let value = &part["filename*=".len()..];
            let encoded = value.rsplit('\'').next().unwrap_or(value);
            return Some(percent_decode(encoded));
        }
    }
    header.split(';').map(str::trim).find_map(|part| {
        let lower = part.to_ascii_lowercase();
        lower
            .starts_with("filename=")
            .then(|| part["filename=".len()..].trim_matches('"').to_string())
    })
}

/// The name an image is saved under: the stem of the name the server or the URL offers (with the
/// detected extension), else `fallback_stem`. Always sanitised.
fn download_name(
    url: &url::Url,
    disposition: Option<&str>,
    ext: &str,
    fallback_stem: &str,
) -> String {
    let offered = disposition.and_then(disposition_name).or_else(|| {
        url.path_segments()
            .and_then(|mut s| s.next_back())
            .map(percent_decode)
    });
    let stem = offered
        .map(|n| sanitize_name(&n))
        .map(|n| match n.rsplit_once('.') {
            Some((stem, e)) if e.len() <= 5 && !stem.is_empty() => stem.to_string(),
            _ => n,
        })
        .map(|stem| stem.trim().to_string())
        .filter(|stem| !stem.is_empty() && !is_generic_stem(stem));
    format!("{}.{ext}", stem.as_deref().unwrap_or(fallback_stem))
}

/// Names a browser or CDN gives every image (`image`, `download`, `file`): not worth keeping.
fn is_generic_stem(stem: &str) -> bool {
    matches!(
        stem.to_ascii_lowercase().as_str(),
        "image" | "download" | "file" | "photo" | "index" | "blob"
    )
}

fn http_client(use_system_proxy: bool) -> Result<reqwest::Client, AttachmentError> {
    // reqwest is built with `rustls-no-provider`; make sure one is installed.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        // Every hop passes the same gate as the first URL (http(s) only, no metadata hosts).
        if attempt.previous().len() >= MAX_REDIRECTS
            || crate::plugin_http::check_url(attempt.url().as_str()).is_err()
        {
            attempt.stop()
        } else {
            attempt.follow()
        }
    });
    let mut builder = reqwest::Client::builder()
        .redirect(policy)
        .timeout(DOWNLOAD_TIMEOUT)
        .dns_resolver(crate::plugin_http::GuardedResolver)
        .user_agent(concat!("writer/", env!("CARGO_PKG_VERSION")));
    if !use_system_proxy {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|e| AttachmentError::Io(format!("could not start the download ({e})")))
}

/// Download an image from an `http(s)` URL (a browser drag or paste that carried only a link).
/// The size cap is enforced while streaming; the type comes from Content-Type or, failing that,
/// the leading bytes. Logs the host only, never the URL.
pub async fn download_image(url: &str, fallback_stem: &str) -> Result<Downloaded, AttachmentError> {
    download_image_with(url, fallback_stem, true).await
}

async fn download_image_with(
    raw_url: &str,
    fallback_stem: &str,
    use_system_proxy: bool,
) -> Result<Downloaded, AttachmentError> {
    let url = crate::plugin_http::check_url(raw_url).map_err(|e| {
        let reason = e.trim_start_matches("refused: ");
        AttachmentError::Unsupported(format!(
            "Image not downloaded: only http and https links are supported ({reason})"
        ))
    })?;
    let host = url.host_str().unwrap_or("?").to_string();
    let fail = |what: String| {
        log::debug!("image download failed for host {host}");
        AttachmentError::Io(format!("Image not downloaded: {what}"))
    };
    let client = http_client(use_system_proxy)?;
    let mut response = client.get(url.clone()).send().await.map_err(|e| {
        fail(if e.is_timeout() {
            "the server took too long".into()
        } else {
            "the server could not be reached".into()
        })
    })?;
    if !response.status().is_success() {
        return Err(fail(format!(
            "the server answered {}",
            response.status().as_u16()
        )));
    }
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let content_type_ext = header("content-type")
        .as_deref()
        .and_then(extension_for_content_type);
    let disposition = header("content-disposition");
    let too_large = || {
        AttachmentError::TooLarge(format!(
            "Image not downloaded: it is over the {} MB limit",
            SHARED.max_bytes / (1024 * 1024)
        ))
    };
    if response
        .content_length()
        .is_some_and(|n| n > SHARED.max_bytes)
    {
        return Err(too_large());
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| fail("the download was interrupted".into()))?
    {
        if bytes.len() as u64 + chunk.len() as u64 > SHARED.max_bytes {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    let ext = content_type_ext
        .or_else(|| sniff_extension(&bytes).map(str::to_string))
        .ok_or_else(|| {
            AttachmentError::Unsupported(
                "Image not downloaded: the link does not point to a supported image".into(),
            )
        })?;
    Ok(Downloaded {
        name: download_name(&url, disposition.as_deref(), &ext, fallback_stem),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn vault() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        (dir, root)
    }

    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47];

    #[test]
    fn sanitizes_forbidden_characters_and_hidden_names() {
        assert_eq!(
            sanitize_name("a/b\\c:d*e?f\"g<h>i|j.png"),
            "a-b-c-d-e-f-g-h-i-j.png"
        );
        assert_eq!(sanitize_name("shot #1 [x]^.png"), "shot -1 -x--.png");
        assert_eq!(sanitize_name("  ..hidden.png "), "hidden.png");
        assert_eq!(sanitize_name("tab\tname.png"), "tabname.png");
        assert_eq!(
            sanitize_name("Pasted image 20260101120000.png"),
            "Pasted image 20260101120000.png"
        );
    }

    #[test]
    fn image_types_are_checked_case_insensitively() {
        for ok in [
            "a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.svg", "a.avif", "a.bmp", "a.heic",
            "a.ico", "a.apng", "a.tif", "a.tiff", "a.heif", "a.jxl",
        ] {
            assert!(image_extension(ok).is_some(), "{ok}");
        }
        for bad in ["a.pdf", "a.txt", "a", "a.png.exe", ".png"] {
            assert!(image_extension(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn render_names_follow_the_one_list() {
        for ext in render_extensions() {
            assert!(is_render_name(&format!("a.{ext}")), "{ext}");
            assert!(
                is_render_name(&format!("A.{}", ext.to_uppercase())),
                "{ext}"
            );
        }
        for bad in ["a.pdf", "a.sh", "a.app", "png", "a.png.exe"] {
            assert!(!is_render_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_note_saves_images_only_and_a_chat_file_may_be_any_type() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let note = save(&root, "attachments", "a.pdf", Source::Bytes(b"%PDF-1.7")).unwrap_err();
        assert!(
            note.to_string().contains("not a supported image type"),
            "{note}"
        );
        assert!(!root.join("attachments/a.pdf").exists());
        let chat = save_chat_file(&root, "chat", "a.pdf", Source::Bytes(b"%PDF-1.7")).unwrap();
        assert_eq!(chat.rel_path, "chat/a.pdf");
        // the same write path: no clobber, images still fine, any other type too
        let again = save_chat_file(&root, "chat", "a.pdf", Source::Bytes(b"%PDF-1.7")).unwrap();
        assert_eq!(again.rel_path, "chat/a 1.pdf");
        assert!(save_chat_file(&root, "chat", "p.png", Source::Bytes(b"x")).is_ok());
        let other = save_chat_file(&root, "chat", "a.docx", Source::Bytes(b"x")).unwrap();
        assert_eq!(other.rel_path, "chat/a.docx");
        // a name without an extension keeps none, also when numbered
        let one = save_chat_file(&root, "chat", "Makefile", Source::Bytes(b"x")).unwrap();
        let two = save_chat_file(&root, "chat", "Makefile", Source::Bytes(b"x")).unwrap();
        assert_eq!(
            (one.rel_path.as_str(), two.rel_path.as_str()),
            ("chat/Makefile", "chat/Makefile 1")
        );
    }

    #[test]
    fn document_names_follow_the_one_list() {
        assert_eq!(document_extensions(), ["pdf".to_string()]);
        for ok in ["a.pdf", "A.PDF", "dir.v2/a.Pdf"] {
            assert!(is_document_name(ok), "{ok}");
        }
        for bad in ["a.png", "pdf", "a.pdf.exe", "a.docx"] {
            assert!(!is_document_name(bad), "{bad}");
        }
        // images and documents are different lists
        assert!(!is_render_name("a.pdf"));
    }

    #[test]
    fn folder_setting_forms() {
        // From the vault root.
        assert_eq!(resolve_folder("attachments", "notes/deep"), "attachments");
        assert_eq!(resolve_folder("/assets/img/", "notes"), "assets/img");
        assert_eq!(resolve_folder("/", "notes"), "");
        // Next to the note.
        assert_eq!(resolve_folder("./", "notes/deep"), "notes/deep");
        assert_eq!(resolve_folder(".", "notes"), "notes");
        assert_eq!(resolve_folder("./", ""), "");
        // Subfolder of the note's folder.
        assert_eq!(
            resolve_folder("./attachments", "notes/deep"),
            "notes/deep/attachments"
        );
        assert_eq!(resolve_folder("./attachments/", ""), "attachments");
    }

    #[test]
    fn the_setting_exists_with_an_empty_default_and_the_shared_default_folder_is_next_to_the_note()
    {
        let defaults = crate::config::default_settings();
        let value = defaults.get(SETTING_KEY).expect("setting is in the schema");
        assert_eq!(value.as_str(), Some(""));
        assert_eq!(effective_setting("", None), "./attachments");
    }

    #[test]
    fn effective_setting_prefers_writer_then_obsidian_then_default() {
        assert_eq!(effective_setting("pics", Some("obs")), "pics");
        assert_eq!(effective_setting("  ", Some("obs")), "obs");
        assert_eq!(effective_setting("", Some("")), "./attachments");
        assert_eq!(effective_setting("", None), "./attachments");
    }

    #[test]
    fn reads_the_obsidian_setting_without_touching_it() {
        let (_d, root) = vault();
        assert_eq!(read_obsidian_setting(&root), None);
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        let app = root.join(".obsidian/app.json");
        fs::write(&app, r#"{"attachmentFolderPath":"./media"}"#).unwrap();
        assert_eq!(read_obsidian_setting(&root).as_deref(), Some("./media"));
        fs::write(&app, "{not json").unwrap();
        assert_eq!(read_obsidian_setting(&root), None);
        fs::write(&app, r#"{"other":1}"#).unwrap();
        assert_eq!(read_obsidian_setting(&root), None);
        // A save never creates or changes anything inside .obsidian.
        fs::write(&app, r#"{"attachmentFolderPath":"/"}"#).unwrap();
        let before = fs::read(&app).unwrap();
        save(&root, "", "a.png", Source::Bytes(PNG)).unwrap();
        assert_eq!(fs::read(&app).unwrap(), before);
        assert_eq!(fs::read_dir(root.join(".obsidian")).unwrap().count(), 1);
    }

    #[test]
    fn note_folder_is_relative_to_the_vault() {
        let (_d, root) = vault();
        assert_eq!(note_dir_rel(&root, &root.join("n.md")).unwrap(), "");
        assert_eq!(note_dir_rel(&root, &root.join("a/b/n.md")).unwrap(), "a/b");
        assert!(note_dir_rel(&root, Path::new("/elsewhere/n.md")).is_err());
    }

    #[test]
    fn saves_bytes_creating_the_folder() {
        let (_d, root) = vault();
        let saved = save(&root, "attachments", "shot.png", Source::Bytes(PNG)).unwrap();
        assert_eq!(saved.rel_path, "attachments/shot.png");
        assert_eq!(saved.file_name, "shot.png");
        assert_eq!(fs::read(&saved.abs_path).unwrap(), PNG);
    }

    #[test]
    fn collisions_get_numeric_suffixes() {
        let (_d, root) = vault();
        let names: Vec<String> = (0..3)
            .map(|_| {
                save(&root, "", "pic.png", Source::Bytes(PNG))
                    .unwrap()
                    .file_name
            })
            .collect();
        assert_eq!(names, ["pic.png", "pic 1.png", "pic 2.png"]);
        // Case-insensitive file systems collide on case too; either way no overwrite.
        let again = save(&root, "", "PIC.PNG", Source::Bytes(&[1])).unwrap();
        assert_eq!(fs::read(root.join("pic.png")).unwrap(), PNG);
        assert!(again.file_name.starts_with("PIC"));
    }

    #[test]
    fn copies_a_file_by_path_keeping_the_name() {
        let (_d, root) = vault();
        let (_s, src_root) = vault();
        let src = src_root.join("Holiday photo.JPG");
        fs::write(&src, [1, 2, 3, 4, 5]).unwrap();
        let saved = save(&root, "img", "Holiday photo.JPG", Source::File(&src)).unwrap();
        assert_eq!(saved.rel_path, "img/Holiday photo.JPG");
        assert_eq!(fs::read(&saved.abs_path).unwrap(), [1, 2, 3, 4, 5]);
        assert!(src.exists(), "the source is copied, never moved");
    }

    #[test]
    fn rejects_a_directory_as_a_file_source() {
        let (_d, root) = vault();
        let (_s, src_root) = vault();
        let dir = src_root.join("x.png");
        fs::create_dir(&dir).unwrap();
        assert!(matches!(
            save(&root, "", "x.png", Source::File(&dir)),
            Err(AttachmentError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_unsupported_types_without_writing() {
        let (_d, root) = vault();
        for name in ["doc.pdf", "noext", "script.sh"] {
            let err = save(&root, "attachments", name, Source::Bytes(PNG)).unwrap_err();
            assert!(matches!(err, AttachmentError::Unsupported(_)), "{name}");
        }
        assert!(!root.join("attachments").exists());
    }

    #[test]
    fn rejects_files_over_the_size_cap() {
        let (_d, root) = vault();
        let (_s, src_root) = vault();
        let big = src_root.join("big.png");
        let f = fs::File::create(&big).unwrap();
        f.set_len(max_bytes() + 1).unwrap();
        let err = save(&root, "", "big.png", Source::File(&big)).unwrap_err();
        match err {
            AttachmentError::TooLarge(msg) => assert!(msg.contains("50 MB"), "{msg}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn confines_folders_to_the_vault() {
        let (_d, root) = vault();
        for folder in ["..", "../out", "a/../../out", "/etc"] {
            let result = save(&root, folder, "x.png", Source::Bytes(PNG));
            assert!(result.is_err(), "{folder}");
        }
        assert!(save(&root, ".obsidian", "x.png", Source::Bytes(PNG)).is_err());
        assert!(save(&root, ".obsidian/attachments", "x.png", Source::Bytes(PNG)).is_err());
        assert!(!root.join(".obsidian").exists());
        assert!(!root.parent().unwrap().join("out").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_folder_that_links_out_of_the_vault() {
        let (_d, root) = vault();
        let (_o, outside) = vault();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(save(&root, "link", "x.png", Source::Bytes(PNG)).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn sanitizes_the_saved_name() {
        let (_d, root) = vault();
        let saved = save(&root, "", "a/b#c.png", Source::Bytes(PNG)).unwrap();
        assert_eq!(saved.file_name, "a-b-c.png");
    }

    // ---- download_image against a mock HTTP server ----

    use std::io::Read;
    use std::net::TcpListener;

    /// Serve one connection with `head` (status line and headers, no blank line) then `body`.
    fn serve_once(head: &'static str, body: Vec<u8>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let Ok((mut conn, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 2048];
            let _ = conn.read(&mut buf);
            let _ = conn.write_all(head.as_bytes());
            let _ = conn.write_all(b"\r\n\r\n");
            let _ = conn.write_all(&body);
        });
        port
    }

    fn download(url: &str) -> Result<Downloaded, AttachmentError> {
        tauri::async_runtime::block_on(download_image_with(url, "Pasted image 1", false))
    }

    fn png_body() -> Vec<u8> {
        let mut b = PNG.to_vec();
        b.extend_from_slice(&[0; 16]);
        b
    }

    #[test]
    fn downloads_an_image_by_content_type_and_names_it_from_the_url() {
        let port = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png; charset=binary\r\nConnection: close",
            png_body(),
        );
        let got = download(&format!(
            "http://127.0.0.1:{port}/a/holiday%20photo.jpeg?x=1"
        ))
        .unwrap();
        // the extension follows the detected type, not the URL
        assert_eq!(got.name, "holiday photo.png");
        assert_eq!(got.bytes, png_body());
    }

    #[test]
    fn sniffs_the_type_when_the_content_type_is_generic() {
        let port = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nConnection: close",
            png_body(),
        );
        let got = download(&format!("http://127.0.0.1:{port}/img")).unwrap();
        assert_eq!(got.name, "img.png");
    }

    #[test]
    fn content_disposition_names_the_file_and_generic_names_fall_back() {
        let port = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: image/gif\r\nContent-Disposition: attachment; filename=\"cat #1.gif\"\r\nConnection: close",
            b"GIF89a....".to_vec(),
        );
        assert_eq!(
            download(&format!("http://127.0.0.1:{port}/x"))
                .unwrap()
                .name,
            "cat -1.gif"
        );
        let port = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: image/webp\r\nConnection: close",
            b"RIFF....WEBPVP8 ".to_vec(),
        );
        assert_eq!(
            download(&format!("http://127.0.0.1:{port}/download.webp"))
                .unwrap()
                .name,
            "Pasted image 1.webp"
        );
    }

    #[test]
    fn refuses_a_response_that_is_not_an_image() {
        let port = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close",
            b"<html><body>nope</body></html>".to_vec(),
        );
        let err = download(&format!("http://127.0.0.1:{port}/page")).unwrap_err();
        assert!(matches!(err, AttachmentError::Unsupported(_)), "{err:?}");
    }

    #[test]
    fn refuses_an_error_status() {
        let port = serve_once(
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close",
            vec![],
        );
        let err = download(&format!("http://127.0.0.1:{port}/gone.png")).unwrap_err();
        assert!(err.to_string().contains("404"), "{err}");
    }

    #[test]
    fn enforces_the_size_cap_from_the_header_and_while_streaming() {
        let head: &'static str = Box::leak(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close",
                max_bytes() + 1
            )
            .into_boxed_str(),
        );
        let port = serve_once(head, vec![]);
        let err = download(&format!("http://127.0.0.1:{port}/big.png")).unwrap_err();
        assert!(matches!(err, AttachmentError::TooLarge(_)), "{err:?}");

        // No Content-Length: the cap is enforced as the bytes arrive.
        let port = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close",
            vec![0u8; max_bytes() as usize + 1024],
        );
        let err = download(&format!("http://127.0.0.1:{port}/big.png")).unwrap_err();
        assert!(matches!(err, AttachmentError::TooLarge(_)), "{err:?}");
    }

    #[test]
    fn refuses_schemes_other_than_http_and_https() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/a.png",
            "data:image/png;base64,AAAA",
            "javascript:alert(1)",
            "not a url",
        ] {
            let err = download(url).unwrap_err();
            assert!(
                matches!(err, AttachmentError::Unsupported(_)),
                "{url}: {err:?}"
            );
        }
    }

    #[test]
    fn does_not_follow_a_redirect_to_another_scheme() {
        let port = serve_once(
            "HTTP/1.1 302 Found\r\nLocation: file:///etc/passwd\r\nContent-Length: 0\r\nConnection: close",
            vec![],
        );
        let err = download(&format!("http://127.0.0.1:{port}/r.png")).unwrap_err();
        assert!(err.to_string().contains("302"), "{err}");
    }

    #[test]
    fn sniffs_every_supported_format() {
        assert_eq!(sniff_extension(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
        assert_eq!(sniff_extension(b"  <svg xmlns=''></svg>"), Some("svg"));
        assert_eq!(sniff_extension(b"<?xml version='1.0'?><svg/>"), Some("svg"));
        assert_eq!(sniff_extension(b"\0\0\0\x1cftypavif...."), Some("avif"));
        assert_eq!(sniff_extension(b"\0\0\0\x1cftypheic...."), Some("heic"));
        assert_eq!(sniff_extension(b"BM\0\0\0\0\0\0\0\0\0\0"), Some("bmp"));
        assert_eq!(sniff_extension(b"<html></html>"), None);
        assert_eq!(sniff_extension(b"plain text"), None);
    }
}
