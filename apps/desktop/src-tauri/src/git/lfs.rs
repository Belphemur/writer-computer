//! Large files (spec `SPECs/git-sync-spec.md` "LFS", ADR point 10): Tauri-free and gix-free, the
//! pure half of the optional Git LFS support.
//!
//! **Pointers are written in-process.** The pointer format is three fixed lines
//! (`version https://git-lfs.github.com/spec/v1`, `oid sha256:<hex>`, `size <bytes>`) and the local
//! object store is `.git/lfs/objects/<aa>/<bb>/<oid>`; both are specified and stable, so a commit
//! hashes the file (streamed, never held in memory), copies it into the store and commits the
//! pointer, with no child process per file and no dependency on `git-lfs` to *record* a version
//! (the sha-256 is the `sha2` the app already has). `git-lfs` is needed only to move objects
//! (`git lfs push` and `fetch`, in `transport.rs`) and by the user's own git.
//!
//! **One pattern rule: per file.** A file that crosses the threshold gets its own exact path in the
//! managed block of `.gitattributes` (anchored with a leading `/`, glob characters escaped, quoted
//! when it holds a space). A per-extension rule would silently pull every small file of that
//! extension (screenshots, small PDFs) into LFS, so "files above the threshold" would stop being
//! true. A file once in LFS stays there (its line stays while the file exists, as with
//! `git lfs track`); lines of files that are gone are dropped the next time the block is written.

use super::ignore;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

pub const VERSION_LINE: &str = "version https://git-lfs.github.com/spec/v1";
/// A pointer file is never bigger than this (git-lfs's own limit is 1024 bytes).
const MAX_POINTER_BYTES: u64 = 1024;
/// What the attributes line says for a tracked file.
const ATTRIBUTES: &str = "filter=lfs diff=lfs merge=lfs -text";

/// What the settings say, as the engine uses them: LFS is `enabled` only when `git.lfs` is on and
/// `git-lfs` is installed; `threshold` is `git.lfs-threshold-mb` in bytes (it is also the size
/// above which a file is not versioned at all while LFS is off).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lfs {
    pub enabled: bool,
    pub threshold: u64,
}

/// The size Writer stops versioning plain files at, and LFS's default threshold: 100 MB, which
/// is also GitHub's hard limit for a plain file.
pub const DEFAULT_THRESHOLD_MB: f64 = 100.0;
pub const DEFAULT_THRESHOLD: u64 = (DEFAULT_THRESHOLD_MB as u64) * 1024 * 1024;

impl Lfs {
    /// LFS off, the 100 MB default threshold.
    pub const OFF: Lfs = Lfs {
        enabled: false,
        threshold: DEFAULT_THRESHOLD,
    };

    /// From the two settings and whether `git-lfs` was found. A threshold under 1 MB is 1 MB.
    pub fn from_settings(on: bool, threshold_mb: f64, installed: bool) -> Lfs {
        let mb = if threshold_mb.is_finite() {
            threshold_mb.max(1.0)
        } else {
            DEFAULT_THRESHOLD_MB
        };
        Lfs {
            enabled: on && installed,
            threshold: (mb * 1024.0 * 1024.0) as u64,
        }
    }
}

impl Default for Lfs {
    fn default() -> Lfs {
        Lfs::OFF
    }
}

// ---- pointers ----------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pointer {
    /// Lowercase hex sha-256 of the content.
    pub oid: String,
    pub size: u64,
}

impl Pointer {
    pub fn text(&self) -> String {
        format!(
            "{VERSION_LINE}\noid sha256:{}\nsize {}\n",
            self.oid, self.size
        )
    }

