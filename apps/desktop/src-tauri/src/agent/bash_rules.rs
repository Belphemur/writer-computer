//! Prefix rules Writer proposes for a shell call the CLI offered no "Always allow" rule for
//! (ADR 2026-11-17 addendum "Writer proposes prefix rules when the CLI sends none", spec 6.2).
//! Pure and Tauri-free: [`propose`] reads the command text only, [`with_proposals`] is the one
//! seam the stream mapper calls. The shell tool is the one the backend's table gives the
//! `shell` role (`tool_table.rs`); its rules are named by that tool.
//!
//! The command is split on `;`, `&&`, `||`, `|`, `&` and newlines, outside quotes. Each segment
//! becomes `<program> <subcommand>:*` (the program as written, absolute path included, because
//! the CLI matches rule text literally; the subcommand is the first word that is not a flag and reads like a
//! subcommand (`status`, `get-caller-identity`; two words for `aws`, `gcloud`, `az`, `gh`, `oci`),
//! else the program alone (`ls /tmp` is `ls:*`, `curl https://x` is `curl:*`);
//! leading `VAR=value` assignments are dropped). Decisions:
//!
//! - A segment that is only assignments (`P=x`) or `cd` needs no rule; neither refuses the rest.
//! - Arguments after the subcommand never matter (`:*`), so `$P` as an argument is fine; `$P` as
//!   the program or where the subcommand would be is unknown text and refuses.
//! - Read-only filters (`head`, `tail`, `grep`, `wc`, `sort`, `uniq`, `cut`, `jq`) need no rule.
//! - One refused segment refuses every prefix rule (a rule set that does not cover the whole
//!   command would only half-work); the card then offers "This exact command" alone. Refused:
//!   `$(...)`, backticks, `(...)` groups, `<<`, process substitution, a redirection to a file
//!   (`2>&1`, `>&2`, `>/dev/null` are fine), and programs that run other code from their
//!   arguments (shells, `eval`, `sudo`, `rm`, `exec`, `xargs`, `env`, `find`, interpreters, shell
//!   keywords): a prefix on those would allow far more than the user saw.

use super::tool_table::ToolTable;
use serde_json::{json, Value};

/// Read-only pipe filters: no rule, never a refusal.
const FILTERS: &[&str] = &["head", "tail", "grep", "wc", "sort", "uniq", "cut", "jq"];
/// Segments that are navigation, not a capability worth a rule.
const NO_RULE: &[&str] = &["cd"];
/// Programs whose first word is not a subcommand but code or another program to run.
const REFUSED_PROGRAMS: &[&str] = &[
    "eval",
    "sudo",
    "su",
    "doas",
    "rm",
    "exec",
    "source",
    ".",
    "xargs",
    "env",
    "command",
    "builtin",
    "nohup",
    "time",
    "find",
    "sh",
    "bash",
    "zsh",
    "dash",
    "fish",
    "ksh",
    "csh",
    "tcsh",
    "python",
    "node",
    "perl",
    "ruby",
    "php",
    "deno",
    "bun",
    "awk",
    "gawk",
    "osascript",
    "for",
    "while",
    "until",
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "do",
    "done",
    "case",
    "esac",
    "select",
    "function",
    "{",
    "}",
    "[[",
    "!",
];

/// CLIs whose operation is two words (`aws sts get-caller-identity`).
const TWO_LEVEL: &[&str] = &["aws", "gcloud", "az", "gh", "oci"];

/// What the card can offer for one command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashProposal {
    /// `ruleContent` strings (`aws sts get-caller-identity:*`), empty when refused or when the
    /// command needs no rule.
    pub prefixes: Vec<String>,
    /// The whole command, always offered.
    pub exact: String,
}

pub fn propose(command: &str) -> BashProposal {
    BashProposal {
        prefixes: prefix_rules(command).unwrap_or_default(),
        exact: command.trim().to_string(),
    }
}

fn prefix_rules(command: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for words in split(command)? {
        if let Some(rule) = rule_for(&words)? {
            if !out.contains(&rule) {
                out.push(rule);
            }
        }
    }
    Some(out)
}

