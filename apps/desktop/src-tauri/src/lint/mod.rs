//! Markdown lint: the engine behind the built-in feature `lint` (ADR 2026-11-19 "lint Markdown
//! with rumdl in a built-in lint feature, safe fixes on save", spec `SPECs/markdown-lint-spec.md`).
//! Tauri-free, so the app, the `writer lint` / `writer lint:fix` CLI commands (and through them
//! the MCP server and the agent skill) run the same code.
//!
//! This module is the only code that names `rumdl` (a test scans the sources for it). It runs
//! rumdl with the Obsidian flavor and the enabled rules, then does what rumdl does not:
//!
//! - **Obsidian guard.** A finding whose range, or a fix whose edits, overlap Obsidian-only
//!   syntax (front matter, wiki links and embeds, callout headers, block ids, `%%` comments, from
//!   `markdown_mask::obsidian_syntax`) is dropped, so a rule written for plain Markdown never
//!   rewrites it.
//! - **Positions.** Offsets are UTF-16, the editor's (`positions::Index`, the one conversion).
//! - **Fixing.** Writer applies the fix of each warning itself, non-overlapping ones from the end
//!   of the note backwards, and lints again until nothing changes (at most [`MAX_PASSES`]). A
//!   rule that fixes only through rumdl's own `Rule::fix` and attaches no `Fix` to its warnings
//!   is therefore reported, never fixed (`rules.json` says `fixable: false` for those).
//!
//! The rules are `rules::all()`; which are on is the `lint.rules` setting, and fix-on-save
//! runs only the `safe` ones among them.

pub mod positions;
pub mod rules;
#[cfg(test)]
mod tests;

use self::positions::Index;
use crate::agent::line_diff;
use crate::config::ConfigValue;
use crate::markdown_mask;
use rumdl_lib::config::{Config, MarkdownFlavor};
use rumdl_lib::rule::{LintWarning, Rule as RumdlRule, Severity as RumdlSeverity};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeSet;
use std::ops::Range;

/// Lint passes a fix may take before it stops (a rule pair that undoes each other must not loop).
pub const MAX_PASSES: usize = 5;

/// The rules switched on beyond the defaults, and the default ones switched off: the setting is
/// the user's difference from `rules.json`, so a rule list the registry grows into reaches
/// everyone who did not choose, and "everything off" is a list that is not empty.
pub const RULES_ON_KEY: &str = "lint.rules-on";
pub const RULES_OFF_KEY: &str = "lint.rules-off";
pub const FIX_ON_SAVE_KEY: &str = "lint.fix-on-save";

/// A lint failure (rumdl refused the text): never a finding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// The settings the engine reads, through a lookup so the app (merged settings) and the CLI (the
/// global config file) share the parsing and the defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// The enabled rule ids (`MD009`); unknown ids are dropped.
    pub rules: BTreeSet<String>,
    pub fix_on_save: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self::from_lookup(|_| None)
    }
}

impl Options {
    pub fn from_lookup(get: impl Fn(&str) -> Option<ConfigValue>) -> Self {
        // a config file reads a list of one as a plain value
        let list = |key: &str| -> Vec<String> {
            match get(key) {
                Some(ConfigValue::List(ids)) => ids,
                Some(ConfigValue::String(id)) => vec![id],
                _ => Vec::new(),
            }
        };
        let off = list(RULES_OFF_KEY);
        let rules = rules::defaults()
            .into_iter()
            .chain(list(RULES_ON_KEY))
            .filter(|id| rules::get(id).is_some() && !off.contains(id))
            .collect();
        Self {
            rules,
            fix_on_save: get(FIX_ON_SAVE_KEY)
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
        }
    }

    /// These options with an explicit rule set (the CLI's `rules=`).
    pub fn with_rules(self, ids: impl IntoIterator<Item = String>) -> Self {
        Self {
            rules: ids.into_iter().collect(),
            ..self
        }
    }
}

/// Which of the enabled rules a fix runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum FixScope {
    /// Only the rules whose fix changes formatting, never meaning (what saving runs).
    Safe,
    /// Every enabled rule that can fix.
    All,
}

