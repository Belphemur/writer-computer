//! The Obsidian CLI argument grammar:
//! `writer [vault=<name|id|path>] <command> [param=value ...] [flag ...] [--copy]`.
//!
//! Parameters are `name=value` (the shell handles quoting; one pair of
//! surrounding quotes left in a value is stripped), flags are bare words, `\n`
//! and `\t` inside a value are a newline and a tab (`\\` is a backslash). A JSON-valued
//! parameter (`ParamSpec::json`, e.g. `spec=`) is the exception: it reaches its parser as written,
//! so JSON's own escapes (`\n` inside a string) are the only ones; `@<vault file>` and `-` (stdin)
//! stand for its text (resolved in `cli/mod.rs`).

use super::registry::CommandSpec;
use super::CliError;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Invocation {
    pub vault: Option<String>,
    pub command: String,
    pub params: Vec<(String, String)>,
    pub flags: Vec<String>,
    /// Bare words (only `help <command>` takes one).
    pub positional: Vec<String>,
    pub copy: bool,
    pub help: bool,
    /// `-` may read standard input: set by the command line, never by the MCP server (whose
    /// standard input is the protocol).
    pub stdin_allowed: bool,
}

/// Flags written with two dashes (`--launch`), not as a bare word. The parser knows only these
/// names; a spec still has to list the flag for the command to take it.
pub const LONG_FLAGS: &[&str] = &["launch"];

/// How a flag is written on the command line (help and the skill reference).
pub fn flag_display(name: &str) -> String {
    if LONG_FLAGS.contains(&name) {
        format!("--{name}")
    } else {
        name.to_string()
    }
}

/// Unescape `\n`, `\t` and `\\`; other backslashes stay literal.
pub fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('n') => {
                it.next();
                out.push('\n');
            }
            Some('t') => {
                it.next();
                out.push('\t');
            }
            Some('\\') => {
                it.next();
                out.push('\\');
            }
            _ => out.push('\\'),
        }
    }
    out
}

fn strip_quotes(v: &str) -> &str {
    let b = v.as_bytes();
    if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
        &v[1..v.len() - 1]
    } else {
        v
    }
}

fn param_name_ok(n: &str) -> bool {
    let mut c = n.chars();
    c.next().is_some_and(|f| f.is_ascii_alphabetic())
        && c.all(|x| x.is_ascii_alphanumeric() || x == '_' || x == '-')
}

/// Split a token into `(name, value)` when it is `name=value`.
fn as_param(tok: &str) -> Option<(&str, &str)> {
    let (n, v) = tok.split_once('=')?;
    param_name_ok(n).then_some((n, v))
}

/// Parse the command line (argv without the program name). Only the command
/// name and `vault=` are known here; parameter/flag validity is checked
/// against the command's spec by [`validate`].
pub fn parse(tokens: &[String]) -> Result<Invocation, CliError> {
    let mut inv = Invocation::default();
    let mut it = tokens.iter().peekable();
    if let Some(first) = it.peek() {
        if let Some(("vault", v)) = as_param(first) {
            let v = strip_quotes(&unescape(v)).to_string();
            if v.is_empty() {
                return Err(CliError::Usage("vault= needs a value".into()));
            }
            inv.vault = Some(v);
            it.next();
        }
    }
    let Some(cmd) = it.next() else {
        return Err(CliError::Usage("missing command".into()));
    };
    if cmd.contains('=') || cmd.starts_with('-') {
        return Err(CliError::Usage(format!(
            "expected a command, found \"{cmd}\" (vault= must come first, then the command)"
        )));
    }
    inv.command = cmd.clone();
    inv.stdin_allowed = true;
    let spec = super::registry::find(cmd);
    let is_json = |n: &str| spec.is_some_and(|s| s.params.iter().any(|p| p.name == n && p.json));
    for tok in it {
        if tok == "--copy" {
            inv.copy = true;
        } else if tok == "--help" || tok == "-h" {
            inv.help = true;
        } else if let Some((n, v)) = as_param(tok) {
            if n == "vault" {
                return Err(CliError::Usage(
                    "vault= must be the first argument, before the command".into(),
                ));
            }
            if inv.params.iter().any(|(k, _)| k == n) {
                return Err(CliError::Usage(format!("parameter {n}= given twice")));
            }
            let value = if is_json(n) {
                v.to_string()
            } else {
                strip_quotes(&unescape(v)).to_string()
            };
            inv.params.push((n.to_string(), value));
        } else if let Some(name) = tok.strip_prefix("--").filter(|n| LONG_FLAGS.contains(n)) {
            inv.flags.push(name.to_string());
        } else if tok.starts_with('-') {
            return Err(CliError::Usage(format!("unknown option {tok}")));
        } else if inv.command == "help" {
            inv.positional.push(tok.clone());
        } else {
            inv.flags.push(tok.clone());
        }
    }
    Ok(inv)
}

/// Parsed arguments of one command, validated against its spec.
#[derive(Debug, Clone, Default)]
pub struct Args {
    params: Vec<(String, String)>,
    flags: Vec<String>,
    pub positional: Vec<String>,
}