/// `Some(None)` no rule needed, `Some(Some(rule))`, `None` refused.
fn rule_for(words: &[String]) -> Option<Option<String>> {
    let start = words.iter().take_while(|w| is_assignment(w)).count();
    let Some(program) = words.get(start) else {
        return Some(None);
    };
    if program.contains('$') {
        return None;
    }
    let base = program.rsplit('/').next().unwrap_or(program);
    if FILTERS.contains(&base) || NO_RULE.contains(&base) {
        return Some(None);
    }
    // python3.11 -> python
    let family = base.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    if REFUSED_PROGRAMS.contains(&base) || REFUSED_PROGRAMS.contains(&family) {
        return None;
    }
    let mut rule = program.clone();
    let operands = words[start + 1..].iter().filter(|w| !w.starts_with('-'));
    // every pass either takes the word or leaves the loop, so `taken` is the index
    for (taken, w) in operands.enumerate() {
        if taken == subcommand_depth(base) {
            break; // the rest are arguments and do not matter
        }
        if w.contains(['$', '*', '?', '[']) {
            return None; // unknown text where a subcommand would be
        }
        if !is_subcommand(w) {
            break; // a path, URL or KEY=value: an argument, not a subcommand
        }
        rule.push(' ');
        rule.push_str(w);
    }
    rule.push_str(":*");
    Some(Some(rule))
}

/// How many words name the operation: `aws sts get-caller-identity`, `gh pr view`, but
/// `git status`.
fn subcommand_depth(program: &str) -> usize {
    if TWO_LEVEL.contains(&program) {
        2
    } else {
        1
    }
}

/// `status`, `get-caller-identity`, `s3:ls`: not a path, a URL, `KEY=value` or other text.
fn is_subcommand(word: &str) -> bool {
    word.chars().next().is_some_and(char::is_alphanumeric)
        && word
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '@' | '+'))
}

fn is_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// How the word after a redirection operator is judged.
#[derive(Clone, Copy)]
enum Redirect {
    /// `>` / `>>` (`amp`: `>&`, the target may be a descriptor).
    Out { amp: bool },
    /// `<` (reading is harmless).
    In,
}

struct Scanner {
    segments: Vec<Vec<String>>,
    words: Vec<String>,
    cur: String,
    in_word: bool,
    pending: Option<Redirect>,
    refused: bool,
}

impl Scanner {
    fn push_char(&mut self, c: char) {
        self.cur.push(c);
        self.in_word = true;
    }

    fn end_word(&mut self) {
        if !self.in_word {
            return;
        }
        let text = std::mem::take(&mut self.cur);
        self.in_word = false;
        match self.pending.take() {
            None => self.words.push(text),
            Some(Redirect::In) => {}
            Some(Redirect::Out { amp }) => {
                let fd = amp && (text == "1" || text == "2");
                if text != "/dev/null" && !fd {
                    self.refused = true;
                }
            }
        }
    }

    fn end_segment(&mut self) {
        self.end_word();
        if self.pending.take().is_some() {
            self.refused = true; // `echo >` with no target
        }
        if !self.words.is_empty() {
            self.segments.push(std::mem::take(&mut self.words));
        }
    }

    /// An unquoted `>` or `<`: a leading all-digit word is the descriptor (`2>&1`), not an
    /// argument.
    fn redirect(&mut self, op: char, chars: &mut std::iter::Peekable<std::str::Chars>) {
        if self.in_word && !self.cur.is_empty() && self.cur.chars().all(|c| c.is_ascii_digit()) {
            self.cur.clear();
            self.in_word = false;
        } else {
            self.end_word();
        }
        if self.pending.take().is_some() {
            self.refused = true; // `> >`
        }
        if op == '<' {
            match chars.peek() {
                Some('<') | Some('(') => self.refused = true, // heredoc, here-string, <(...)
                Some('&') => {
                    chars.next();
                }
                _ => {}
            }
            self.pending = Some(Redirect::In);
            return;
        }
        let mut amp = false;
        match chars.peek() {
            Some('(') => self.refused = true, // >(...)
            Some('>') | Some('|') => {
                chars.next();
            }
            Some('&') => {
                chars.next();
                amp = true;
            }
            _ => {}
        }
        self.pending = Some(Redirect::Out { amp });
    }
}

