// Ported from opensidian (GPL-3.0-or-later), Copyright (C) 2026 Jendrik Poloczek.
// SPDX-License-Identifier: GPL-3.0-or-later
//! Obsidian plugin host, backend half: the `writer-plugin` URI scheme and the
//! confined `.obsidian/plugins/<id>/` file helpers.
//!
//! A community plugin's `main.js` is ONE CommonJS bundle. The page CSP has no
//! `unsafe-eval`/`blob:` for untrusted vaults, so the bundle cannot be eval'd
//! from a string; instead Rust serves it on its own scheme, wrapped in a CJS
//! function that hands the host's module/exports/require to it.
//!
//! URL shape: `writer-plugin://localhost/<id>/main.js[?n=<reload>]` (on
//! Windows/Android webviews Tauri rewrites it to `http://writer-plugin.localhost/...`;
//! only the path is inspected, so both work).
//!
//! What the scheme serves, and nothing else (every other answer is 403/404):
//!  1. the path is exactly `/<id>/main.js`, no escapes, no other depth;
//!  2. `<id>` is a plain name (`[A-Za-z0-9._-]`, no leading dot, <= 128 bytes);
//!  3. the window's vault is TRUSTED (restricted mode off; the flag lives in
//!     the app data dir, outside the vault, so a vault cannot pre-trust itself)
//!     AND `<id>` is listed in `.obsidian/community-plugins.json`;
//!  4. `<vault>/.obsidian/plugins/<id>` canonicalises to exactly
//!     `canon(<vault>)/.obsidian/plugins/<id>` (no symlinked dirs);
//!  5. `main.js` is a regular file, not a symlink, <= `MAX_MAIN_JS` bytes.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SCHEME: &str = "writer-plugin";
/// The biggest real bundles are ~8 MB; anything past this is not a plugin.
pub const MAX_MAIN_JS: u64 = 32 * 1024 * 1024;
/// The JS host function the wrapper calls (the TS loader defines it).
pub const DEFINE_FN: &str = "__writerPluginDefine";
pub const ENABLED_FILE: &str = "community-plugins.json";
pub const MAX_DATA_JSON: u64 = 16 * 1024 * 1024;
pub const MAX_STYLES: u64 = 4 * 1024 * 1024;
pub const MAX_MANIFEST: u64 = 256 * 1024;
const MAX_ENABLED_FILE: u64 = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Served {
    Js(Vec<u8>),
    Refused(&'static str),
    Missing,
}

/// A plugin id is a plain directory name.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && !id.contains("..")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// `/<id>/main.js` -> Some(id); anything else -> None.
pub fn parse_path(path: &str) -> Option<&str> {
    let rest = path.strip_prefix('/')?;
    let (id, file) = rest.split_once('/')?;
    (file == "main.js" && valid_id(id)).then_some(id)
}

fn obsidian_dir(root: &Path, create: bool) -> Result<PathBuf, String> {
    let dir = root.join(".obsidian");
    match fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() => Ok(dir),
        Ok(_) => Err(".obsidian is not a plain directory".into()),
        Err(_) if create => {
            fs::create_dir(&dir).map_err(|e| format!(".obsidian: {e}"))?;
            Ok(dir)
        }
        Err(e) => Err(format!(".obsidian: {e}")),
    }
}

