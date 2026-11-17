//! The "Writer system block" (spec `SPECs/native-agent-spec.md`, "Writer system block"): the
//! short, fixed guidance on how to work in a Writer vault that opens the text of
//! `--append-system-prompt` for EVERY chat, plain or project. Tauri-free, one function.
//!
//! It states only what nothing else sent says: the references footer (`context-text.ts`), the
//! project manifest and the shadowed-instructions audit (`project_context.rs`) keep their own
//! text. Lines naming the `writer` command are included only when the managed skills are
//! installed for the spawned CLI ([`crate::managed_skills::claude_skills_installed`]), so the
//! prompt never names a tool that is not there.

use super::roles::Rendered;

/// The block's size budget in characters (about 500 tokens at 4 characters per token). A test
/// fails above it: grow the block only by replacing text.
pub const MAX_CHARS: usize = 2000;

const HEADER: &str = "## Writer environment";

/// Lines that hold with or without the `writer` CLI.
const INTRO: &str = "The working directory is a vault of Markdown notes, with optional code and skill files. The user reviews your note edits as a changes card; do not paste full diffs back.";
const READ_EDIT: &str = "Read a note with Read before editing it. Make minimal, targeted Edit changes; use Write only to create files.";
const FRONTMATTER: &str = "Preserve YAML frontmatter: keys, order, quoting, comments.";
const LINKS: &str = "Wikilinks resolve by file name, never by title. Attached `@` references are authoritative paths; read them first.";
const FORBIDDEN: &str = "Never touch .obsidian/, .git/, .writer/ or secret files. If a requested path is outside the vault, say so instead of working around it.";
const FINDING: &str = "Find files with Glob and Grep, not Bash find or grep.";

/// Without the CLI the generic rule stands alone.
const BASH_PLAIN: &str = "Use Bash only when no dedicated tool fits.";
const MOVE_PLAIN: &str = "Never rename or move notes with mv or Bash (links would break); ask the user to rename them in Writer.";

/// With the CLI.
const BASH_CLI: &str = "Use Bash only when no dedicated tool or `writer` command fits.";
const MOVE_CLI: &str = "Rename or move notes only with `writer rename` and `writer move`, which rewrite every link; never mv.";
const PROPERTIES_CLI: &str = "Change properties with `writer property:set`, not by editing YAML.";
const SEARCH_CLI: &str = "Before grepping the whole vault, try `writer search`, `writer backlinks`, `writer links`, `writer bases` and `writer base:query` (skills writer-cli, writer-search, writer-bases).";

/// Orchestration (setting `agent.orchestrate`): the line is rendered from the roles the backend
/// adapter actually produced for the session (`roles.rs`, `subagents.rs`). The fixed sentences are
/// backend-neutral (no vendor or tool name); the backend supplies how it says "launch a sub-agent"
/// ([`Rendered::launch`]) and each role its own delegation sentence.
const ORCHESTRATE_OPEN: &str = "Orchestrate by default: split the work into independent parts and run sub-agents in parallel (several {launch} in one message).";
const ORCHESTRATE_CLOSE: &str = "Do the work yourself only when it is very simple and fast: a single read, a one-line edit, a direct answer.";

/// The orchestration line for the roles an adapter produced; `None` when it produced none.
fn orchestration_line(rendered: &Rendered) -> Option<String> {
    if rendered.roles.is_empty() {
        return None;
    }
    let mut parts = vec![ORCHESTRATE_OPEN.replace("{launch}", rendered.launch)];
    parts.extend(rendered.roles.iter().map(|r| r.delegation.clone()));
    parts.push(ORCHESTRATE_CLOSE.to_string());
    Some(parts.join(" "))
}