/// Quote-aware split into segments of unquoted words. `None` when the command cannot be read
/// safely (expansion, grouping, a file redirection, an unterminated quote).
fn split(command: &str) -> Option<Vec<Vec<String>>> {
    let mut s = Scanner {
        segments: Vec::new(),
        words: Vec::new(),
        cur: String::new(),
        in_word: false,
        pending: None,
        refused: false,
    };
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\n' | ';' => s.end_segment(),
            c if c.is_whitespace() => s.end_word(),
            '&' => match chars.peek() {
                Some('&') => {
                    chars.next();
                    s.end_segment();
                }
                // `&>/dev/null`: the `&` belongs to the redirection
                Some('>') => s.end_word(),
                _ => s.end_segment(),
            },
            '|' => {
                if matches!(chars.peek(), Some('|') | Some('&')) {
                    chars.next();
                }
                s.end_segment();
            }
            '>' | '<' => s.redirect(c, &mut chars),
            '(' | ')' | '`' => return None,
            '#' if !s.in_word => {
                // a comment runs to the end of the line
                for n in chars.by_ref() {
                    if n == '\n' {
                        s.end_segment();
                        break;
                    }
                }
            }
            '\\' => match chars.next() {
                Some('\n') | None => {}
                Some(n) => s.push_char(n),
            },
            '\'' => {
                s.in_word = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        n => s.cur.push(n),
                    }
                }
            }
            '"' => {
                s.in_word = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '`' => return None,
                        '$' if chars.peek() == Some(&'(') => return None,
                        '\\' => match chars.next()? {
                            n @ ('"' | '\\' | '$' | '`') => s.cur.push(n),
                            n => {
                                s.cur.push('\\');
                                s.cur.push(n);
                            }
                        },
                        n => s.cur.push(n),
                    }
                }
            }
            c => s.push_char(c),
        }
        if s.refused {
            return None;
        }
    }
    s.end_segment();
    if s.refused {
        return None;
    }
    Some(s.segments)
}

fn is_allow_add_rules(s: &Value) -> bool {
    s.get("type").and_then(Value::as_str) == Some("addRules")
        && s.get("behavior").and_then(Value::as_str) != Some("deny")
}

fn add_rules(tool: &str, contents: &[String], proposal: &str) -> Value {
    json!({
        "type": "addRules",
        "behavior": "allow",
        "rules": contents.iter()
            .map(|c| json!({"toolName": tool, "ruleContent": c}))
            .collect::<Vec<_>>(),
        // Writer's own, not the CLI's: the card labels it, `updated_permissions` strips it
        "proposal": proposal,
    })
}

