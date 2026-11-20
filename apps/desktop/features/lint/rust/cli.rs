//! `writer lint` and `writer lint:fix`: the engine of the app, headless (ADR 2026-11-19). Both
//! read the global settings file for the enabled rules (`rules=` overrides it), so the CLI, the
//! MCP server and the agent see what the app sees. `lint` writes nothing; `lint:fix` rewrites the
//! note atomically through `vault_ops`, only when something changed, and prints the rules it
//! applied. Tagged with the feature, so the CLI's one gate answers "turned off" while
//! `features.lint.enabled` is false.

use crate::cli::args::Args;
use crate::cli::format::json_pretty;
use crate::cli::registry::{cmd, p, CommandSpec, FILE, NO_FLAGS, NO_FORMATS, PATH};
use crate::cli::{CliError, Ctx, Target};
use crate::config;
use crate::lint::{self, rules, Finding, FixScope, Options};
use crate::vault_ops;
use serde_json::json;

const FEATURE: Option<&str> = Some("lint");
const GROUP: &str = "Lint";
const RULES_HELP: &str = "rule ids to run, e.g. MD009,MD012; default the rules on in Settings";

pub static COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "lint",
            GROUP,
            "List a note's Markdown formatting problems (read-only)",
            &[FILE, PATH, p("rules", RULES_HELP), p("format", "text | json")],
            NO_FLAGS,
            &["text", "json"],
            Some("text"),
            reads,
            lint_cmd
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "lint:fix",
            GROUP,
            "Fix a note's Markdown formatting problems in place; Obsidian syntax is never touched",
            &[
                FILE,
                PATH,
                p(
                    "scope",
                    "safe (default, formatting-only rules) | all (also rules that can change meaning)"
                ),
                p("rules", RULES_HELP)
            ],
            NO_FLAGS,
            NO_FORMATS,
            None,
            writes,
            fix_cmd
        )
    },
];

/// The note the command is for: Markdown only.
fn note(ctx: &Ctx, args: &Args) -> Result<(Target, String), CliError> {
    let t = ctx.target(args)?;
    let lower = t.rel.to_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".markdown")) {
        return Err(CliError::fail(format!("{} is not a Markdown note", t.rel)));
    }
    let text = vault_ops::read_text(&t.abs)?;
    Ok((t, text))
}

/// The enabled rules: the settings file, or `rules=`.
fn options(ctx: &Ctx, args: &Args) -> Result<Options, CliError> {
    let data_dir = ctx.env.data_dir()?;
    let options = Options::from_lookup(|k| config::read_global_value(&data_dir, k));
    let Some(list) = args.get("rules") else {
        return Ok(options);
    };
    let mut ids = Vec::new();
    for raw in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let id = raw.to_uppercase();
        if rules::get(&id).is_none() {
            return Err(CliError::Usage(format!(
                "rules= takes rule ids such as MD009, not \"{raw}\" (known: {})",
                rules::all()
                    .iter()
                    .map(|r| r.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        ids.push(id);
    }
    Ok(options.with_rules(ids))
}

fn lint_failed(rel: &str, e: lint::Error) -> CliError {
    CliError::fail(format!("{rel}: {e}"))
}

fn lint_cmd(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let (t, text) = note(ctx, args)?;
    let findings = lint::check(&text, &options(ctx, args)?).map_err(|e| lint_failed(&t.rel, e))?;
    Ok(render(&t.rel, &findings, &format))
}

fn render(rel: &str, findings: &[Finding], format: &str) -> String {
    if format == "json" {
        let list: Vec<_> = findings
            .iter()
            .map(|f| {
                json!({
                    "line": f.line,
                    "column": f.column,
                    "rule": f.rule,
                    "name": rules::get(&f.rule).map(|r| r.name.as_str()),
                    "message": f.message,
                    "severity": f.severity,
                    "fixable": !f.fix.is_empty(),
                    "safe": f.safe,
                })
            })
            .collect();
        return json_pretty(
            &json!({ "path": rel, "clean": findings.is_empty(), "findings": list }),
        ) + "\n";
    }
    if findings.is_empty() {
        return format!("{rel}: clean\n");
    }
    findings
        .iter()
        .map(|f| {
            let how = match (f.fix.is_empty(), f.safe) {
                (true, _) => "",
                (false, true) => " [fixable]",
                (false, false) => " [fixable, scope=all]",
            };
            format!(
                "{rel}:{}:{} {} {}{how}\n",
                f.line, f.column, f.rule, f.message
            )
        })
        .collect()
}

fn fix_cmd(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let scope = match args.get("scope") {
        None => FixScope::Safe,
        Some(s) => FixScope::parse(s)
            .ok_or_else(|| CliError::Usage(format!("scope= takes safe or all, not \"{s}\"")))?,
    };
    let (t, text) = note(ctx, args)?;
    let options = options(ctx, args)?;
    let fixed = lint::fix(&text, &options, scope).map_err(|e| lint_failed(&t.rel, e))?;
    if fixed.text != text {
        vault_ops::write_text(&t.abs, &fixed.text)?;
    }
    let left = lint::check(&fixed.text, &options)
        .map_err(|e| lint_failed(&t.rel, e))?
        .len();
    let mut out = if fixed.applied.is_empty() {
        format!("{}: nothing to fix\n", t.rel)
    } else {
        format!("{}: fixed {}\n", t.rel, fixed.applied.join(", "))
    };
    if left > 0 {
        out.push_str(&format!(
            "{left} finding{} left: run writer lint for the list\n",
            if left == 1 { "" } else { "s" }
        ));
    }
    Ok(out)
}
