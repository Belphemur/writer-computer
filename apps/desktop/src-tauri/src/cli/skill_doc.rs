//! The command lists of the managed `writer-cli` skill, generated from the registry (the one
//! owner of commands, parameters and flags). `skills/writer-cli/references/commands.md` and the
//! command table of `skills/writer-cli/SKILL.md` hold generated blocks between
//! `<!-- BEGIN GENERATED: name -->` and `<!-- END GENERATED: name -->`; everything around them is
//! hand-written. The golden test below fails when a block is stale and
//! `WRITER_UPDATE_GOLDEN=1 cargo test skill_doc` rewrites it. A change here changes the bundled
//! skill, so `managed_skills::BUNDLE_VERSION` must be bumped (a test says so).

use super::registry::{commands, CommandSpec, ParamSpec, FILE, PATH};

/// Prose that belongs to a whole group, shown under its heading in the reference.
const GROUP_NOTES: &[(&str, &str)] = &[
    (
    "Spelling",
    "`check` runs the same local checker as the app (Harper for English, an installed Hunspell dictionary for other languages; no network). It skips code, links, front matter and math, reads the note's `lang:` property (or `lang=`) and the vault's `.writer/dictionary.txt`. `format=json` prints `{path, findings, missingLanguages}`; each finding has `line`, `column`, `start`, `end` (UTF-16), `text`, `kind` (spelling, grammar or style), `rule`, `message` and `replacements`. Findings are advice: change the note with an ordinary edit.",
    ),
    (
    "Graph",
    "Every `graph:*` command takes `format=` (text, json or tsv; default text, use json from an agent) and prints errors as `writer: ...` on stderr. `file=` and `path=` work as elsewhere. Traversals are bounded (depth at most 4) and results are capped. `graph:neighbors` JSON is `{center, nodes, edges, truncated}`; `graph:path` exits 1 with `no path within N hops` when there is none.",
    ),
];

/// The `file=` and `path=` parameters are explained once in the page's intro, so a command that
/// takes them with the registry's standard text lists just the name.
fn is_standard(p: &ParamSpec) -> bool {
    (p.name == FILE.name && p.desc == FILE.desc) || (p.name == PATH.name && p.desc == PATH.desc)
}

fn param_text(p: &ParamSpec) -> String {
    let desc = match (p.required, is_standard(p) || p.desc.is_empty()) {
        (true, true) => "required".to_string(),
        (true, false) => format!("required; {}", p.desc),
        (false, true) => String::new(),
        (false, false) => p.desc.to_string(),
    };
    if desc.is_empty() {
        format!("`{}=`", p.name)
    } else {
        format!("`{}=` ({desc})", p.name)
    }
}

fn command_line(c: &CommandSpec) -> String {
    let summary = c.summary.trim_end_matches('.');
    let mut out = format!("- `{}` — {summary}.", c.name);
    if !c.params.is_empty() {
        let params: Vec<String> = c.params.iter().map(param_text).collect();
        out.push_str(&format!(" Params: {}.", params.join(", ")));
    }
    if !c.flags.is_empty() {
        let flags: Vec<String> = c
            .flags
            .iter()
            .map(|(f, d)| format!("`{}` ({d})", super::args::flag_display(f)))
            .collect();
        out.push_str(&format!(" Flags: {}.", flags.join(", ")));
    }
    out
}

/// Groups in registry order, each with its commands in registry order.
fn groups() -> Vec<(&'static str, Vec<&'static CommandSpec>)> {
    let mut out: Vec<(&'static str, Vec<&'static CommandSpec>)> = Vec::new();
    for c in commands() {
        match out.iter_mut().find(|(g, _)| *g == c.group) {
            Some((_, list)) => list.push(c),
            None => out.push((c.group, vec![c])),
        }
    }
    out
}

/// The body of the reference page: one `##` section per group, one bullet per command.
pub fn reference_block() -> String {
    let mut out = String::new();
    for (group, list) in groups() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("## {group}\n\n"));
        if let Some((_, note)) = GROUP_NOTES.iter().find(|(g, _)| *g == group) {
            out.push_str(&format!("{note}\n\n"));
        }
        for c in list {
            out.push_str(&command_line(c));
            out.push('\n');
        }
    }
    out
}

/// The group table of `SKILL.md`, padded the way the formatter pads Markdown tables.
pub fn table_block() -> String {
    let rows: Vec<(String, String)> = groups()
        .into_iter()
        .map(|(g, list)| {
            let names: Vec<String> = list.iter().map(|c| format!("`{}`", c.name)).collect();
            (g.to_string(), names.join(", "))
        })
        .collect();
    let w0 = rows
        .iter()
        .map(|r| r.0.chars().count())
        .max()
        .unwrap_or(0)
        .max("Group".len());
    let w1 = rows
        .iter()
        .map(|r| r.1.chars().count())
        .max()
        .unwrap_or(0)
        .max("Commands".len());
    let line = |a: &str, b: &str| format!("| {a:<w0$} | {b:<w1$} |\n");
    let mut out = line("Group", "Commands");
    out.push_str(&format!("| {} | {} |\n", "-".repeat(w0), "-".repeat(w1)));
    for (g, names) in &rows {
        out.push_str(&line(g, names));
    }
    out
}

const BEGIN: &str = "<!-- BEGIN GENERATED: ";
const END: &str = "<!-- END GENERATED: ";

/// `text` with the block named `name` replaced by `body`, set off from the markers by blank lines
/// (the Markdown formatter puts them there); `None` when its markers are missing.
fn splice(text: &str, name: &str, body: &str) -> Option<String> {
    let begin = format!("{BEGIN}{name} (cargo test skill_doc) -->\n");
    let end = format!("{END}{name} -->");
    let start = text.find(&begin)? + begin.len();
    let stop = start + text[start..].find(&end)?;
    Some(format!("{}\n{body}\n{}", &text[..start], &text[stop..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn skill_file(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("skills/writer-cli")
            .join(rel)
    }

    /// Each generated block of each file equals what the registry produces now.
    #[test]
    fn the_skill_command_lists_match_the_registry() {
        let update = std::env::var_os("WRITER_UPDATE_GOLDEN").is_some();
        for (rel, name, body) in [
            ("references/commands.md", "commands", reference_block()),
            ("SKILL.md", "groups", table_block()),
        ] {
            let path = skill_file(rel);
            let current = std::fs::read_to_string(&path).unwrap();
            let fresh = splice(&current, name, &body)
                .unwrap_or_else(|| panic!("{rel} has no `{name}` generated block"));
            if update {
                std::fs::write(&path, &fresh).unwrap();
            } else {
                assert!(
                    current == fresh,
                    "skills/writer-cli/{rel} is stale: run `WRITER_UPDATE_GOLDEN=1 cargo test skill_doc`, review the diff and bump BUNDLE_VERSION"
                );
            }
        }
    }

    #[test]
    fn every_registry_command_is_listed_once() {
        let reference = reference_block();
        for c in commands() {
            let needle = format!("- `{}` — ", c.name);
            assert_eq!(reference.matches(&needle).count(), 1, "{}", c.name);
        }
    }

    #[test]
    fn splice_replaces_only_the_named_block() {
        let text = "a\n<!-- BEGIN GENERATED: x (cargo test skill_doc) -->\nold\n<!-- END GENERATED: x -->\nb\n";
        assert_eq!(
            splice(text, "x", "new\n").unwrap(),
            "a\n<!-- BEGIN GENERATED: x (cargo test skill_doc) -->\n\nnew\n\n<!-- END GENERATED: x -->\nb\n"
        );
        assert!(splice(text, "y", "new\n").is_none());
    }
}