/// The block for a chat whose CLI sees the managed `writer` skills (`writer_cli`) or not, with
/// the orchestration line when the adapter produced `orchestration` roles.
pub fn render(writer_cli: bool, orchestration: Option<&Rendered>) -> String {
    let mut lines = vec![INTRO, READ_EDIT, FRONTMATTER];
    if writer_cli {
        lines.push(PROPERTIES_CLI);
    }
    lines.push(LINKS);
    lines.push(if writer_cli { MOVE_CLI } else { MOVE_PLAIN });
    lines.push(FORBIDDEN);
    lines.push(FINDING);
    if writer_cli {
        lines.push(SEARCH_CLI);
    }
    lines.push(if writer_cli { BASH_CLI } else { BASH_PLAIN });
    let orchestrate_line = orchestration.and_then(orchestration_line);
    if let Some(line) = &orchestrate_line {
        lines.push(line);
    }
    let mut out = String::from(HEADER);
    out.push('\n');
    out.push_str(lines[0]);
    out.push('\n');
    for l in &lines[1..] {
        out.push_str("- ");
        out.push_str(l);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::roles::{Flags, RenderInput, RoleAdapter};
    use crate::agent::subagents::ClaudeAdapter;
    use crate::cli::registry;
    use crate::managed_skills::all_skills;

    /// What the Claude adapter produces for a session; `worker` too when its requirement is met.
    fn roles(writer_cli: bool, worker: bool) -> Rendered {
        ClaudeAdapter.render(&RenderInput {
            writer_cli,
            tier_models: &Default::default(),
            flags: &Flags::current().with("changes-coverage", worker),
        })
    }

    /// The pinned text of both variants (spec "Writer system block"): change it here and in the
    /// spec together.
    const GOLDEN_PLAIN: &str = "\
## Writer environment
The working directory is a vault of Markdown notes, with optional code and skill files. The user reviews your note edits as a changes card; do not paste full diffs back.
- Read a note with Read before editing it. Make minimal, targeted Edit changes; use Write only to create files.
- Preserve YAML frontmatter: keys, order, quoting, comments.
- Wikilinks resolve by file name, never by title. Attached `@` references are authoritative paths; read them first.
- Never rename or move notes with mv or Bash (links would break); ask the user to rename them in Writer.
- Never touch .obsidian/, .git/, .writer/ or secret files. If a requested path is outside the vault, say so instead of working around it.
- Find files with Glob and Grep, not Bash find or grep.
- Use Bash only when no dedicated tool fits.
";

    const GOLDEN_CLI: &str = "\
## Writer environment
The working directory is a vault of Markdown notes, with optional code and skill files. The user reviews your note edits as a changes card; do not paste full diffs back.
- Read a note with Read before editing it. Make minimal, targeted Edit changes; use Write only to create files.
- Preserve YAML frontmatter: keys, order, quoting, comments.
- Change properties with `writer property:set`, not by editing YAML.
- Wikilinks resolve by file name, never by title. Attached `@` references are authoritative paths; read them first.
- Rename or move notes only with `writer rename` and `writer move`, which rewrite every link; never mv.
- Never touch .obsidian/, .git/, .writer/ or secret files. If a requested path is outside the vault, say so instead of working around it.
- Find files with Glob and Grep, not Bash find or grep.
- Before grepping the whole vault, try `writer search`, `writer backlinks`, `writer links`, `writer bases` and `writer base:query` (skills writer-cli, writer-search, writer-bases).
- Use Bash only when no dedicated tool or `writer` command fits.
";

    const ORCHESTRATE_PLAIN: &str = "- Orchestrate by default: split the work into independent parts and run sub-agents in parallel (several Agent/Task calls in one message). Delegate mechanical work (exploring and searching the vault, reading many notes, summarising) to `writer-explorer`, a cheap read-only sub-agent that returns paths and short findings. Do the work yourself only when it is very simple and fast: a single read, a one-line edit, a direct answer.\n";
    const ORCHESTRATE_CLI: &str = "- Orchestrate by default: split the work into independent parts and run sub-agents in parallel (several Agent/Task calls in one message). Delegate mechanical work (exploring and searching the vault, reading many notes, `writer` queries, summarising) to `writer-explorer`, a cheap read-only sub-agent that returns paths and short findings. Do the work yourself only when it is very simple and fast: a single read, a one-line edit, a direct answer.\n";

    #[test]
    fn golden_text_of_both_variants() {
        assert_eq!(render(false, None), GOLDEN_PLAIN);
        assert_eq!(render(true, None), GOLDEN_CLI);
        // the explorer-only rendering reproduces the line as it was before the roles registry
        assert_eq!(
            render(false, Some(&roles(false, false))),
            format!("{GOLDEN_PLAIN}{ORCHESTRATE_PLAIN}")
        );
        assert_eq!(
            render(true, Some(&roles(true, false))),
            format!("{GOLDEN_CLI}{ORCHESTRATE_CLI}")
        );
    }

    /// The orchestration line with both roles offered (the default), CLI lines present.
    const ORCHESTRATE_CLI_WORKER: &str = "- Orchestrate by default: split the work into independent parts and run sub-agents in parallel (several Agent/Task calls in one message). Delegate mechanical work (exploring and searching the vault, reading many notes, `writer` queries, summarising) to `writer-explorer`, a cheap read-only sub-agent that returns paths and short findings. Delegate bounded edits to named notes to `writer-worker`, a sub-agent that edits only the notes you name and reports one line per file (give parallel workers different files). Do the work yourself only when it is very simple and fast: a single read, a one-line edit, a direct answer.\n";

    #[test]
    fn golden_orchestration_line_with_the_worker() {
        assert_eq!(
            render(true, Some(&roles(true, true))),
            format!("{GOLDEN_CLI}{ORCHESTRATE_CLI_WORKER}")
        );
    }

    /// With the worker offered the line gains exactly its delegation sentence.
    #[test]
    fn the_worker_sentence_is_present_only_when_the_worker_is_rendered() {
        let with = render(true, Some(&roles(true, true)));
        let without = render(true, Some(&roles(true, false)));
        assert!(with.contains("Delegate bounded edits to named notes to `writer-worker`"));
        assert!(!without.contains("writer-worker"));
        assert!(with.contains("`writer-explorer`"));
    }

    #[test]
    fn no_roles_means_no_orchestration_line() {
        assert_eq!(render(false, Some(&Rendered::none())), GOLDEN_PLAIN);
        assert_eq!(render(true, None), GOLDEN_CLI);
    }

    /// The fixed sentences name no vendor and no tool; the backend and the roles supply those.
    #[test]
    fn the_orchestration_template_is_neutral() {
        let fake = Rendered {
            config: None,
            launch: "launches",
            roles: vec![crate::agent::roles::RenderedRole {
                id: "x".into(),
                name: "writer-x".into(),
                delegation: "Delegate x to `writer-x`.".into(),
            }],
        };
        let line = orchestration_line(&fake).unwrap();
        for word in [
            "Agent", "Task", "Read", "Glob", "Grep", "Bash", "Edit", "Write", "Claude", "haiku",
            "sonnet", "opus",
        ] {
            assert!(
                !line
                    .split(|c: char| !c.is_alphanumeric())
                    .any(|w| w == word),
                "the template names {word}"
            );
        }
    }

    #[test]
    fn stays_within_the_budget() {
        for cli in [false, true] {
            for worker in [false, true] {
                let r = roles(cli, worker);
                for o in [None, Some(&r)] {
                    let n = render(cli, o).chars().count();
                    assert!(
                        n <= MAX_CHARS,
                        "block (cli={cli}, worker={worker}, orchestrated={}) is {n} chars, budget {MAX_CHARS}",
                        o.is_some()
                    );
                }
            }
        }
    }

    #[test]
    fn plain_variant_names_no_writer_command() {
        assert!(!render(false, None).contains("`writer"));
        // `writer-explorer` and `writer-worker` are sub-agents, not the CLI
        assert!(!render(false, Some(&roles(false, true)))
            .replace("`writer-explorer`", "")
            .replace("`writer-worker`", "")
            .contains("`writer"));
    }

    /// Every `writer <name>` in backticks is a registered command that a bundled skill documents.
    #[test]
    fn every_named_command_exists_and_is_documented() {
        let skills: String = all_skills()
            .flat_map(|s| s.files.iter().map(|f| f.content))
            .collect::<Vec<_>>()
            .join("\n");
        let text = render(true, Some(&roles(true, true)));
        let mut seen = 0;
        for chunk in text.split("`writer ").skip(1) {
            let name = chunk.split('`').next().unwrap();
            let name = name.split_whitespace().next().unwrap();
            assert!(
                registry::find(name).is_some(),
                "`writer {name}` is not in the registry"
            );
            assert!(
                skills.contains(&format!("writer {name}")) || skills.contains(&format!("`{name}`")),
                "`writer {name}` is not documented by a managed skill"
            );
            seen += 1;
        }
        assert!(seen >= 7, "expected the named commands, found {seen}");
    }

    /// The default `agent.allowed-tools` allow only `Bash(writer <read-only command> ...)`: each
    /// command is registered and none writes (a write command in the list fails here).
    #[test]
    fn default_allowed_tools_are_read_only_registered_commands() {
        const WRITES: &[&str] = &[
            "create",
            "append",
            "prepend",
            "move",
            "rename",
            "title",
            "delete",
            "property:set",
            "property:remove",
            "task",
            "base:create",
            "skills:sync",
        ];
        let def = crate::config::settings_schema()
            .into_iter()
            .find(|d| d.key == "agent.allowed-tools")
            .unwrap();
        let crate::config::ConfigValue::List(rules) = def.default else {
            panic!("a list")
        };
        assert!(!rules.is_empty());
        for r in rules {
            let inner = r
                .strip_prefix("Bash(writer ")
                .and_then(|x| x.strip_suffix(')'))
                .unwrap_or_else(|| panic!("{r}: only Bash(writer ...) rules"));
            let name = inner.split_whitespace().next().unwrap();
            assert!(registry::find(name).is_some(), "{r}: not in the registry");
            assert!(!WRITES.contains(&name), "{r}: writes");
            assert!(!inner.contains(['&', ';', '|', '>']), "{r}");
        }
    }
}