impl Args {
    pub fn new(params: Vec<(&str, &str)>, flags: Vec<&str>) -> Args {
        Args {
            params: params
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            flags: flags.into_iter().map(str::to_string).collect(),
            positional: Vec::new(),
        }
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// Replace (or add) a parameter's value: a JSON input resolved from `@file` or stdin.
    pub fn set(&mut self, name: &str, value: String) {
        match self.params.iter_mut().find(|(k, _)| k == name) {
            Some(slot) => slot.1 = value,
            None => self.params.push((name.to_string(), value)),
        }
    }

    pub fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }

    pub fn require(&self, name: &str) -> Result<&str, CliError> {
        self.get(name)
            .ok_or_else(|| CliError::Usage(format!("missing required parameter {name}=")))
    }

    /// `format=` checked against the formats the command lists.
    pub fn format(&self, spec: &CommandSpec) -> Result<String, CliError> {
        match self.get("format") {
            None => Ok(spec.default_format.unwrap_or("").to_string()),
            Some(f) if spec.formats.contains(&f) => Ok(f.to_string()),
            Some(f) => Err(CliError::Usage(format!(
                "unknown format \"{f}\" for {} (use {})",
                spec.name,
                spec.formats.join(", ")
            ))),
        }
    }
}

/// Check params and flags against `spec`.
pub fn validate(inv: &Invocation, spec: &CommandSpec) -> Result<Args, CliError> {
    for (k, _) in &inv.params {
        if !spec.params.iter().any(|p| p.name == k) {
            return Err(CliError::Usage(format!(
                "{} does not take {k}= (parameters: {})",
                spec.name,
                if spec.params.is_empty() {
                    "none".to_string()
                } else {
                    spec.params
                        .iter()
                        .map(|p| p.name)
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            )));
        }
    }
    for f in &inv.flags {
        if !spec.flags.iter().any(|(n, _)| n == f) {
            return Err(CliError::Usage(format!(
                "{} does not take the flag \"{f}\" (flags: {}); put values with spaces in quotes",
                spec.name,
                if spec.flags.is_empty() {
                    "none".to_string()
                } else {
                    spec.flags
                        .iter()
                        .map(|(n, _)| *n)
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            )));
        }
    }
    Ok(Args {
        params: inv.params.clone(),
        flags: inv.flags.clone(),
        positional: inv.positional.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn parses_vault_command_params_flags() {
        let i = parse(&t("vault=Notes files folder=a ext=md total --copy")).unwrap();
        assert_eq!(i.vault.as_deref(), Some("Notes"));
        assert_eq!(i.command, "files");
        assert_eq!(
            i.params,
            vec![("folder".into(), "a".into()), ("ext".into(), "md".into())]
        );
        assert_eq!(i.flags, vec!["total"]);
        assert!(i.copy);
    }

    #[test]
    fn vault_must_be_first_and_command_must_follow() {
        assert!(parse(&t("files vault=x")).is_err());
        assert!(parse(&t("folder=a files")).is_err());
        assert!(parse(&t("vault=x")).is_err());
        assert!(parse(&[]).is_err());
        assert!(parse(&t("files --nope")).is_err());
        assert!(parse(&t("files a=1 a=2")).is_err());
    }

    #[test]
    fn values_keep_spaces_equals_and_escapes() {
        let tokens = vec![
            "create".to_string(),
            "content=Hello world\\nline2\\tTab = x".to_string(),
            "name=\"Quoted Name\"".to_string(),
        ];
        let i = parse(&tokens).unwrap();
        assert_eq!(i.params[0].1, "Hello world\nline2\tTab = x");
        assert_eq!(i.params[1].1, "Quoted Name");
        assert_eq!(unescape("a\\\\nb"), "a\\nb");
        assert_eq!(unescape("C:\\dir"), "C:\\dir");
    }

    #[test]
    fn a_json_parameter_reaches_the_parser_as_written() {
        let tokens = vec![
            "excalidraw:create".to_string(),
            "path=A".to_string(),
            r#"spec={"nodes":[{"id":"a","text":"one\ntwo C:\\x"}]}"#.to_string(),
        ];
        let i = parse(&tokens).unwrap();
        assert_eq!(
            i.params[1].1,
            r#"{"nodes":[{"id":"a","text":"one\ntwo C:\\x"}]}"#
        );
        serde_json::from_str::<serde_json::Value>(&i.params[1].1).unwrap();
        // the same text in an ordinary parameter is unescaped, and the line is not a JSON read
        let plain = parse(&["create".into(), r"content=a\nb".into()]).unwrap();
        assert_eq!(plain.params[0].1, "a\nb");
        assert!(i.stdin_allowed);
    }

    #[test]
    fn help_takes_a_positional_command() {
        let i = parse(&t("help base:query")).unwrap();
        assert_eq!(i.positional, vec!["base:query"]);
        assert!(parse(&t("files --help")).unwrap().help);
    }

    #[test]
    fn status_values_such_as_question_mark_survive() {
        let i = parse(&["tasks".into(), "status=?".into(), "todo".into()]).unwrap();
        assert_eq!(i.params[0].1, "?");
        assert_eq!(i.flags, vec!["todo"]);
        let i = parse(&["tasks".into(), "status= ".into()]).unwrap();
        assert_eq!(i.params[0].1, " ");
    }
}