impl FixScope {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "safe" => Some(Self::Safe),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// One replacement, in UTF-16 offsets of the text that was linted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Edit {
    pub from: u32,
    pub to: u32,
    pub insert: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub rule: String,
    pub message: String,
    /// UTF-16 offsets, `start..end` (an empty range is a point).
    pub start: u32,
    pub end: u32,
    /// 1-based line and character column of `start`.
    pub line: u32,
    pub column: u32,
    pub severity: Severity,
    /// Its fix is formatting only (fix-on-save would run it).
    pub safe: bool,
    /// The edits of its fix, empty when the rule has none here.
    pub fix: Vec<Edit>,
}

/// What a fix did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Fixed {
    /// The fixed text (equal to the input when nothing was fixed).
    pub text: String,
    /// The ids of the rules that changed something, sorted.
    pub applied: Vec<String>,
    /// The input turned into `text`, as minimal edits in UTF-16 offsets of the input (what the
    /// editor applies, so the caret and the selection map through them).
    pub edits: Vec<Edit>,
}

/// Lints `text` with the enabled rules, the Obsidian guard applied.
pub fn check(text: &str, options: &Options) -> Result<Vec<Finding>, Error> {
    let index = Index::new(text);
    Ok(guarded(text, &index, &options.rules)?
        .into_iter()
        .map(|g| g.into_finding(&index))
        .collect())
}

/// Fixes `text` with the enabled rules of `scope`.
pub fn fix(text: &str, options: &Options, scope: FixScope) -> Result<Fixed, Error> {
    fix_keeping(text, options, scope, &[])
}

/// [`fix`] that leaves `keep` alone: UTF-16 ranges of `text` (the lines a caret is in, when
/// saving while typing). A fix with an edit in or touching a kept range is dropped whole, never
/// half applied; the ranges follow the text through the passes, so a later pass keeps them too.
pub fn fix_keeping(
    text: &str,
    options: &Options,
    scope: FixScope,
    keep: &[Range<u32>],
) -> Result<Fixed, Error> {
    let first = Index::new(text);
    let mut keep: Vec<Range<usize>> = keep
        .iter()
        .map(|r| first.byte_of_utf16(r.start)..first.byte_of_utf16(r.end))
        .collect();
    let ids: BTreeSet<String> = options
        .rules
        .iter()
        .filter(|id| scope == FixScope::All || rules::get(id).is_some_and(|r| r.safe))
        .cloned()
        .collect();
    let mut current = text.to_string();
    let mut applied: BTreeSet<String> = BTreeSet::new();
    // the edits of the first pass, in UTF-16 offsets of `text`: when one pass settles the note
    // they are the answer, as precise as the rules made them
    let mut first_pass: Vec<Edit> = Vec::new();
    let mut passes = 0;
    for _ in 0..MAX_PASSES {
        let index = Index::new(&current);
        let mut plan: Vec<Guarded> = guarded(&current, &index, &ids)?
            .into_iter()
            .filter(|g| !g.edits.is_empty() && !g.touches(&keep))
            .collect();
        // from the end backwards, so an applied edit never moves one still to apply
        plan.sort_by_key(|g| std::cmp::Reverse(g.span()));
        let mut next = current.clone();
        let mut floor = usize::MAX; // the start of the lowest edit applied so far
        let mut pass_edits: Vec<Edit> = Vec::new();
        let mut applied_bytes: Vec<&ByteEdit> = Vec::new();
        for g in &plan {
            let (start, end) = g.span();
            if end > floor {
                continue; // overlaps one already applied: the next pass retries it
            }
            let mut edits: Vec<&ByteEdit> = g.edits.iter().collect();
            edits.sort_by_key(|e| std::cmp::Reverse(e.start));
            for e in edits {
                next.replace_range(e.start..e.end, &e.insert);
                pass_edits.push(e.to_edit(&index));
                applied_bytes.push(e);
            }
            floor = start;
            applied.insert(g.rule.clone());
        }
        if pass_edits.is_empty() || next == current {
            break;
        }
        for r in &mut keep {
            // no applied edit touches a kept range: each lies wholly before it or after it
            let shift: isize = applied_bytes
                .iter()
                .filter(|e| e.end < r.start)
                .map(|e| e.insert.len() as isize - (e.end - e.start) as isize)
                .sum();
            *r = r.start.saturating_add_signed(shift)..r.end.saturating_add_signed(shift);
        }
        passes += 1;
        if passes == 1 {
            pass_edits.reverse(); // ascending
            first_pass = pass_edits;
        }
        current = next;
    }
    let edits = match passes {
        0 => Vec::new(),
        1 => first_pass,
        _ => edits_between(text, &current),
    };
    Ok(Fixed {
        text: current,
        applied: applied.into_iter().collect(),
        edits,
    })
}