/// The vault's enabled list. Unreadable / malformed = nothing enabled.
pub fn enabled_ids(root: &Path) -> Vec<String> {
    let p = root.join(".obsidian").join(ENABLED_FILE);
    let Ok(m) = fs::symlink_metadata(&p) else {
        return Vec::new();
    };
    if !m.is_file() || m.len() > MAX_ENABLED_FILE {
        return Vec::new();
    }
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .map(|v| {
            v.iter()
                .filter_map(|x| x.as_str())
                .filter(|s| valid_id(s))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The plugin dir, canonical and confined; None = refuse.
pub fn plugin_dir_in(root: &Path, id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    let croot = root.canonicalize().ok()?;
    let want = croot.join(".obsidian").join("plugins").join(id);
    let got = root
        .join(".obsidian")
        .join("plugins")
        .join(id)
        .canonicalize()
        .ok()?;
    (got == want && got.starts_with(&croot) && got.is_dir()).then_some(got)
}

/// A file inside a confined plugin dir. Ok(None) = absent, Err = refuse.
pub fn plugin_file_in(
    root: &Path,
    id: &str,
    file: &str,
    cap: u64,
) -> Result<Option<PathBuf>, &'static str> {
    let dir = plugin_dir_in(root, id).ok_or("plugin dir not confined")?;
    if file.is_empty() || file.contains('/') || file.contains('\\') || file.starts_with('.') {
        return Err("bad file name");
    }
    let p = dir.join(file);
    match fs::symlink_metadata(&p) {
        Err(_) => Ok(None),
        Ok(m) if m.is_symlink() => Err("symlinked file"),
        Ok(m) if !m.is_file() => Err("not a file"),
        Ok(m) if m.len() > cap => Err("too big"),
        Ok(_) => Ok(Some(p)),
    }
}

/// Electron-renderer free variables every plugin bundle may read at module
/// scope, bound as factory parameters after module,exports,require. `fetch` is the
/// plugin-scoped (Rust-backed, CORS-free) fetch; the loader supplies each positionally.
pub const FREE_VARS: &str =
    "process,global,Buffer,Error,__filename,__dirname,SharedArrayBuffer,fetch";

/// The CJS wrapper: module/exports/require come from the host's define fn. The
/// plugin source starts the function body so its own "use strict" stays a
/// directive. The trailing newline before "})" survives a final // comment.
pub fn wrap_cjs(id: &str, src: &str) -> String {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    format!(
        ";(function(){{var d=window.{DEFINE_FN};if(typeof d!==\"function\")return;d({id:?},function(module,exports,require,{FREE_VARS}){{{src}\n}});}})();\n//# sourceURL={SCHEME}://localhost/{id}/main.js\n"
    )
}

/// The whole decision for one request, unit-testable without tauri.
pub fn serve(root: Option<&Path>, path: &str, trusted: bool) -> Served {
    let Some(id) = parse_path(path) else {
        return Served::Refused("bad path");
    };
    let Some(root) = root else {
        return Served::Refused("no vault");
    };
    if !trusted {
        return Served::Refused("restricted mode");
    }
    if !enabled_ids(root).iter().any(|e| e == id) {
        return Served::Refused("not enabled");
    }
    match plugin_file_in(root, id, "main.js", MAX_MAIN_JS) {
        Err(why) => Served::Refused(why),
        Ok(None) => Served::Missing,
        Ok(Some(p)) => match fs::read(&p) {
            Ok(b) => Served::Js(wrap_cjs(id, &String::from_utf8_lossy(&b)).into_bytes()),
            Err(_) => Served::Missing,
        },
    }
}

/* ------------------------------------------------------------------ trust */

static TRUST_LOCK: Mutex<()> = Mutex::new(());

/// Trust is keyed by the CANONICAL vault path: `{ "<canon path>": true }`.
pub fn trust_key(root: &Path) -> String {
    fs::canonicalize(root)
        .unwrap_or_else(|_| root.to_path_buf())
        .display()
        .to_string()
}

fn read_trust_map(file: &Path) -> serde_json::Map<String, serde_json::Value> {
    fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| match v {
            serde_json::Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

pub fn is_trusted(trust_file: &Path, root: &Path) -> bool {
    let _g = TRUST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_trust_map(trust_file)
        .get(&trust_key(root))
        .and_then(|v| v.as_bool())
        == Some(true)
}

pub fn set_trusted(trust_file: &Path, root: &Path, trusted: bool) -> Result<(), String> {
    let _g = TRUST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read_trust_map(trust_file);
    let key = trust_key(root);
    if trusted {
        map.insert(key, serde_json::Value::Bool(true));
    } else {
        map.remove(&key);
    }
    let dir = trust_file.parent().ok_or("bad trust file path")?;
    fs::create_dir_all(dir).map_err(|e| format!("plugins trust: {e}"))?;
    let name = trust_file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("bad trust file path")?;
    let body =
        serde_json::to_string_pretty(&serde_json::Value::Object(map)).map_err(|e| e.to_string())?;
    write_atomic(dir, name, body.as_bytes())
}

/* ------------------------------------------------------------ file access */

/// Atomic replace: O_EXCL temp file in `dir`, fsync, rename over `name`. A
/// symlink at `name` is replaced, never followed. `dir` must be confined by
/// the caller.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let res = (|| -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, dir.join(name))
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{name}: {e}"));
    }
    Ok(())
}

/// Create `.obsidian/plugins/<id>` (refusing symlinked parents) and return its
/// confined canonical path.
pub fn ensure_plugin_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("bad plugin id".into());
    }
    let obs = obsidian_dir(root, true)?;
    let plugins = obs.join("plugins");
    match fs::symlink_metadata(&plugins) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(".obsidian/plugins is not a plain directory".into()),
        Err(_) => fs::create_dir(&plugins).map_err(|e| format!(".obsidian/plugins: {e}"))?,
    }
    let dir = plugins.join(id);
    match fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(format!("{id}: plugin folder is not a plain directory")),
        Err(_) => fs::create_dir(&dir).map_err(|e| format!("{id}: {e}"))?,
    }
    plugin_dir_in(root, id).ok_or_else(|| "plugin folder is not confined to the vault".into())
}

