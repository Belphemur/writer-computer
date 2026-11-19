//! Files in an agent chat, images and PDFs (spec `SPECs/native-agent-spec.md` "Files in the
//! composer", `SPECs/pdf-spec.md` "Agent attachments"). Tauri-free.
//!
//! Two jobs. Where a pasted or dropped file lives: next to the chat notes, in the hidden
//! `assets/` folder of the chat's folder (`<project>/.chats/assets/`, or `.writer/chats/assets/`
//! at the vault root), never in the visible attachments folder; saving goes through the one image
//! write path (`attachments::save_chat_file`: type, size, confinement, no clobber). And what claude gets:
//! each attached image as a native `image` content block and each PDF as a native `document` block
//! (base64) next to the text (`encode_user_message`), read from the vault at send time. Type and
//! size rules are `shared/attachments.json`; what is added here (`shared/agent-chat-files.json`) is
//! which of those types the model accepts as a block and the API's caps for a document.

use super::chat_store;
use super::events::ContextRef;
use crate::attachments::{self, Saved, Source};
use base64::Engine as _;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shared {
    media_types: BTreeMap<String, String>,
    document_media_types: BTreeMap<String, String>,
    document_max_bytes: u64,
}

static SHARED: LazyLock<Shared> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../shared/agent-chat-files.json"))
        .expect("shared/agent-chat-files.json is valid")
});

/// Image types the model takes as a content block (`media_type` by extension): narrower than
/// `importExtensions` (svg, avif, bmp and heic are importable into a note but not readable by the
/// model).
fn native() -> &'static BTreeMap<String, String> {
    &SHARED.media_types
}

/// The largest PDF sent as a document block (the API's request cap less the base64 overhead).
pub fn document_max_bytes() -> u64 {
    SHARED.document_max_bytes
}

/// Which native block a file becomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Image,
    Document,
}

/// A saved chat file (image or PDF) as the composer needs it: the vault-relative path (what the
/// draft keeps and the chat note embeds) and the file name (the chip label).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatFile {
    pub path: String,
    pub name: String,
}

impl From<Saved> for ChatFile {
    fn from(s: Saved) -> Self {
        Self {
            path: s.rel_path,
            name: s.file_name,
        }
    }
}

/// Folder of the pasted images inside a chats folder.
pub const ASSETS_DIR: &str = "assets";

/// The block kind and `media_type` of a file name when the model can read it.
pub fn native_type(name: &str) -> Option<(FileKind, &'static str)> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    if let Some(m) = native().get(&ext) {
        return Some((FileKind::Image, m.as_str()));
    }
    SHARED
        .document_media_types
        .get(&ext)
        .map(|m| (FileKind::Document, m.as_str()))
}

/// The `media_type` of a file name when the model can read it (image or document).
pub fn media_type(name: &str) -> Option<&'static str> {
    native_type(name).map(|(_, m)| m)
}

/// One file ready for the stdin message: an `image` or a `document` block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePart {
    pub kind: FileKind,
    pub media_type: &'static str,
    /// Standard base64 of the file.
    pub data: String,
}

/// One user message on its way to claude: the prompt text and its file blocks. Queued, replayed
/// after a respawn and encoded as one unit, so a file never travels without its text.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Outgoing {
    pub text: String,
    pub files: Vec<FilePart>,
}

impl Outgoing {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            files: Vec::new(),
        }
    }
}

/// The vault-relative folder (existing or not) that holds the pasted images of a chat folder.
pub fn assets_folder(root: &Path, project_path: Option<&str>) -> Result<String, String> {
    let dir = chat_store::chats_dir(root, project_path).map_err(|e| e.to_string())?;
    let rel = dir
        .strip_prefix(root)
        .map_err(|_| "the chats folder is outside the vault".to_string())?;
    let rel = rel.to_string_lossy().replace('\\', "/");
    Ok(format!("{rel}/{ASSETS_DIR}"))
}

/// Saves pasted or browser-dropped bytes into the chat's assets folder.
pub fn save_bytes(
    root: &Path,
    project_path: Option<&str>,
    name: &str,
    bytes: &[u8],
) -> Result<Saved, String> {
    check_native(name, Some(bytes.len() as u64))?;
    let folder = assets_folder(root, project_path)?;
    attachments::save_chat_file(root, &folder, name, Source::Bytes(bytes))
        .map_err(|e| e.to_string())
}

/// Copies a dropped file (Finder) into the chat's assets folder by path.
pub fn import_file(
    root: &Path,
    project_path: Option<&str>,
    source: &Path,
) -> Result<Saved, String> {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "the dropped item has no name".to_string())?;
    check_native(&name, std::fs::metadata(source).ok().map(|m| m.len()))?;
    let folder = assets_folder(root, project_path)?;
    attachments::save_chat_file(root, &folder, &name, Source::File(source))
        .map_err(|e| e.to_string())
}