    /// The pointer a file's bytes would have, `None` when `bytes` is not a pointer file.
    pub fn parse(bytes: &[u8]) -> Option<Pointer> {
        if bytes.len() as u64 > MAX_POINTER_BYTES {
            return None;
        }
        let text = std::str::from_utf8(bytes).ok()?;
        let mut lines = text.lines();
        if lines.next()? != VERSION_LINE {
            return None;
        }
        let (mut oid, mut size) = (None, None);
        for l in lines {
            if let Some(h) = l.strip_prefix("oid sha256:") {
                let ok = h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit());
                oid = ok.then(|| h.to_ascii_lowercase());
            } else if let Some(n) = l.strip_prefix("size ") {
                size = n.parse().ok();
            }
        }
        Some(Pointer {
            oid: oid?,
            size: size?,
        })
    }
}

pub fn is_pointer(bytes: &[u8]) -> bool {
    Pointer::parse(bytes).is_some()
}

/// Is the file on disk itself a pointer (a checkout that was never smudged)?
pub fn file_is_pointer(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > MAX_POINTER_BYTES {
        return false;
    }
    std::fs::read(path).is_ok_and(|b| is_pointer(&b))
}

#[cfg(test)]
thread_local! {
    /// Full passes over a file's bytes on this thread (tests assert the status poll makes none).
    pub(crate) static HASHES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// Objects read whole from the store on this thread.
    pub(crate) static OBJECT_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The one streaming sha-256: reads `src` in chunks, copying each to `sink` when there is one.
fn stream(src: &mut impl Read, mut sink: Option<&mut dyn Write>) -> io::Result<Pointer> {
    #[cfg(test)]
    HASHES.with(|h| h.set(h.get() + 1));
    let (mut hasher, mut size, mut buf) = (Sha256::new(), 0u64, vec![0u8; 1 << 20]);
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        if let Some(w) = sink.as_mut() {
            w.write_all(&buf[..n])?;
        }
        size += n as u64;
    }
    Ok(Pointer {
        oid: crate::hash::hex(&hasher.finalize()),
        size,
    })
}

/// The pointer of a file, hashed in chunks.
pub fn pointer_of_file(path: &Path) -> io::Result<Pointer> {
    stream(&mut File::open(path)?, None)
}

pub fn pointer_of_bytes(bytes: &[u8]) -> Pointer {
    Pointer {
        oid: crate::hash::sha256_hex(bytes),
        size: bytes.len() as u64,
    }
}

// ---- the local object store ----------------------------------------------------------------------
//
// Every function takes the repository's *common* git directory (`Repo::common_dir`: `.git`, or the
// main repository's for a linked worktree), where git-lfs keeps `lfs/`.

fn store_dir(common: &Path) -> PathBuf {
    common.join("lfs")
}

/// `<common>/lfs/objects/<aa>/<bb>/<oid>`
pub fn object_path(common: &Path, p: &Pointer) -> PathBuf {
    store_dir(common)
        .join("objects")
        .join(&p.oid[..2])
        .join(&p.oid[2..4])
        .join(&p.oid)
}

/// Did `git lfs install --local` run in this repository (its config has the `lfs` filter)?
pub fn installed_in(common: &Path) -> bool {
    std::fs::read_to_string(common.join("config"))
        .is_ok_and(|c| c.lines().any(|l| l.trim() == "[filter \"lfs\"]"))
}

/// Does this repository's local store hold any object (it ever had a large file committed)?
pub fn has_store(common: &Path) -> bool {
    std::fs::read_dir(store_dir(common).join("objects")).is_ok_and(|mut d| d.next().is_some())
}

/// Is the content of `p` in the local store (by name and size; objects are written whole under
/// their hash name by rename, and never rewritten)?
pub fn has_object(common: &Path, p: &Pointer) -> bool {
    std::fs::metadata(object_path(common, p)).is_ok_and(|m| m.is_file() && m.len() == p.size)
}

