//! The boundary of the tool table (spec `SPECs/opencode-backend-spec.md` section 11, phase 1):
//! outside the three places that own Claude's tools, the code of `agent/` spells no Claude tool
//! name, as a quoted literal or inside a prose constant. A tool is its row in the backend's table
//! (`shared/agent-tools/claude.json`, `tool_table.rs`), so a second backend is a second table,
//! never an edit of shared code. Test code is not scanned (it pins today's names on purpose).
//!
//! Exempt, and only these: the table itself (JSON, never scanned as Rust), `claude_stream.rs`
//! (Claude's protocol) and `claude_adapter.rs` (Claude's adapter). The web half has its own twin,
//! `features/agent/tests/agent-tool-boundary.test.ts`.

use std::path::{Path, PathBuf};

/// The Rust files that may spell Claude's tool names.
const EXEMPT: [&str; 2] = ["claude_stream.rs", "claude_adapter.rs"];

/// English that is not a tool name, by file and exact fragment. Listed one by one so a tool name
/// cannot hide behind a broad allowance.
const ENGLISH: [(&str, &str); 3] = [
    (
        "project.rs",
        "Instructions for the agent working in this project. Edit freely.",
    ),
    // "Read" and "LS" are plain English as well as tool names
    ("writer_prompt.rs", "Read notes before editing."),
    ("project_context.rs", "Read notes on demand;"),
];

/// Claude's table, the one list of the names to look for: every row's name, the `protocolOnly`
/// names (known to the protocol, no row) and the MCP prefix.
struct Names {
    tools: Vec<String>,
    prefix: String,
}

fn names() -> Names {
    let table: serde_json::Value =
        serde_json::from_str(include_str!("../../../shared/agent-tools/claude.json")).unwrap();
    let list = |key: &str| -> Vec<String> {
        table[key]
            .as_array()
            .unwrap_or_else(|| panic!("`{key}` is a list"))
            .iter()
            .map(|v| {
                v.as_str()
                    .unwrap_or_else(|| v["name"].as_str().unwrap())
                    .to_string()
            })
            .collect()
    };
    let mut tools = list("tools");
    tools.extend(list("protocolOnly"));
    Names {
        tools,
        prefix: table["mcp"]["serverPrefix"]
            .as_str()
            .unwrap()
            .replace("{server}", crate::cli::mcp::SERVER_NAME),
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether `text` holds `name` as a whole word.
fn has_word(text: &str, name: &str) -> bool {
    text.match_indices(name).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = text[i + name.len()..].chars().next();
        !before.is_some_and(is_word) && !after.is_some_and(is_word)
    })
}

/// The tool name a string literal holds, if any.
fn names_a_tool(names: &Names, text: &str) -> Option<String> {
    if text.contains(&names.prefix) {
        return Some(names.prefix.clone());
    }
    names.tools.iter().find(|n| has_word(text, n)).cloned()
}

/// One token of the scan: a string literal's content, or any other character.
#[derive(Debug, PartialEq)]
enum Tok {
    Str(usize, String),
    Ch(char),
}

/// Rust source as string literals and other characters, comments and char literals dropped.
fn lex(src: &str) -> Vec<Tok> {
    let c: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let (mut i, mut line) = (0usize, 1usize);
    let at = |i: usize, s: &str| {
        s.chars()
            .enumerate()
            .all(|(k, ch)| c.get(i + k) == Some(&ch))
    };
    while i < c.len() {
        match c[i] {
            '\n' => {
                line += 1;
                i += 1;
            }
            '/' if at(i, "//") => {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
            }
            '/' if at(i, "/*") => {
                let mut depth = 0;
                while i < c.len() {
                    if at(i, "/*") {
                        depth += 1;
                        i += 2;
                    } else if at(i, "*/") {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        if c[i] == '\n' {
                            line += 1;
                        }
                        i += 1;
                    }
                }
            }
            'r' | 'b' if raw_open(&c, i).is_some() => {
                let (open, hashes) = raw_open(&c, i).unwrap();
                let end: String = std::iter::once('"')
                    .chain(std::iter::repeat_n('#', hashes))
                    .collect();
                let start = open;
                let mut j = start;
                while j < c.len() && !at(j, &end) {
                    j += 1;
                }
                let text: String = c[start..j].iter().collect();
                out.push(Tok::Str(line, text.clone()));
                line += text.matches('\n').count();
                i = j + end.chars().count();
            }
            '"' => {
                let mut j = i + 1;
                while j < c.len() && c[j] != '"' {
                    if c[j] == '\\' {
                        j += 1;
                    }
                    j += 1;
                }
                let text: String = c[i + 1..j.min(c.len())].iter().collect();
                out.push(Tok::Str(line, text.clone()));
                line += text.matches('\n').count();
                i = j + 1;
            }
            '\'' => {
                // a char literal ('x', '\n', '\u{..}') or a lifetime ('a)
                let close = (i + 2..(i + 12).min(c.len())).find(|&j| c[j] == '\'');
                let is_char = match close {
                    Some(j) => c[i + 1] == '\\' || j == i + 2,
                    None => false,
                };
                if is_char {
                    i = close.unwrap() + 1;
                } else {
                    out.push(Tok::Ch('\''));
                    i += 1;
                }
            }
            ch => {
                out.push(Tok::Ch(ch));
                i += 1;
            }
        }
    }
    out
}