/// One installed plugin: its dir is confined and manifest.json parses as an
/// object. The id is the DIRECTORY name; the manifest's own id rides along.
pub fn installed(root: &Path) -> Vec<(String, serde_json::Value)> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(root.join(".obsidian").join("plugins")) else {
        return out;
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| valid_id(n))
        .collect();
    names.sort();
    for id in names {
        let Ok(Some(mp)) = plugin_file_in(root, &id, "manifest.json", MAX_MANIFEST) else {
            continue;
        };
        let Some(manifest) = fs::read_to_string(&mp)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .filter(|v| v.is_object())
        else {
            continue;
        };
        out.push((id, manifest));
    }
    out
}

/// Enable/disable one id in community-plugins.json. Order is kept, unknown
/// entries round-trip, a file that is not a JSON array is refused, never
/// overwritten. Creates `.obsidian` if missing.
pub fn set_enabled(root: &Path, id: &str, on: bool) -> Result<Vec<String>, String> {
    if !valid_id(id) {
        return Err("bad plugin id".into());
    }
    let obs = obsidian_dir(root, true)?;
    let p = obs.join(ENABLED_FILE);
    let mut list: Vec<serde_json::Value> = match fs::symlink_metadata(&p) {
        Err(_) => Vec::new(),
        Ok(m) if !m.is_file() || m.len() > MAX_ENABLED_FILE => {
            return Err(format!("{ENABLED_FILE}: not a plain file"))
        }
        Ok(_) => {
            let s = fs::read_to_string(&p).map_err(|e| format!("{ENABLED_FILE}: {e}"))?;
            serde_json::from_str(&s)
                .map_err(|_| format!("{ENABLED_FILE}: not a JSON array, left untouched"))?
        }
    };
    let present = list.iter().any(|v| v.as_str() == Some(id));
    if on && !present {
        list.push(serde_json::Value::String(id.into()));
    } else if !on && present {
        list.retain(|v| v.as_str() != Some(id));
    } else {
        return Ok(enabled_ids(root));
    }
    let body = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    write_atomic(&obs, ENABLED_FILE, body.as_bytes())?;
    Ok(enabled_ids(root))
}

/// Plugin.loadData(): the raw data.json text, None when absent. Invalid JSON
/// is returned as None too (the file is left as is), like Obsidian's null.
pub fn read_data(root: &Path, id: &str) -> Result<Option<String>, String> {
    match plugin_file_in(root, id, "data.json", MAX_DATA_JSON)? {
        None => Ok(None),
        Some(p) => {
            let b = fs::read(&p).map_err(|e| format!("{id}/data.json: {e}"))?;
            if serde_json::from_slice::<serde_json::Value>(&b).is_err() {
                return Ok(None);
            }
            Ok(String::from_utf8(b).ok())
        }
    }
}