/// An edit in byte offsets of the linted text.
#[derive(Debug, Clone)]
struct ByteEdit {
    start: usize,
    end: usize,
    insert: String,
}

impl ByteEdit {
    fn to_edit(&self, index: &Index) -> Edit {
        Edit {
            from: index.utf16_of_byte(self.start),
            to: index.utf16_of_byte(self.end),
            insert: self.insert.clone(),
        }
    }
}

/// A warning that passed the guard.
struct Guarded {
    rule: String,
    message: String,
    severity: Severity,
    /// Where the warning points, as `char` offsets.
    chars: Range<usize>,
    edits: Vec<ByteEdit>,
}

impl Guarded {
    /// The bytes the fix touches, from its first edit to its last.
    fn span(&self) -> (usize, usize) {
        let start = self.edits.iter().map(|e| e.start).min().unwrap_or(0);
        let end = self.edits.iter().map(|e| e.end).max().unwrap_or(0);
        (start, end)
    }

    /// Whether an edit of the fix is in, or touches, one of `keep` (byte ranges).
    fn touches(&self, keep: &[Range<usize>]) -> bool {
        self.edits
            .iter()
            .any(|e| keep.iter().any(|k| e.start <= k.end && e.end >= k.start))
    }

    fn into_finding(self, index: &Index) -> Finding {
        let (line, column) = index.line_col(self.chars.start);
        Finding {
            safe: rules::get(&self.rule).is_some_and(|r| r.safe),
            start: index.utf16_of_char(self.chars.start),
            end: index.utf16_of_char(self.chars.end),
            line,
            column,
            severity: self.severity,
            message: self.message,
            fix: self.edits.iter().map(|e| e.to_edit(index)).collect(),
            rule: self.rule,
        }
    }
}

fn run_rumdl(text: &str, ids: &BTreeSet<String>) -> Result<Vec<LintWarning>, Error> {
    if ids.is_empty() || text.is_empty() {
        return Ok(Vec::new());
    }
    let config = Config::default();
    let selected: Vec<Box<dyn RumdlRule>> = rumdl_lib::rules::all_rules(&config)
        .into_iter()
        .filter(|r| ids.contains(r.name()))
        .collect();
    rumdl_lib::lint(
        text,
        &selected,
        false,
        MarkdownFlavor::Obsidian,
        None,
        Some(&config),
    )
    .map_err(|e| Error(e.to_string()))
}

/// rumdl's warnings for the rules in `ids`, minus the ones that touch Obsidian syntax.
fn guarded(text: &str, index: &Index, ids: &BTreeSet<String>) -> Result<Vec<Guarded>, Error> {
    let warnings = run_rumdl(text, ids)?;
    if warnings.is_empty() {
        return Ok(Vec::new());
    }
    let chars: Vec<char> = text.chars().collect();
    let protected = markdown_mask::obsidian_syntax(&chars);
    let mut out = Vec::new();
    for w in warnings {
        let Some(rule) = w.rule_name.clone().filter(|r| ids.contains(r)) else {
            continue;
        };
        let edits = match w.fix.as_ref().map(|f| byte_edits(text, f)) {
            None => Vec::new(),
            Some(Some(edits)) => edits,
            Some(None) => continue, // a fix that does not fit the text is not offered
        };
        let start = index.char_of_line_col(w.line, w.column);
        let end = index.char_of_line_col(w.end_line, w.end_column).max(start);
        // a fix is judged by what it changes; a finding without one by where it points
        let touched: Vec<Range<usize>> = if edits.is_empty() {
            std::iter::once(start..end).collect()
        } else {
            edits
                .iter()
                .map(|e| index.char_of_byte(e.start)..index.char_of_byte(e.end))
                .collect()
        };
        if touched.iter().any(|r| overlaps(&protected, r)) {
            continue;
        }
        out.push(Guarded {
            rule,
            message: w.message,
            severity: match w.severity {
                RumdlSeverity::Error => Severity::Error,
                RumdlSeverity::Warning => Severity::Warning,
                RumdlSeverity::Info => Severity::Info,
            },
            chars: start..end,
            edits,
        });
    }
    out.sort_by_key(|g| (g.chars.start, g.chars.end));
    Ok(out)
}

