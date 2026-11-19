//! `writer check`: the engine of the app, headless (ADR 2026-11-18, point 10). It reads the note,
//! the vault's personal dictionary and the global settings file, checks the note and prints the
//! findings; nothing is written and nothing leaves the machine. Tagged with the feature, so the
//! CLI's one gate answers "turned off" while `features.spellcheck.enabled` is false.

use crate::cli::args::Args;
use crate::cli::format::json_pretty;
use crate::cli::registry::{cmd, p, CommandSpec, FILE, NO_FLAGS, PATH};
use crate::cli::{CliError, Ctx};
use crate::config;
use crate::spellcheck::checker::{Finding, Kind};
use crate::spellcheck::harper::std_spawner;
use crate::spellcheck::lang::Lang;
use crate::spellcheck::options::Options;
use crate::spellcheck::{dictionaries, ignored, personal, Checked, Checker, Context, NoteInput};
use crate::vault_ops;
use serde_json::json;

const FEATURE: Option<&str> = Some("spellcheck");

pub static COMMANDS: &[CommandSpec] = &[CommandSpec {
    feature: FEATURE,
    ..cmd!(
        "check",
        "Spelling",
        "Check a note's spelling and grammar with Writer's local checker",
        &[
            FILE,
            PATH,
            p(
                "lang",
                "check as this language, for example fr (default: the note's own)"
            ),
            p("format", "text | json")
        ],
        NO_FLAGS,
        &["text", "json"],
        Some("text"),
        reads,
        check
    )
}];

fn check(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let t = ctx.target(args)?;
    let text = vault_ops::read_text(&t.abs)?;
    let language = match args.get("lang") {
        None => None,
        Some(l) => Some(Lang::parse(l).ok_or_else(|| {
            CliError::Usage(format!(
                "lang= takes a language tag such as en or fr-CA, not \"{l}\""
            ))
        })?),
    };
    let data_dir = ctx.env.data_dir()?;
    // The CLI has no settings layer: the global config file and the defaults.
    let options = Options::from_lookup(|k| config::read_global_value(&data_dir, k));
    let personal = personal::load(ctx.root()?).map_err(|e| CliError::fail(e.to_string()))?;
    let checker = Checker::new(dictionaries::dir(&data_dir), std_spawner());
    let ignored =
        ignored::load(&data_dir, ctx.root()?).map_err(|e| CliError::fail(e.to_string()))?;
    let context = Context {
        options: &options,
        personal: &personal,
        ignored: &ignored,
    };
    let checked = match &language {
        Some(lang) => checker.check_as(&text, lang, &context),
        None => checker
            .check_note(
                &text,
                &NoteInput {
                    path: &t.rel,
                    version: 0,
                    language: None,
                },
                &context,
            )
            .map_err(|_| CliError::fail("the check was superseded"))?,
    };
    Ok(render(&t.rel, &text, &checked, &format))
}

/// Line and column (both from 1, in characters) of a UTF-16 offset.
struct Positions {
    /// UTF-16 offset of the first unit of each line.
    starts: Vec<u32>,
    units: Vec<u16>,
}

impl Positions {
    fn new(text: &str) -> Self {
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut starts = vec![0];
        starts.extend(
            units
                .iter()
                .enumerate()
                .filter(|(_, u)| **u == u16::from(b'\n'))
                .map(|(i, _)| i as u32 + 1),
        );
        Self { starts, units }
    }

    fn at(&self, offset: u32) -> (usize, usize) {
        let line = self.starts.partition_point(|s| *s <= offset) - 1;
        let from = self.starts[line] as usize;
        let column = String::from_utf16_lossy(&self.units[from..offset as usize])
            .chars()
            .count()
            + 1;
        (line + 1, column)
    }

    fn slice(&self, f: &Finding) -> String {
        String::from_utf16_lossy(&self.units[f.start as usize..f.end as usize])
    }
}

fn kind_word(kind: Kind) -> &'static str {
    match kind {
        Kind::Spelling => "spelling",
        Kind::Grammar => "grammar",
        Kind::Style => "style",
    }
}

fn render(rel: &str, text: &str, checked: &Checked, format: &str) -> String {
    let pos = Positions::new(text);
    if format == "json" {
        let findings: Vec<_> = checked
            .findings
            .iter()
            .map(|f| {
                let (line, column) = pos.at(f.start);
                json!({
                    "line": line,
                    "column": column,
                    "start": f.start,
                    "end": f.end,
                    "text": pos.slice(f),
                    "kind": kind_word(f.kind),
                    "rule": f.rule_id,
                    "provider": f.provider,
                    "message": f.message,
                    "replacements": f.replacements,
                })
            })
            .collect();
        let missing: Vec<&str> = checked.missing.iter().map(|l| l.tag()).collect();
        return json_pretty(
            &json!({ "path": rel, "findings": findings, "missingLanguages": missing }),
        ) + "\n";
    }
    let mut out = String::new();
    for f in &checked.findings {
        let (line, column) = pos.at(f.start);
        out.push_str(&format!(
            "{rel}:{line}:{column} {} {} \"{}\" {}",
            kind_word(f.kind),
            f.rule_id,
            pos.slice(f),
            f.message
        ));
        if !f.replacements.is_empty() {
            out.push_str(&format!(" -> {}", f.replacements.join(" | ")));
        }
        out.push('\n');
    }
    for l in &checked.missing {
        out.push_str(&format!(
            "{rel}: no dictionary for {l}; install it in Writer's Settings > Spelling\n"
        ));
    }
    if checked.findings.is_empty() && checked.missing.is_empty() {
        out.push_str(&format!("{rel}: no findings\n"));
    }
    out
}