/// Refuses, with a sentence the composer shows, a file the model cannot read, or a PDF over the
/// API's size cap (`size` None: not known yet, only the type is checked).
fn check_native(name: &str, size: Option<u64>) -> Result<(), String> {
    match native_type(name) {
        None => Err("Not attached: Claude reads png, jpg, gif and webp images and PDFs".into()),
        Some((FileKind::Document, _)) if size.is_some_and(|n| n > document_max_bytes()) => {
            Err(format!(
                "Not attached: {name} is over the {} MB PDF limit",
                document_max_bytes() / (1024 * 1024)
            ))
        }
        Some(_) => Ok(()),
    }
}

/// The file parts of a message's refs (images and PDFs), read from the vault (confined, type and
/// size checked). A file that is gone, too large or of a type the model cannot read is an error: a
/// message is never sent silently without a file the user attached.
pub fn load_parts(root: &Path, refs: &[ContextRef]) -> Result<Vec<FilePart>, String> {
    let mut seen: Vec<&str> = Vec::new();
    let mut parts = Vec::new();
    for r in refs {
        let (ContextRef::Image { path } | ContextRef::Document { path }) = r else {
            continue;
        };
        if seen.contains(&path.as_str()) {
            continue;
        }
        seen.push(path);
        let confined = crate::vault_ops::confine(root, path).map_err(|e| e.to_string())?;
        let (kind, media) = native_type(&confined.rel)
            .ok_or_else(|| format!("{path} is not a file type Claude can read"))?;
        let expected = if matches!(r, ContextRef::Image { .. }) {
            FileKind::Image
        } else {
            FileKind::Document
        };
        if kind != expected {
            return Err(format!("{path} is not a file type Claude can read"));
        }
        let cap = match kind {
            FileKind::Image => attachments::max_bytes(),
            FileKind::Document => document_max_bytes(),
        };
        let meta = std::fs::metadata(&confined.abs)
            .map_err(|_| format!("the file {path} is no longer there"))?;
        if !meta.is_file() || meta.len() > cap {
            return Err(format!("the file {path} is missing or too large"));
        }
        let bytes = std::fs::read(&confined.abs).map_err(|e| e.to_string())?;
        parts.push(FilePart {
            kind,
            media_type: media,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R',
    ];

    fn vault() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        (dir, root)
    }

    #[test]
    fn the_model_reads_png_jpg_gif_and_webp_only() {
        assert_eq!(media_type("a.PNG"), Some("image/png"));
        assert_eq!(media_type("a.jpeg"), Some("image/jpeg"));
        assert_eq!(media_type("a.jpg"), Some("image/jpeg"));
        assert_eq!(media_type("a.gif"), Some("image/gif"));
        assert_eq!(media_type("a.webp"), Some("image/webp"));
        for no in ["a.svg", "a.heic", "a.bmp", "a.avif", "a.md", "a"] {
            assert_eq!(media_type(no), None, "{no}");
        }
    }

    #[test]
    fn every_native_type_is_an_importable_image_type() {
        for ext in native().keys() {
            assert!(
                attachments::image_extension(&format!("x.{ext}")).is_some(),
                "{ext} is not in shared/attachments.json"
            );
        }
    }

    #[test]
    fn the_model_reads_pdfs_as_documents() {
        assert_eq!(
            native_type("a.PDF"),
            Some((FileKind::Document, "application/pdf"))
        );
        assert_eq!(native_type("a.png").map(|t| t.0), Some(FileKind::Image));
        assert_eq!(media_type("a.pdf"), Some("application/pdf"));
        assert_eq!(native_type("a.docx"), None);
    }

    #[test]
    fn every_document_type_is_a_listed_document_extension() {
        for ext in SHARED.document_media_types.keys() {
            assert!(
                attachments::is_document_name(&format!("x.{ext}")),
                "{ext} is not in shared/attachments.json documentExtensions"
            );
        }
        // the cap leaves room for the base64 overhead inside the API's 32 MB request
        assert!(document_max_bytes() * 4 / 3 < 32 * 1024 * 1024);
    }

    #[test]
    fn pasted_images_go_to_the_hidden_chat_assets_folder() {
        let (_d, root) = vault();
        let saved = save_bytes(&root, None, "Pasted image 1.png", PNG).unwrap();
        assert_eq!(saved.rel_path, ".writer/chats/assets/Pasted image 1.png");
        assert_eq!(std::fs::read(&saved.abs_path).unwrap(), PNG);
        // a second one with the same name does not overwrite
        let again = save_bytes(&root, None, "Pasted image 1.png", PNG).unwrap();
        assert_eq!(again.rel_path, ".writer/chats/assets/Pasted image 1 1.png");
        // a project's chats live in its own `.chats`
        std::fs::create_dir_all(root.join("Projects/Demo")).unwrap();
        let p = save_bytes(&root, Some("Projects/Demo"), "a.png", PNG).unwrap();
        assert_eq!(p.rel_path, "Projects/Demo/.chats/assets/a.png");
        assert!(
            !root.join("attachments").exists(),
            "never the visible folder"
        );
    }

    #[test]
    fn unsupported_and_oversize_images_are_refused_with_a_sentence() {
        let (_d, root) = vault();
        let svg = save_bytes(&root, None, "a.svg", b"<svg/>").unwrap_err();
        assert!(
            svg.contains("png, jpg, gif and webp images and PDFs"),
            "{svg}"
        );
        let txt = save_bytes(&root, None, "a.txt", b"x").unwrap_err();
        assert!(txt.contains("Claude reads"), "{txt}");
        let big = vec![0u8; attachments::max_bytes() as usize + 1];
        let e = save_bytes(&root, None, "big.png", &big).unwrap_err();
        assert!(e.contains("over the"), "{e}");
        assert!(!root.join(".writer/chats/assets/big.png").exists());
    }

    #[test]
    fn a_pdf_is_saved_beside_images_and_refused_over_the_cap() {
        let (_d, root) = vault();
        let saved = save_bytes(&root, None, "paper.pdf", b"%PDF-1.7 x").unwrap();
        assert_eq!(saved.rel_path, ".writer/chats/assets/paper.pdf");
        let big = vec![0u8; document_max_bytes() as usize + 1];
        let e = save_bytes(&root, None, "big.pdf", &big).unwrap_err();
        assert!(e.contains("PDF limit"), "{e}");
        assert!(!root.join(".writer/chats/assets/big.pdf").exists());
    }

    #[test]
    fn a_dropped_file_is_copied_by_path() {
        let (_d, root) = vault();
        let outside = tempfile::tempdir().unwrap();
        let src = outside.path().join("shot.png");
        std::fs::write(&src, PNG).unwrap();
        let saved = import_file(&root, None, &src).unwrap();
        assert_eq!(saved.rel_path, ".writer/chats/assets/shot.png");
        assert!(import_file(&root, None, &outside.path().join("a.svg")).is_err());
    }

    #[test]
    fn parts_are_read_from_the_vault_and_deduplicated() {
        let (_d, root) = vault();
        std::fs::create_dir_all(root.join("pics")).unwrap();
        std::fs::write(root.join("pics/a.png"), PNG).unwrap();
        let r = |p: &str| ContextRef::Image { path: p.into() };
        let parts = load_parts(
            &root,
            &[
                r("pics/a.png"),
                r("pics/a.png"),
                ContextRef::Note {
                    path: "n.md".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].kind, FileKind::Image);
        assert_eq!(parts[0].media_type, "image/png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&parts[0].data)
                .unwrap(),
            PNG
        );
    }

    #[test]
    fn a_pdf_ref_becomes_a_document_part_and_a_mismatched_ref_fails() {
        let (_d, root) = vault();
        std::fs::write(root.join("a.pdf"), b"%PDF-1.7 hello").unwrap();
        std::fs::write(root.join("a.png"), PNG).unwrap();
        let doc = |p: &str| ContextRef::Document { path: p.into() };
        let parts = load_parts(&root, &[doc("a.pdf"), doc("a.pdf")]).unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].kind, FileKind::Document);
        assert_eq!(parts[0].media_type, "application/pdf");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&parts[0].data)
                .unwrap(),
            b"%PDF-1.7 hello"
        );
        // a ref of the wrong kind never sends a block of another kind
        assert!(load_parts(&root, &[doc("a.png")]).is_err());
        let img = [ContextRef::Image {
            path: "a.pdf".into(),
        }];
        assert!(load_parts(&root, &img).is_err());
        // an escaping or missing PDF fails the send
        assert!(load_parts(&root, &[doc("../x.pdf")]).is_err());
        assert!(load_parts(&root, &[doc("gone.pdf")]).is_err());
        // order is the order attached
        let both = load_parts(
            &root,
            &[
                ContextRef::Image {
                    path: "a.png".into(),
                },
                doc("a.pdf"),
            ],
        )
        .unwrap();
        assert_eq!(both[0].kind, FileKind::Image);
        assert_eq!(both[1].kind, FileKind::Document);
    }

    #[test]
    fn a_missing_escaping_or_unreadable_image_fails_the_send() {
        let (_d, root) = vault();
        let r = |p: &str| [ContextRef::Image { path: p.into() }];
        assert!(load_parts(&root, &r("gone.png")).is_err());
        assert!(load_parts(&root, &r("../x.png")).is_err());
        std::fs::write(root.join("a.svg"), "<svg/>").unwrap();
        assert!(load_parts(&root, &r("a.svg")).is_err());
        // no image refs: nothing to read, nothing to fail
        assert_eq!(load_parts(&root, &[]).unwrap(), vec![]);
    }
}