/// Plugin.saveData(): `json` must parse; stored pretty (2-space), atomic,
/// confined. An existing invalid data.json is first copied to
/// data.json.invalid so the save does not destroy the user's broken edit.
pub fn write_data(root: &Path, id: &str, json: &str) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("{id}/data.json: invalid JSON ({e})"))?;
    let body = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    if body.len() as u64 > MAX_DATA_JSON {
        return Err(format!("{id}/data.json: too big"));
    }
    let dir = plugin_dir_in(root, id).ok_or("plugin dir not confined")?;
    if let Some(p) = plugin_file_in(root, id, "data.json", MAX_DATA_JSON)? {
        let old = fs::read(&p).map_err(|e| format!("{id}/data.json: {e}"))?;
        if serde_json::from_slice::<serde_json::Value>(&old).is_err() {
            write_atomic(&dir, "data.json.invalid", &old)?;
        }
    }
    write_atomic(&dir, "data.json", body.as_bytes())
}

/// The plugin's manifest.json text.
pub fn read_manifest(root: &Path, id: &str) -> Result<String, String> {
    match plugin_file_in(root, id, "manifest.json", MAX_MANIFEST)? {
        None => Err(format!("{id}: no manifest.json")),
        Some(p) => fs::read_to_string(&p).map_err(|e| format!("{id}/manifest.json: {e}")),
    }
}

/// styles.css, sanitized; None = no styles.css.
pub fn read_styles(root: &Path, id: &str) -> Result<Option<String>, String> {
    match plugin_file_in(root, id, "styles.css", MAX_STYLES)? {
        None => Ok(None),
        Some(p) => {
            let src = fs::read(&p).map_err(|e| format!("{id}/styles.css: {e}"))?;
            Ok(Some(sanitize_css(&String::from_utf8_lossy(&src))))
        }
    }
}

