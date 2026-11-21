//! The managed block of the vault's `.gitignore` (spec "What is synced"): Writer owns only the
//! lines between `# writer:begin` and `# writer:end`; the user's own lines are never touched.
//! Pure text in, text out ([`apply`]), so it is idempotent by construction; [`ensure`] is the one
//! file write.

use std::io;
use std::path::Path;

pub const BEGIN: &str = "# writer:begin";
pub const END: &str = "# writer:end";

/// Device-local state that never syncs.
pub const LINES: &[&str] = &[
    ".obsidian/workspace*.json",
    ".obsidian/cache",
    ".writer/index/",
    ".writer/cache/",
    ".writer/git/",
    ".trash/",
    "node_modules/",
    ".DS_Store",
    "Thumbs.db",
];

/// The "Never sync this plugin" lines inside the block (`.obsidian/plugins/<id>/data.json`): kept
/// when the block is rewritten; any other line in it is Writer's and is replaced.
fn extras(existing: &str) -> Vec<String> {
    let mut inside = false;
    let mut out = Vec::new();
    for l in existing.lines() {
        let t = l.trim_end();
        if t == BEGIN {
            inside = true;
        } else if t == END {
            break;
        } else if inside && t.starts_with(".obsidian/plugins/") && t.ends_with("/data.json") {
            out.push(t.to_string());
        }
    }
    out
}

fn block(extra: &[String]) -> String {
    let mut out = format!("{BEGIN}\n");
    for l in LINES {
        out.push_str(l);
        out.push('\n');
    }
    for l in extra {
        out.push_str(l);
        out.push('\n');
    }
    out.push_str(END);
    out.push('\n');
    out
}

/// `existing` with the managed block present and current: replaced in place when there is one,
/// appended (after a blank line) when there is not. Every other line is byte for byte as it was.
pub fn apply(existing: &str) -> String {
    let wanted = block(&extras(existing));
    let lines: Vec<&str> = existing.split_inclusive('\n').collect();
    let begin = lines.iter().position(|l| l.trim_end() == BEGIN);
    let end = begin.and_then(|b| {
        lines[b..]
            .iter()
            .position(|l| l.trim_end() == END)
            .map(|e| b + e)
    });
    match (begin, end) {
        (Some(b), Some(e)) => {
            let mut out: String = lines[..b].concat();
            out.push_str(&wanted);
            out.push_str(&lines[e + 1..].concat());
            out
        }
        _ => {
            let mut out = existing.to_string();
            if !out.is_empty() {
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push('\n');
            }
            out.push_str(&wanted);
            out
        }
    }
}

/// Adds `line` to the managed block (once). The block is written first when the file has none.
pub fn add_line(root: &Path, line: &str) -> io::Result<()> {
    let path = root.join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let current = apply(&existing);
    if extras(&current).iter().any(|l| l == line) {
        return if current == existing {
            Ok(())
        } else {
            std::fs::write(&path, current)
        };
    }
    let lines: Vec<&str> = current.split_inclusive('\n').collect();
    let end = lines
        .iter()
        .position(|l| l.trim_end() == END)
        .unwrap_or(lines.len());
    let mut out: String = lines[..end].concat();
    out.push_str(line);
    out.push('\n');
    out.push_str(&lines[end..].concat());
    std::fs::write(path, out)
}

/// Does the file hold the block, whatever its lines?
pub fn has_block(text: &str) -> bool {
    text.lines().any(|l| l.trim_end() == BEGIN) && text.lines().any(|l| l.trim_end() == END)
}

/// Writes the block into `<root>/.gitignore`; returns whether the file changed.
pub fn ensure(root: &Path) -> io::Result<bool> {
    let path = root.join(".gitignore");
    let existing = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let updated = apply(&existing);
    if updated == existing {
        return Ok(false);
    }
    std::fs::write(&path, updated)?;
    Ok(true)
}

/// Is a vault-relative path device-local state, one the managed block ignores? The cadence uses
/// it so a write to `.obsidian/workspace.json` (rewritten all the time) never resets the quiet
/// timer. A small matcher for the shapes in [`LINES`], not a gitignore engine.
pub fn device_local(rel: &str) -> bool {
    if rel == ".git" || rel.starts_with(".git/") {
        return true;
    }
    LINES.iter().any(|p| matches(p, rel))
}

fn matches(pattern: &str, rel: &str) -> bool {
    if let Some(dir) = pattern.strip_suffix('/') {
        return rel == dir || rel.starts_with(pattern);
    }
    if let Some((head, tail)) = pattern.split_once('*') {
        return rel.starts_with(head) && rel.ends_with(tail) && !rel[head.len()..].contains('/');
    }
    if !pattern.contains('/') {
        return rel.rsplit('/').next() == Some(pattern);
    }
    rel == pattern || rel.starts_with(&format!("{pattern}/"))
}