/// `r"`, `r#"`, `br"` ... at `i`: where the content starts and how many hashes close it.
fn raw_open(c: &[char], i: usize) -> Option<(usize, usize)> {
    let mut j = i;
    if c[j] == 'b' {
        j += 1;
    }
    if c.get(j) != Some(&'r') {
        return None;
    }
    if i > 0 && is_word(c[i - 1]) {
        return None;
    }
    j += 1;
    let mut hashes = 0;
    while c.get(j) == Some(&'#') {
        hashes += 1;
        j += 1;
    }
    (c.get(j) == Some(&'"')).then_some((j + 1, hashes))
}

/// The string literals of the code that is not test code: an item behind `#[cfg(test)]` (or
/// `#[cfg(all(test, ..))]`) is skipped whole.
fn production_strings(src: &str) -> Vec<(usize, String)> {
    let toks = lex(src);
    let chars: String = toks
        .iter()
        .map(|t| match t {
            Tok::Ch(c) => *c,
            Tok::Str(..) => '"',
        })
        .collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let rest = &chars[i..];
        if rest.starts_with("#[cfg(test)]") || rest.starts_with("#[cfg(all(test") {
            // skip the attribute, then the item: to its `;`, or through its first block
            let mut j = i + rest.find(']').unwrap() + 1;
            let mut depth = 0;
            while j < toks.len() {
                match &toks[j] {
                    Tok::Ch('{') => depth += 1,
                    Tok::Ch('}') => {
                        depth -= 1;
                        if depth == 0 {
                            j += 1;
                            break;
                        }
                    }
                    Tok::Ch(';') if depth == 0 => {
                        j += 1;
                        break;
                    }
                    _ => {}
                }
                j += 1;
            }
            i = j;
            continue;
        }
        if let Tok::Str(line, text) = &toks[i] {
            out.push((*line, text.clone()));
        }
        i += 1;
    }
    out
}

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if name != "fixtures" {
                sources(&path, out);
            }
        } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") && !EXEMPT.contains(&&*name)
        {
            out.push(path);
        }
    }
}

#[test]
fn no_claude_tool_name_in_shared_agent_code() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/agent");
    let mut files = Vec::new();
    sources(&dir, &mut files);
    assert!(files.len() > 30, "the scan found {} files", files.len());
    let names = names();
    let mut offenders = Vec::new();
    for file in &files {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let src = std::fs::read_to_string(file).unwrap();
        for (line, text) in production_strings(&src) {
            let english = ENGLISH
                .iter()
                .any(|(f, frag)| *f == name && text.contains(frag));
            if let (Some(tool), false) = (names_a_tool(&names, &text), english) {
                let shown: String = text.chars().take(70).collect();
                offenders.push(format!("{name}:{line} {tool}: {shown}"));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "a Claude tool name outside the table, the Claude mapper and the Claude adapter (read it \
         from the backend's `ToolTable`):\n{}",
        offenders.join("\n")
    );
}

#[test]
fn the_scan_sees_a_name_in_a_literal_or_a_prose_constant_and_skips_tests_and_comments() {
    let names = names();
    let src = r##"
        // "Bash" in a comment
        const A: &str = "Use Bash only when no tool fits.";
        const B: &str = r#"say "Edit" here"#;
        fn f() -> &'static str { "mcp__writer__search" }
        fn ok() -> &'static str { "Editor, Writer, a Bashful agent" }
        #[cfg(test)]
        mod tests { const T: &str = "Bash"; fn g() { let _ = '"'; } }
        #[cfg(all(test, unix))]
        mod more;
        const C: &str = "after the test module: Task";
    "##;
    let hits = production_strings(src)
        .iter()
        .filter(|(_, t)| names_a_tool(&names, t).is_some())
        .count();
    assert_eq!(hits, 4, "{:?}", production_strings(src));
    assert_eq!(
        names_a_tool(&names, "Editor, Writer, a Bashful agent"),
        None
    );
    assert_eq!(names_a_tool(&names, "run Bash").as_deref(), Some("Bash"));
}

#[test]
fn the_names_come_from_the_table_so_a_row_without_a_role_is_scanned_too() {
    let names = names();
    // rows that no role or kind list ever named, and protocol-only names
    for name in [
        "BashOutput",
        "KillShell",
        "WebFetch",
        "AskUserQuestion",
        "TodoWrite",
    ] {
        assert_eq!(
            names_a_tool(&names, &format!("a {name} call")).as_deref(),
            Some(name)
        );
    }
}