/// Whether `range` (a point when empty) falls inside, or crosses, one of the sorted, disjoint
/// `protected` ranges. An insertion at the edge of one is outside it.
fn overlaps(protected: &[Range<usize>], range: &Range<usize>) -> bool {
    let at = protected.partition_point(|p| p.end <= range.start);
    protected.get(at).is_some_and(|p| {
        if range.is_empty() {
            p.start < range.start
        } else {
            p.start < range.end
        }
    })
}

/// A rumdl fix (its edit and the paired ones) as minimal byte edits: the text a replacement
/// shares with the range it replaces at either end is not an edit, so a rule that rewrites a
/// whole line to change its end touches only that end. `None` when a range does not fit `text`.
fn byte_edits(text: &str, fix: &rumdl_lib::rule::Fix) -> Option<Vec<ByteEdit>> {
    std::iter::once(fix)
        .chain(fix.additional_edits.iter())
        .map(|f| {
            let (start, end) = (f.range.start, f.range.end);
            if start > end
                || end > text.len()
                || !text.is_char_boundary(start)
                || !text.is_char_boundary(end)
            {
                return None;
            }
            Some(trimmed(&text[start..end], &f.replacement, start))
        })
        .collect()
}

/// `old` (at byte `at` of the text) replaced by `new`, without the shared prefix and suffix.
fn trimmed(old: &str, new: &str, at: usize) -> ByteEdit {
    let prefix: usize = old
        .chars()
        .zip(new.chars())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .sum();
    let (old, new) = (&old[prefix..], &new[prefix..]);
    let suffix: usize = old
        .chars()
        .rev()
        .zip(new.chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .sum();
    ByteEdit {
        start: at + prefix,
        end: at + prefix + old.len() - suffix,
        insert: new[..new.len() - suffix].to_string(),
    }
}

/// The edits that turn `before` into `after`: a line diff, each changed run trimmed to the
/// characters that really differ, in UTF-16 offsets of `before`.
fn edits_between(before: &str, after: &str) -> Vec<Edit> {
    let a: Vec<&str> = before.split_inclusive('\n').collect();
    let b: Vec<&str> = after.split_inclusive('\n').collect();
    let script = line_diff::diff_lines(&a, &b);
    let index = Index::new(before);
    // the byte offset of each line start in `before`
    let mut starts = Vec::with_capacity(a.len() + 1);
    let mut at = 0;
    for l in &a {
        starts.push(at);
        at += l.len();
    }
    starts.push(at);
    let mut out = Vec::new();
    let mut run: Option<(usize, usize, String)> = None; // (first old line, past-last old line, new text)
    let mut old_at = 0; // the old line the script is at
    let mut flush = |run: &mut Option<(usize, usize, String)>| {
        let Some((from, to, new)) = run.take() else {
            return;
        };
        let new_lines: Vec<&str> = new.split_inclusive('\n').collect();
        if new_lines.len() == to - from {
            // as many lines as before: each changed line is its own edit
            for (k, line) in new_lines.iter().enumerate() {
                let (s, e) = (starts[from + k], starts[from + k + 1]);
                out.push(trimmed(&before[s..e], line, s).to_edit(&index));
            }
        } else {
            out.push(
                trimmed(&before[starts[from]..starts[to]], &new, starts[from]).to_edit(&index),
            );
        }
    };
    for e in script {
        match e {
            line_diff::Edit::Equal(i, _) => {
                flush(&mut run);
                old_at = i + 1;
            }
            line_diff::Edit::Del(i) => {
                let r = run.get_or_insert((i, i, String::new()));
                r.1 = i + 1;
                old_at = i + 1;
            }
            line_diff::Edit::Add(j) => {
                let r = run.get_or_insert((old_at, old_at, String::new()));
                r.2.push_str(b[j]);
            }
        }
    }
    flush(&mut run);
    out.retain(|e| e.from != e.to || !e.insert.is_empty());
    out
}