/// Copies the file into the store and returns its pointer. An object already there is not
/// copied again. The copy is hashed on the way and lands under its hash name by rename, so a
/// crash leaves no half object under a real name and a file that changed while it was read is
/// refused.
pub fn store_file(common: &Path, file: &Path) -> io::Result<Pointer> {
    let known = pointer_of_file(file)?;
    if has_object(common, &known) {
        return Ok(known);
    }
    let tmp = temp_in(common)?;
    let result = (|| {
        let mut dst = File::create(&tmp)?;
        let p = stream(&mut File::open(file)?, Some(&mut dst))?;
        dst.sync_all()?;
        if p != known {
            return Err(io::Error::other("the file changed while it was saved"));
        }
        let target = object_path(common, &p);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&tmp, target)?;
        Ok(p)
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

/// A fresh temp path under `<common>/lfs/tmp` (never inside the vault).
fn temp_in(common: &Path) -> io::Result<PathBuf> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = store_dir(common).join("tmp");
    std::fs::create_dir_all(&dir)?;
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(dir.join(format!("writer-{}-{n}", std::process::id())))
}

/// The content of `p` from the store, `None` when it is not there (not fetched yet).
pub fn read_object(common: &Path, p: &Pointer) -> Option<Vec<u8>> {
    if !has_object(common, p) {
        return None;
    }
    #[cfg(test)]
    OBJECT_READS.with(|h| h.set(h.get() + 1));
    std::fs::read(object_path(common, p)).ok()
}

/// `blob` as the content a reader wants: a pointer whose object is in the store becomes that
/// object; anything else (not a pointer, or one not fetched) is returned as it is.
pub fn resolve(common: &Path, blob: Vec<u8>) -> Vec<u8> {
    match Pointer::parse(&blob).and_then(|p| read_object(common, &p)) {
        Some(real) => real,
        None => blob,
    }
}

/// Writes the content of `p` over `target` (an absolute path the caller confined to the vault),
/// streamed through a temp file under `<common>/lfs/tmp` and renamed into place; the temp file
/// is removed when anything fails. `false` when the store does not hold the object.
pub fn materialize(common: &Path, target: &Path, p: &Pointer) -> io::Result<bool> {
    if !has_object(common, p) {
        return Ok(false);
    }
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = temp_in(common)?;
    let result = (|| {
        std::fs::copy(object_path(common, p), &tmp)?;
        #[cfg(unix)]
        if let Ok(m) = std::fs::metadata(target) {
            let _ = std::fs::set_permissions(&tmp, m.permissions());
        }
        std::fs::rename(&tmp, target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map(|()| true)
}

// ---- `.gitattributes` ----------------------------------------------------------------------------

/// A path as a `.gitattributes` pattern that matches exactly that file: anchored at the vault
/// root, glob characters escaped, C-quoted when it holds whitespace or a quote.
pub fn pattern(rel: &str) -> String {
    let mut glob = String::from("/");
    for c in rel.chars() {
        if matches!(c, '\\' | '*' | '?' | '[' | ']' | '#' | '!') {
            glob.push('\\');
        }
        glob.push(c);
    }
    if glob.chars().any(|c| c.is_whitespace() || c == '"') {
        let mut q = String::from("\"");
        for c in glob.chars() {
            match c {
                '\\' | '"' => {
                    q.push('\\');
                    q.push(c);
                }
                '\t' => q.push_str("\\t"),
                '\n' => q.push_str("\\n"),
                '\r' => q.push_str("\\r"),
                c => q.push(c),
            }
        }
        q.push('"');
        q
    } else {
        glob
    }
}

/// The path a pattern from [`pattern`] stands for; `None` for a line of another shape.
fn path_of_pattern(pat: &str) -> Option<String> {
    let mut chars: Vec<char> = pat.chars().collect();
    if chars.first() == Some(&'"') {
        if chars.last() != Some(&'"') || chars.len() < 2 {
            return None;
        }
        chars = chars[1..chars.len() - 1].to_vec();
        let mut unq = Vec::new();
        let mut it = chars.into_iter();
        while let Some(c) = it.next() {
            if c == '\\' {
                match it.next()? {
                    't' => unq.push('\t'),
                    'n' => unq.push('\n'),
                    'r' => unq.push('\r'),
                    other => unq.push(other),
                }
            } else {
                unq.push(c);
            }
        }
        chars = unq;
    }
    if chars.first() != Some(&'/') {
        return None;
    }
    let mut out = String::new();
    let mut it = chars.into_iter().skip(1);
    while let Some(c) = it.next() {
        if c == '\\' {
            out.push(it.next()?);
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// The tracking line for one file.
pub fn line(rel: &str) -> String {
    format!("{} {ATTRIBUTES}", pattern(rel))
}

/// The files the managed block of a `.gitattributes` tracks.
pub fn tracked(text: &str) -> BTreeSet<String> {
    ignore::block_lines(text)
        .into_iter()
        .filter_map(|l| {
            let pat = l.strip_suffix(ATTRIBUTES)?.trim_end();
            path_of_pattern(pat)
        })
        .collect()
}

/// `existing` with the managed block holding exactly the lines for `paths` (sorted, so the text is
/// the same however the set was built): idempotent, every line outside the markers untouched.
pub fn apply(existing: &str, paths: &BTreeSet<String>) -> String {
    ignore::replace_block(existing, &block(paths))
}

/// The managed block (markers included) for `paths`.
pub fn block(paths: &BTreeSet<String>) -> String {
    let lines: Vec<String> = paths.iter().map(|p| line(p)).collect();
    ignore::block_of(lines.iter().map(String::as_str))
}

/// What two devices that each changed the managed block leave tracked: what either side tracks,
/// minus what either side stopped tracking since `base`.
pub fn union_block(base: &str, mine: &str, theirs: &str) -> BTreeSet<String> {
    let (b, m, t) = (tracked(base), tracked(mine), tracked(theirs));
    let mut keep: BTreeSet<String> = m.union(&t).cloned().collect();
    for gone in b.difference(&m).chain(b.difference(&t)) {
        keep.remove(gone);
    }
    keep
}

/// The line that stands for the managed block while the rest of a `.gitattributes` is merged as
/// text (see `merge.rs`).
pub const BLOCK_PLACEHOLDER: &str = "# writer:attributes-block\n";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_round_trip_and_format() {
        let p = pointer_of_bytes(b"hello");
        assert_eq!(
            p.text(),
            "version https://git-lfs.github.com/spec/v1\noid sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\nsize 5\n"
        );
        assert_eq!(Pointer::parse(p.text().as_bytes()), Some(p));
        assert!(Pointer::parse(b"not a pointer").is_none());
        assert!(Pointer::parse(b"version https://git-lfs.github.com/spec/v1\nsize 3\n").is_none());
        let long = format!(
            "{VERSION_LINE}\noid sha256:{}\nsize 1\n{}",
            "a".repeat(64),
            "x".repeat(2000)
        );
        assert!(Pointer::parse(long.as_bytes()).is_none());
    }

    #[test]
    fn from_settings_needs_the_tool_and_clamps() {
        assert!(!Lfs::from_settings(true, 100.0, false).enabled);
        assert!(!Lfs::from_settings(false, 100.0, true).enabled);
        let on = Lfs::from_settings(true, 5.0, true);
        assert!(on.enabled);
        assert_eq!(on.threshold, 5 * 1024 * 1024);
        assert_eq!(Lfs::from_settings(true, 0.0, true).threshold, 1024 * 1024);
        assert_eq!(
            Lfs::from_settings(true, f64::NAN, true).threshold,
            DEFAULT_THRESHOLD
        );
    }

    #[test]
    fn store_and_materialize() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("big.bin"), b"0123456789").unwrap();
        let p = store_file(root, &root.join("big.bin")).unwrap();
        assert_eq!(p, pointer_of_bytes(b"0123456789"));
        assert_eq!(pointer_of_file(&root.join("big.bin")).unwrap(), p);
        assert!(object_path(root, &p).ends_with(format!(
            "objects/{}/{}/{}",
            &p.oid[..2],
            &p.oid[2..4],
            p.oid
        )));
        assert_eq!(read_object(root, &p).as_deref(), Some(&b"0123456789"[..]));
        assert_eq!(resolve(root, p.text().into_bytes()), b"0123456789");
        // a pointer whose object is missing stays a pointer
        let other = pointer_of_bytes(b"other");
        assert_eq!(
            resolve(root, other.text().into_bytes()),
            other.text().into_bytes()
        );
        std::fs::write(root.join("big.bin"), b"changed").unwrap();
        assert!(materialize(root, &root.join("big.bin"), &p).unwrap());
        assert_eq!(std::fs::read(root.join("big.bin")).unwrap(), b"0123456789");
        assert!(!materialize(root, &root.join("x"), &other).unwrap());
        assert!(!file_is_pointer(&root.join("big.bin")));
        std::fs::write(root.join("ptr"), p.text()).unwrap();
        assert!(file_is_pointer(&root.join("ptr")));
    }

    #[test]
    fn patterns_round_trip() {
        for rel in [
            "a.bin",
            "dir/my file.mov",
            "we*ird[1]?.zip",
            "q\"uote.bin",
            "#hash.bin",
            "back\\slash.bin",
            "tab\there.bin",
            "é/ü.mp4",
        ] {
            let pat = pattern(rel);
            assert!(pat.starts_with('/') || pat.starts_with("\"/"), "{pat}");
            assert_eq!(path_of_pattern(&pat).as_deref(), Some(rel), "{pat}");
        }
        assert_eq!(pattern("a/b.bin"), "/a/b.bin");
        assert_eq!(pattern("a b.bin"), "\"/a b.bin\"");
        assert_eq!(pattern("x*.bin"), "/x\\*.bin");
    }

    #[test]
    fn block_is_idempotent_and_keeps_user_lines() {
        let user = "*.psd filter=lfs diff=lfs merge=lfs -text\n# mine\n";
        let paths: BTreeSet<String> = ["b/big.bin", "a big.mov"].map(String::from).into();
        let once = apply(user, &paths);
        assert!(once.starts_with(user));
        assert_eq!(apply(&once, &paths), once);
        assert_eq!(tracked(&once), paths);
        // a trailing user line after the block survives a rewrite
        let tail = format!("{once}after\n");
        let fewer: BTreeSet<String> = ["b/big.bin"].map(String::from).into();
        let rewritten = apply(&tail, &fewer);
        assert!(rewritten.starts_with(user) && rewritten.ends_with("after\n"));
        assert_eq!(tracked(&rewritten), fewer);
        // the user's own lfs line is not Writer's
        assert!(tracked(user).is_empty());
    }

    #[test]
    fn union_of_two_devices_blocks() {
        let base = apply("", &BTreeSet::new());
        let m = apply(&base, &["a.bin"].map(String::from).into());
        let t = apply(&base, &["b.bin"].map(String::from).into());
        assert_eq!(
            union_block(&base, &m, &t),
            ["a.bin", "b.bin"].map(String::from).into()
        );
        // a removal on one side wins over the other's keeping it
        let both = apply(&base, &["a.bin", "b.bin"].map(String::from).into());
        let only_a = apply(&both, &["a.bin"].map(String::from).into());
        assert_eq!(
            union_block(&both, &only_a, &both),
            ["a.bin"].map(String::from).into()
        );
    }

    /// Patterns as git reads them (`git check-attr`, run in `lfs_tests`) for awkward names.
    #[test]
    fn newline_and_carriage_return_names_round_trip() {
        for rel in ["a\nb.bin", "c\rd.bin", "e\n\"f\".bin"] {
            let pat = pattern(rel);
            assert!(!pat.contains('\n') && !pat.contains('\r'), "{pat:?}");
            assert_eq!(path_of_pattern(&pat).as_deref(), Some(rel));
        }
    }
}