/// The suggestions of a permission request: the backend's own, unchanged, when it sent an
/// `addRules` one (or the tool is not the shell of `tools`); otherwise those plus Writer's
/// proposal (`proposal: "prefix"` for the prefix rules when there are any, `proposal: "exact"` for
/// the whole command). The command is the shell tool's primary argument.
pub fn with_proposals(
    tools: &ToolTable,
    tool: &str,
    input: &Value,
    mut suggestions: Vec<Value>,
) -> Vec<Value> {
    if !tools.is_shell(tool) || suggestions.iter().any(is_allow_add_rules) {
        return suggestions;
    }
    let Some(command) = tools
        .primary_keys(tool)
        .iter()
        .find_map(|k| input.get(k.as_str()).and_then(Value::as_str))
        .filter(|c| !c.trim().is_empty())
    else {
        return suggestions;
    };
    let p = propose(command);
    if !p.prefixes.is_empty() {
        suggestions.push(add_rules(tool, &p.prefixes, "prefix"));
    }
    suggestions.push(add_rules(tool, &[p.exact], "exact"));
    suggestions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(command: &str) -> Vec<String> {
        propose(command).prefixes
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_aws_example_from_the_decision() {
        let cmd = "P=sso-production-readonly; /opt/homebrew/bin/aws sts get-caller-identity --profile $P 2>&1 | head; /opt/homebrew/bin/aws ec2 describe-regions --profile $P --query 'Regions[].RegionName' --output text 2>&1 | head";
        let p = propose(cmd);
        assert_eq!(
            p.prefixes,
            strs(&[
                "/opt/homebrew/bin/aws sts get-caller-identity:*",
                "/opt/homebrew/bin/aws ec2 describe-regions:*"
            ])
        );
        assert_eq!(p.exact, cmd);
    }

    #[test]
    fn table_of_prefixes() {
        let cases: &[(&str, &[&str])] = &[
            ("ls", &["ls:*"]),
            ("ls -la /tmp", &["ls:*"]),
            ("git status", &["git status:*"]),
            ("git -C repo status", &["git repo:*"]),
            (
                "git status && git diff --stat",
                &["git status:*", "git diff:*"],
            ),
            (
                "make build || make clean",
                &["make build:*", "make clean:*"],
            ),
            ("git status; git status", &["git status:*"]),
            ("npm test\nnpm run lint", &["npm test:*", "npm run:*"]),
            ("FOO=1 BAR=2 cargo test -p x", &["cargo test:*"]),
            ("/usr/bin/git log -n 3", &["/usr/bin/git log:*"]),
            ("cd /tmp && ls", &["ls:*"]),
            ("echo hi > /dev/null", &["echo hi:*"]),
            ("make 2>&1 | tail -5", &["make:*"]),
            ("make &>/dev/null", &["make:*"]),
            ("make >&2", &["make:*"]),
            ("cat < in.txt", &["cat:*"]),
            ("make build &", &["make build:*"]),
            ("make build # then ship\nls", &["make build:*", "ls:*"]),
            ("curl -s https://x.dev | jq .a", &["curl:*"]),
            ("aws --profile p s3 ls", &["aws p s3:*"]),
            (
                "aws sts get-caller-identity",
                &["aws sts get-caller-identity:*"],
            ),
            ("gh pr view 12 --json x", &["gh pr view:*"]),
            ("make X=1 build", &["make:*"]),
            (
                "ls | grep foo | sort | uniq | wc -l | head | cut -d, -f1",
                &["ls:*"],
            ),
        ];
        for (cmd, want) in cases {
            assert_eq!(rules(cmd), strs(want), "{cmd}");
        }
    }

    #[test]
    fn quotes_hide_separators_and_operators() {
        let cases: &[(&str, &[&str])] = &[
            (r#"echo "a; b && c | d" ; ls"#, &["echo:*", "ls:*"]),
            ("echo 'a > b' | wc", &["echo:*"]),
            (r#"echo "it's" && ls"#, &["echo:*", "ls:*"]),
            (r#"echo 'say "hi"; x' ; ls"#, &["echo:*", "ls:*"]),
            (r#"echo "a \" ; b" && ls"#, &["echo:*", "ls:*"]),
            (r"echo a\;b && ls", &["echo:*", "ls:*"]),
            // a quoted redirection operator is an argument
            (r#"echo ">" x"#, &["echo:*"]),
            // the quoted separator is not a second segment: one rule, not two
            ("git commit -m 'a; rm -rf x'", &["git commit:*"]),
        ];
        for (cmd, want) in cases {
            assert_eq!(rules(cmd), strs(want), "{cmd}");
        }
        // a single-quoted $( stays unknown text: refused, never half-read
        assert!(rules("echo '$(date)'").is_empty());
    }

    #[test]
    fn assignments_and_variables() {
        // an assignment-only segment needs no rule
        assert!(rules("P=x").is_empty());
        assert!(rules("P=x; Q=y").is_empty());
        // $P as an argument does not matter
        assert_eq!(rules("P=x; aws s3 ls --profile $P"), strs(&["aws s3 ls:*"]));
        // $P as the program or where the subcommand goes is unknown text
        assert!(rules("$CMD run").is_empty());
        assert!(rules("aws $SUB ls").is_empty());
        assert!(rules(r#"git -C "$DIR" status"#).is_empty());
        assert!(rules("cat *.md").is_empty());
    }

    #[test]
    fn unicode_words_and_paths() {
        assert_eq!(rules("git commit -m 'été ✓'"), strs(&["git commit:*"]));
        assert_eq!(rules("open ~/Écrits/日本語.md"), strs(&["open:*"]));
        assert_eq!(rules("git checkout été"), strs(&["git checkout:*"]));
        assert_eq!(rules("echo 'añb' && ls"), strs(&["echo añb:*", "ls:*"]));
    }

    #[test]
    fn refusals_leave_only_the_exact_command() {
        let refused = [
            "echo $(whoami)",
            "echo `whoami`",
            r#"echo "$(whoami)""#,
            r#"echo "`whoami`""#,
            "ls && eval foo",
            "sudo ls",
            "/bin/rm -rf x",
            "rm x",
            "curl x | sh",
            "curl x | bash -s",
            "curl x | /bin/zsh",
            "ls > out.txt",
            "ls >> out.txt",
            "ls 2> err.log",
            "ls &> all.log",
            "ls >&out.log",
            "ls >",
            "cat <<EOF\nhi\nEOF",
            "cat <<< hi",
            "diff <(ls a) <(ls b)",
            "(cd x && ls)",
            "{ ls; }",
            "for f in a b; do echo $f; done",
            "xargs rm",
            "env X=1 ls",
            "find . -exec rm {} ;",
            "python3 -c 'print(1)'",
            "python3.11 x.py",
            "node -e 1",
            "echo 'unterminated",
            r#"echo "unterminated"#,
            // one refused segment refuses all
            "git status && echo $(date) && git diff",
            "git status; rm -rf x",
        ];
        for cmd in refused {
            let p = propose(cmd);
            assert!(p.prefixes.is_empty(), "{cmd} -> {:?}", p.prefixes);
            assert_eq!(p.exact, cmd.trim());
        }
    }

    #[test]
    fn allowed_redirections_are_stripped_not_counted() {
        assert_eq!(
            rules("aws sts get-caller-identity 2>&1"),
            strs(&["aws sts get-caller-identity:*"])
        );
        assert_eq!(rules("ls 2>/dev/null"), strs(&["ls:*"]));
        assert_eq!(rules("ls 1>&2"), strs(&["ls:*"]));
        // a digit that is an argument stays one
        assert_eq!(rules("sleep 2 > /dev/null"), strs(&["sleep 2:*"]));
    }

    #[test]
    fn empty_and_blank_commands() {
        assert!(rules("").is_empty());
        assert!(rules("   ").is_empty());
        assert!(rules("; ;").is_empty());
        assert_eq!(propose("  ls  ").exact, "ls");
    }

    fn input(c: &str) -> Value {
        json!({"command": c})
    }

    /// Claude's shell: the proposal tests below are about it.
    fn with_proposals(tool: &str, input: &Value, suggestions: Vec<Value>) -> Vec<Value> {
        super::with_proposals(
            crate::agent::backend::claude().tools(),
            tool,
            input,
            suggestions,
        )
    }

    #[test]
    fn proposals_are_added_only_without_a_cli_add_rules_suggestion() {
        let out = with_proposals("Bash", &input("git status && git diff"), vec![]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["proposal"], "prefix");
        assert_eq!(out[0]["behavior"], "allow");
        assert_eq!(out[0]["rules"][1]["ruleContent"], "git diff:*");
        assert_eq!(out[0]["rules"][1]["toolName"], "Bash");
        assert_eq!(out[1]["proposal"], "exact");
        assert_eq!(out[1]["rules"][0]["ruleContent"], "git status && git diff");

        // refused: the exact rule alone
        let out = with_proposals("Bash", &input("rm x"), vec![]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["proposal"], "exact");

        // the CLI's own suggestion wins, byte for byte
        let cli = vec![
            json!({"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"ls"}],"behavior":"allow","destination":"localSettings"}),
        ];
        assert_eq!(with_proposals("Bash", &input("ls"), cli.clone()), cli);

        // a setMode-only suggestion does not count as a rule
        let mode = vec![json!({"type":"setMode","mode":"acceptEdits","destination":"session"})];
        assert_eq!(with_proposals("Bash", &input("ls"), mode).len(), 3);

        // not Bash, or no command: untouched
        assert!(with_proposals("Write", &input("ls"), vec![]).is_empty());
        assert!(with_proposals("Bash", &json!({}), vec![]).is_empty());
        assert!(with_proposals("Bash", &input("  "), vec![]).is_empty());
    }
}