/// Strict stripping, no CSS parser: drops `@import` statements, `url(...)`
/// whose target is a script scheme, `expression(...)`, `behavior:` and
/// `-moz-binding:` declarations, and anything that could close the host
/// `<style>` element. CSS comments are removed first so keywords cannot hide
/// inside them. Plugin CSS is otherwise passed through.
pub fn sanitize_css(src: &str) -> String {
    // 1. strip comments
    let mut nc = String::with_capacity(src.len());
    let mut rest = src;
    while let Some(i) = rest.find("/*") {
        nc.push_str(&rest[..i]);
        match rest[i + 2..].find("*/") {
            Some(j) => rest = &rest[i + 2 + j + 2..],
            None => {
                rest = "";
                break;
            }
        }
    }
    nc.push_str(rest);
    // 2. drop @import statements (to the next `;` or newline)
    let mut out = String::with_capacity(nc.len());
    let lower = nc.to_ascii_lowercase();
    let mut i = 0;
    while i < nc.len() {
        if lower[i..].starts_with("@import") {
            let end = nc[i..]
                .find([';', '\n'])
                .map(|e| i + e + 1)
                .unwrap_or(nc.len());
            i = end;
            continue;
        }
        let ch = nc[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    // 3. neutralise dangerous functions/declarations, one statement at a time. Minified
    //    stylesheets (Tailwind builds) are a single line, so dropping whole lines would delete
    //    them entirely (`scroll-behavior:` alone would trip a `behavior:` check).
    let mut cleaned = String::with_capacity(out.len());
    let mut seg_start = 0;
    for (i, ch) in out.char_indices() {
        if matches!(ch, ';' | '{' | '}' | '\n') {
            let seg = &out[seg_start..i];
            if !css_segment_is_bad(seg) {
                cleaned.push_str(seg);
            }
            cleaned.push(ch); // delimiters stay: braces stay balanced, line count stays stable
            seg_start = i + ch.len_utf8();
        }
    }
    let tail = &out[seg_start..];
    if !css_segment_is_bad(tail) {
        cleaned.push_str(tail);
    }
    cleaned
}

/// True for a statement (text between `;`, braces and newlines) that carries a script vector.
/// `behavior` only counts as a property name, so `scroll-behavior` is fine.
fn css_segment_is_bad(seg: &str) -> bool {
    let l = css_unescape(seg)
        .to_ascii_lowercase()
        .replace([' ', '\t', '\r'], "");
    l.contains("expression(")
        || l.contains("javascript:")
        || l.contains("vbscript:")
        || l.starts_with("behavior:")
        || l.contains("-moz-binding")
        || l.contains("</style")
}

/// Decode CSS escapes (`\65 ` hex or `\c`) so keyword checks cannot be dodged.
fn css_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let mut hex = String::new();
        while hex.len() < 6 && it.peek().is_some_and(|d| d.is_ascii_hexdigit()) {
            hex.push(it.next().unwrap());
        }
        if hex.is_empty() {
            if let Some(n) = it.next() {
                out.push(n);
            }
        } else {
            if let Some(ch) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                out.push(ch);
            }
            if it.peek().is_some_and(|d| d.is_whitespace()) {
                it.next();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        fs::create_dir_all(root.join(".obsidian/plugins/good")).unwrap();
        fs::write(
            root.join(".obsidian/plugins/good/main.js"),
            "\"use strict\";module.exports=1;//end",
        )
        .unwrap();
        fs::write(
            root.join(".obsidian/community-plugins.json"),
            r#"["good","gone","sneaky","linkdir"]"#,
        )
        .unwrap();
        fs::write(root.join("secret.md"), "SECRET").unwrap();
        t
    }

    fn js(s: Served) -> String {
        match s {
            Served::Js(b) => String::from_utf8(b).unwrap(),
            o => panic!("expected js, got {o:?}"),
        }
    }

    #[test]
    fn serves_enabled_main_js_wrapped() {
        let t = vault();
        let out = js(serve(Some(t.path()), "/good/main.js", true));
        assert!(out.starts_with(";(function(){var d=window.__writerPluginDefine;"));
        assert!(out.contains("d(\"good\",function(module,exports,require,process,global,Buffer,Error,__filename,__dirname,SharedArrayBuffer,fetch){\"use strict\";module.exports=1;//end\n});"));
        assert!(out.ends_with("//# sourceURL=writer-plugin://localhost/good/main.js\n"));
    }

    #[test]
    fn untrusted_serves_nothing() {
        let t = vault();
        assert_eq!(
            serve(Some(t.path()), "/good/main.js", false),
            Served::Refused("restricted mode")
        );
    }

    #[test]
    fn unlisted_refused_and_missing_is_404() {
        let t = vault();
        let r = t.path();
        fs::create_dir_all(r.join(".obsidian/plugins/off")).unwrap();
        fs::write(r.join(".obsidian/plugins/off/main.js"), "x").unwrap();
        assert_eq!(
            serve(Some(r), "/off/main.js", true),
            Served::Refused("not enabled")
        );
        fs::create_dir_all(r.join(".obsidian/plugins/gone")).unwrap();
        assert_eq!(serve(Some(r), "/gone/main.js", true), Served::Missing);
        assert_eq!(
            serve(None, "/good/main.js", true),
            Served::Refused("no vault")
        );
    }

    #[test]
    fn traversal_and_odd_paths_refused() {
        let t = vault();
        for p in [
            "/../secret.md",
            "/good/../../../secret.md",
            "/good/../main.js",
            "/../good/main.js",
            "/good/manifest.json",
            "/good/data.json",
            "/good/sub/main.js",
            "/good//main.js",
            "/%2e%2e/main.js",
            "/good%2fmain.js",
            "/.obsidian/main.js",
            "/./main.js",
            "//etc/passwd",
            "good/main.js",
            "",
            "/",
            "/good/",
            "/good/main.js/",
            "/a..b/main.js",
            "/go od/main.js",
        ] {
            match serve(Some(t.path()), p, true) {
                Served::Refused(_) => {}
                o => panic!("{p:?} must be refused, got {o:?}"),
            }
        }
        assert_eq!(parse_path("/good/main.js"), Some("good"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_refused() {
        use std::os::unix::fs::symlink;
        let t = vault();
        let r = t.path();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("main.js"), "OUTSIDE").unwrap();
        symlink(outside.path(), r.join(".obsidian/plugins/linkdir")).unwrap();
        assert!(matches!(
            serve(Some(r), "/linkdir/main.js", true),
            Served::Refused(_)
        ));
        fs::create_dir_all(r.join(".obsidian/plugins/sneaky")).unwrap();
        symlink(
            r.join("secret.md"),
            r.join(".obsidian/plugins/sneaky/main.js"),
        )
        .unwrap();
        assert_eq!(
            serve(Some(r), "/sneaky/main.js", true),
            Served::Refused("symlinked file")
        );
        // whole plugins dir pointing out of the vault
        let t2 = vault();
        fs::remove_dir_all(t2.path().join(".obsidian/plugins")).unwrap();
        fs::create_dir_all(outside.path().join("good")).unwrap();
        fs::write(outside.path().join("good/main.js"), "OUTSIDE").unwrap();
        symlink(outside.path(), t2.path().join(".obsidian/plugins")).unwrap();
        assert!(matches!(
            serve(Some(t2.path()), "/good/main.js", true),
            Served::Refused(_)
        ));
    }

    #[test]
    fn oversize_and_non_file_refused() {
        let t = vault();
        let r = t.path();
        fs::create_dir_all(r.join(".obsidian/plugins/sneaky/main.js")).unwrap();
        assert!(matches!(
            serve(Some(r), "/sneaky/main.js", true),
            Served::Refused("not a file")
        ));
        assert!(matches!(
            plugin_file_in(r, "good", "main.js", 3),
            Err("too big")
        ));
    }

    #[test]
    fn ids_and_enabled_list() {
        for ok in ["sample-plugin", "cmdr", "obsidian_x.y", "A1"] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in [
            "",
            ".",
            "..",
            ".h",
            "a/b",
            "a\\b",
            "a b",
            "a..b",
            "é",
            &"x".repeat(129),
        ] {
            assert!(!valid_id(bad), "{bad}");
        }
        let t = vault();
        let r = t.path();
        fs::write(
            r.join(".obsidian/community-plugins.json"),
            r#"["good", "../x", 3, "ok-2"]"#,
        )
        .unwrap();
        assert_eq!(enabled_ids(r), vec!["good".to_string(), "ok-2".to_string()]);
        fs::write(r.join(".obsidian/community-plugins.json"), "not json").unwrap();
        assert!(enabled_ids(r).is_empty());
    }

    #[test]
    fn set_enabled_round_trips_and_refuses_garbage() {
        let t = vault();
        let r = t.path();
        assert_eq!(
            set_enabled(r, "new-one", true).unwrap(),
            vec!["good", "gone", "sneaky", "linkdir", "new-one"]
        );
        // idempotent
        assert_eq!(set_enabled(r, "new-one", true).unwrap().len(), 5);
        assert_eq!(
            set_enabled(r, "gone", false).unwrap(),
            vec!["good", "sneaky", "linkdir", "new-one"]
        );
        assert!(set_enabled(r, "../x", true).is_err());
        let f = r.join(".obsidian/community-plugins.json");
        fs::write(&f, "{\"not\":\"array\"}").unwrap();
        assert!(set_enabled(r, "good", true).is_err());
        assert_eq!(fs::read_to_string(&f).unwrap(), "{\"not\":\"array\"}");
        fs::remove_file(&f).unwrap();
        assert_eq!(set_enabled(r, "good", true).unwrap(), vec!["good"]);
    }

    #[test]
    fn set_enabled_creates_obsidian_dir() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(set_enabled(t.path(), "p", true).unwrap(), vec!["p"]);
        assert!(t.path().join(".obsidian/community-plugins.json").is_file());
    }

    #[test]
    fn data_json_roundtrip_and_invalid_kept() {
        let t = vault();
        let r = t.path();
        assert_eq!(read_data(r, "good").unwrap(), None);
        write_data(r, "good", r#"{"a":1}"#).unwrap();
        let got = read_data(r, "good").unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&got).unwrap(),
            serde_json::json!({"a": 1})
        );
        let f = r.join(".obsidian/plugins/good/data.json");
        fs::write(&f, b"{\"k\": \"\xc3").unwrap();
        assert_eq!(read_data(r, "good").unwrap(), None);
        write_data(r, "good", r#"{"d":2}"#).unwrap();
        assert_eq!(
            fs::read(r.join(".obsidian/plugins/good/data.json.invalid")).unwrap(),
            b"{\"k\": \"\xc3"
        );
        assert!(write_data(r, "good", "not json").is_err());
        for bad in ["..", "../good", "a/b", ".obsidian", "nosuch"] {
            assert!(write_data(r, bad, "1").is_err(), "{bad}");
            assert!(read_data(r, bad).is_err(), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn data_json_symlink_refused() {
        let t = vault();
        let r = t.path();
        std::os::unix::fs::symlink(
            r.join("secret.md"),
            r.join(".obsidian/plugins/good/data.json"),
        )
        .unwrap();
        assert!(read_data(r, "good").is_err());
        assert!(write_data(r, "good", "{}").is_err());
        assert_eq!(fs::read_to_string(r.join("secret.md")).unwrap(), "SECRET");
    }

    #[test]
    fn trust_defaults_off_and_persists() {
        let t = vault();
        let cfgdir = tempfile::tempdir().unwrap();
        let f = cfgdir.path().join("sub/plugins_trust.json");
        assert!(!is_trusted(&f, t.path()));
        set_trusted(&f, t.path(), true).unwrap();
        assert!(is_trusted(&f, t.path()));
        set_trusted(&f, t.path(), false).unwrap();
        assert!(!is_trusted(&f, t.path()));
        fs::write(&f, r#"{"x":"yes"}"#).unwrap();
        assert!(!is_trusted(&f, t.path()));
    }

    #[test]
    fn installed_lists_manifests() {
        let t = vault();
        let r = t.path();
        fs::write(
            r.join(".obsidian/plugins/good/manifest.json"),
            r#"{"id":"good","name":"Good","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::create_dir_all(r.join(".obsidian/plugins/badmani")).unwrap();
        fs::write(r.join(".obsidian/plugins/badmani/manifest.json"), "[1]").unwrap();
        let l = installed(r);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].0, "good");
        assert_eq!(l[0].1["name"], "Good");
    }

    #[test]
    fn css_sanitizer() {
        let css = "@import url(https://evil/x.css);\n.a{color:red}\n.b{background:url(javascript:alert(1))}\n.c{width:expression(alert(1))}\n.d{color:blue}/* ok */\n.e{b\\65havior:url(x)}";
        let out = sanitize_css(css);
        assert!(out.contains(".a{color:red}"));
        assert!(out.contains(".d{color:blue}"));
        assert!(!out.contains("import"));
        assert!(!out.contains("javascript"));
        assert!(!out.contains("expression"));
        assert!(!out.to_lowercase().contains("behavior"));
    }

    #[test]
    fn css_sanitizer_keeps_minified_sheets() {
        // One line, with `scroll-behavior` (a legitimate property) next to a hostile declaration.
        let css = "html{scroll-behavior:smooth}.a{color:red;behavior:url(x);width:1px}.b{background:url(javascript:1)}.c{margin:0}";
        let out = sanitize_css(css);
        assert!(out.contains("scroll-behavior:smooth"));
        assert!(out.contains(".a{color:red;"));
        assert!(out.contains("width:1px"));
        assert!(out.contains(".c{margin:0}"));
        assert!(!out.contains("behavior:url"));
        assert!(!out.contains("javascript"));
        assert_eq!(
            out.matches('{').count(),
            out.matches('}').count(),
            "braces stay balanced"
        );
    }
}
