//! What a project adds to a chat (spec sections 4.3 and 4.5). Tauri-free, no note bodies:
//!
//! - the **source manifest**: per `inclusions` entry the kind, a label, a count and up to 20
//!   sample paths, capped overall, resolved live through a [`SourceIndex`] (the vault index in
//!   the app, a fake in tests); recomputed per send and diffed against the one last sent;
//! - the **instruction audit**: the CLI loads `CLAUDE.md` from the working directory and every
//!   parent, falling back to `AGENTS.md` in a directory without one. An `AGENTS.md` is
//!   "shadowed" (and Writer injects its text through `--append-system-prompt`) only when its
//!   directory also holds a `CLAUDE.md` that does not import it, or the CLI is older than the
//!   verified version, or the setting forces `always`;
//! - [`build`], which assembles the appended system prompt from both.
//!
//! Writer never creates or edits a `CLAUDE.md`.

use super::events::{AgentPermissionMode, ProjectSource};
use super::mcp_wiring::ToolsAdapter;
use super::ports::{InjectAgentsMd, ProjectPort, SpawnContext};
use super::project::{self, ProjectDetail, ProjectUpdate, AGENTS_FILE, CLAUDE_FILE};
use super::roles::Rendered;
use super::writer_prompt::{self, MemoryNote};
use crate::index::{FileFilter, Index};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Samples listed per source.
pub const SAMPLES_PER_SOURCE: usize = 20;
/// Sample paths listed over all sources; the rest is "and N more".
pub const MAX_LISTED_PATHS: usize = 100;
/// Inline injection cap for an `AGENTS.md`; larger files are referenced by path.
pub const MAX_INJECT_BYTES: u64 = 64 * 1024;
/// Rows fetched per source so exclusions can be applied before sampling.
const FETCH_ROWS: u32 = 500;
/// The first CLI version where the `AGENTS.md` fallback was verified (spec A.6).
pub const VERIFIED_CLI: (u32, u32, u32) = (2, 1, 325);

// -------------------------------------------------------------------------------------------
// Index port

#[derive(Debug, Clone, PartialEq)]
pub enum SourceQuery {
    /// Notes inside a vault-relative folder (recursive).
    Folder(String),
    /// Notes carrying a tag (nested tags included).
    Tag(String),
    /// Notes whose frontmatter defines the property (the value is not queryable here).
    HasProperty(String),
    /// Notes whose file name equals `name` (with `.md`), or whose path equals it.
    Note(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct QueryHits {
    /// Matches before the row limit.
    pub total: usize,
    /// Up to [`FETCH_ROWS`] vault-relative paths.
    pub paths: Vec<String>,
}

/// Read-only view of the vault index the manifest needs.
pub trait SourceIndex {
    fn query(&self, q: &SourceQuery) -> Result<QueryHits, String>;
}

impl SourceIndex for Index {
    fn query(&self, q: &SourceQuery) -> Result<QueryHits, String> {
        let mut f = FileFilter {
            ext: Some("md".into()),
            limit: Some(FETCH_ROWS),
            ..Default::default()
        };
        match q {
            SourceQuery::Folder(p) => f.folder = Some(p.clone()),
            SourceQuery::Tag(t) => f.tag = Some(t.clone()),
            SourceQuery::HasProperty(p) => f.has_property = Some(p.clone()),
            SourceQuery::Note(p) => {
                let stem = p.rsplit('/').next().unwrap_or(p);
                f.name_contains = Some(stem.trim_end_matches(".md").to_string());
                f.limit = Some(200);
            }
        }
        let page = self.query_files(&f).map_err(|e| e.to_string())?;
        let mut paths: Vec<String> = page.rows.iter().map(|r| r.path.clone()).collect();
        let mut total = page.total.max(0) as usize;
        if let SourceQuery::Note(p) = q {
            paths.retain(|x| {
                x == p
                    || (!p.contains('/')
                        && x.rsplit('/')
                            .next()
                            .is_some_and(|n| n.eq_ignore_ascii_case(p)))
            });
            total = paths.len();
        }
        Ok(QueryHits { total, paths })
    }
}

/// Folder-walk [`SourceIndex`] for callers that have no index handle (the spawn port only knows
/// the vault root). Folders and notes resolve; tags and properties answer `Err`, which the
/// manifest shows as "not counted" and leaves for the agent's `writer` CLI skills. Dot folders
/// and `node_modules` are skipped like the index does; the walk is bounded.
#[derive(Debug, Default)]
pub struct FsSourceIndex {
    pub root: std::path::PathBuf,
}

const WALK_MAX_DIRS: usize = 20_000;
const WALK_MAX_FILES: usize = 50_000;

impl FsSourceIndex {
    fn walk(&self, start_rel: &str) -> Vec<String> {
        let mut out = Vec::new();
        let start = if start_rel.is_empty() {
            self.root.clone()
        } else {
            self.root.join(start_rel)
        };
        let mut stack = vec![(start, start_rel.to_string())];
        let mut dirs = 0usize;
        while let Some((dir, rel)) = stack.pop() {
            dirs += 1;
            if dirs > WALK_MAX_DIRS || out.len() >= WALK_MAX_FILES {
                break;
            }
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for e in rd.flatten() {
                let Ok(ft) = e.file_type() else { continue };
                let Some(name) = e.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                let child = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{rel}/{name}")
                };
                if ft.is_dir() {
                    stack.push((e.path(), child));
                } else if ft.is_file() && name.to_ascii_lowercase().ends_with(".md") {
                    out.push(child);
                }
            }
        }
        out.sort();
        out
    }
}

impl SourceIndex for FsSourceIndex {
    fn query(&self, q: &SourceQuery) -> Result<QueryHits, String> {
        let (total, mut paths) = match q {
            SourceQuery::Folder(p) => {
                let all = self.walk(p);
                (all.len(), all)
            }
            SourceQuery::Note(p) => {
                let all: Vec<String> = if p.contains('/') {
                    if self.root.join(p).is_file() {
                        vec![p.clone()]
                    } else {
                        vec![]
                    }
                } else {
                    self.walk("")
                        .into_iter()
                        .filter(|x| {
                            x.rsplit('/')
                                .next()
                                .is_some_and(|n| n.eq_ignore_ascii_case(p))
                        })
                        .collect()
                };
                (all.len(), all)
            }
            SourceQuery::Tag(_) | SourceQuery::HasProperty(_) => {
                return Err("resolve with the writer CLI".into())
            }
        };
        paths.truncate(FETCH_ROWS as usize);
        Ok(QueryHits { total, paths })
    }
}

// -------------------------------------------------------------------------------------------
// Manifest

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// `folder`, `note`, `tag`, `property`, `url`.
    pub kind: String,
    pub label: String,
    /// `None` when the source could not be resolved (see `warning`).
    pub count: Option<usize>,
    pub samples: Vec<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub entries: Vec<ManifestEntry>,
    /// Sample paths that did not fit under [`MAX_LISTED_PATHS`].
    pub more: usize,
    pub exclusions: Vec<String>,
    /// Unrecognised entries, shown to the user and mentioned to the agent verbatim.
    pub unsupported: Vec<String>,
    pub web_urls: Vec<String>,
    pub youtube_urls: Vec<String>,
}

fn is_excluded(path: &str, excluded_folders: &[String], excluded_notes: &[String]) -> bool {
    excluded_notes.iter().any(|n| n == path)
        || excluded_folders
            .iter()
            .any(|f| path == f || path.starts_with(&format!("{f}/")))
}

fn describe(src: &ProjectSource) -> (&'static str, String, Option<SourceQuery>, Option<String>) {
    match src {
        ProjectSource::Folder { path, .. } => (
            "folder",
            format!("{path}/"),
            Some(SourceQuery::Folder(path.clone())),
            None,
        ),
        ProjectSource::Note { path, .. } => (
            "note",
            path.clone(),
            Some(SourceQuery::Note(path.clone())),
            None,
        ),
        ProjectSource::Tag { tag, .. } => (
            "tag",
            format!("#{tag}"),
            Some(SourceQuery::Tag(tag.clone())),
            None,
        ),
        ProjectSource::Property { name, value, .. } => (
            "property",
            match value {
                Some(v) => format!("{name}:{v}"),
                None => format!("{name}:*"),
            },
            Some(SourceQuery::HasProperty(name.clone())),
            value.as_ref().map(|_| {
                "counted by property name only; the agent should filter by value".to_string()
            }),
        ),
        ProjectSource::Url { url, .. } => ("url", url.clone(), None, None),
    }
}

/// Resolve the project's inclusions against the index into a [`Manifest`]. Exclusions of folder
/// and note shape remove paths; tag and property exclusions are listed for the agent but not
/// applied to counts.
pub fn build_manifest(project: &ProjectDetail, index: &dyn SourceIndex) -> Manifest {
    let mut excluded_folders = Vec::new();
    let mut excluded_notes = Vec::new();
    let mut exclusions = Vec::new();
    for e in &project.info.exclusions {
        match e {
            ProjectSource::Folder { path, raw } => {
                excluded_folders.push(path.clone());
                exclusions.push(raw.clone());
            }
            ProjectSource::Note { path, raw } => {
                excluded_notes.push(path.clone());
                exclusions.push(raw.clone());
            }
            ProjectSource::Tag { raw, .. }
            | ProjectSource::Property { raw, .. }
            | ProjectSource::Url { raw, .. } => exclusions.push(raw.clone()),
        }
    }
    let mut entries = Vec::new();
    let mut listed = 0usize;
    let mut more = 0usize;
    for src in &project.info.inclusions {
        let (kind, label, query, warning) = describe(src);
        let Some(query) = query else {
            entries.push(ManifestEntry {
                kind: kind.into(),
                label,
                count: None,
                samples: vec![],
                warning: None,
            });
            continue;
        };
        match index.query(&query) {
            Ok(hits) => {
                let kept: Vec<String> = hits
                    .paths
                    .iter()
                    .filter(|p| !is_excluded(p, &excluded_folders, &excluded_notes))
                    .cloned()
                    .collect();
                let removed = hits.paths.len() - kept.len();
                let count = hits.total.saturating_sub(removed);
                let room = MAX_LISTED_PATHS.saturating_sub(listed);
                let take = kept.len().min(SAMPLES_PER_SOURCE).min(room);
                more += kept.len().min(SAMPLES_PER_SOURCE) - take;
                listed += take;
                entries.push(ManifestEntry {
                    kind: kind.into(),
                    label,
                    count: Some(count),
                    samples: kept.into_iter().take(take).collect(),
                    warning: warning
                        .or_else(|| (count == 0).then(|| "matches no notes".to_string())),
                });
            }
            Err(e) => {
                entries.push(ManifestEntry {
                    kind: kind.into(),
                    label,
                    count: None,
                    samples: vec![],
                    warning: Some(format!("not counted: {e}")),
                });
            }
        }
    }
    Manifest {
        entries,
        more,
        exclusions,
        unsupported: project.unsupported.clone(),
        web_urls: project.web_urls.clone(),
        youtube_urls: project.youtube_urls.clone(),
    }
}

impl Manifest {
    /// The exact text sent to the agent (and shown by "Preview manifest").
    pub fn render(&self) -> String {
        let mut out = String::new();
        if self.entries.is_empty() && self.web_urls.is_empty() && self.youtube_urls.is_empty() {
            return out;
        }
        for e in &self.entries {
            match e.count {
                Some(n) => out.push_str(&format!(
                    "- {} {} ({} note{})",
                    e.kind,
                    e.label,
                    n,
                    if n == 1 { "" } else { "s" }
                )),
                None => out.push_str(&format!("- {} {}", e.kind, e.label)),
            }
            if let Some(w) = &e.warning {
                out.push_str(&format!(" [{w}]"));
            }
            out.push('\n');
            for s in &e.samples {
                out.push_str(&format!("    {s}\n"));
            }
        }
        if self.more > 0 {
            out.push_str(&format!(
                "- and {} more listed paths not shown\n",
                self.more
            ));
        }
        if !self.exclusions.is_empty() {
            out.push_str(&format!("- excluded: {}\n", self.exclusions.join(", ")));
        }
        if !self.unsupported.is_empty() {
            out.push_str(&format!(
                "- unrecognised entries (ignore or ask the user): {}\n",
                self.unsupported.join(", ")
            ));
        }
        for u in self.web_urls.iter().chain(&self.youtube_urls) {
            out.push_str(&format!("- url {u} (by reference only)\n"));
        }
        out
    }
}

/// A one-message diff against the manifest last sent: `None` when nothing changed.
pub fn diff_manifests(prev: &Manifest, next: &Manifest) -> Option<String> {
    let mut lines = Vec::new();
    for e in &next.entries {
        match prev
            .entries
            .iter()
            .find(|p| p.label == e.label && p.kind == e.kind)
        {
            None => lines.push(format!(
                "+ source {} ({} notes)",
                e.label,
                e.count.unwrap_or(0)
            )),
            Some(p) => {
                let added: Vec<&String> = e
                    .samples
                    .iter()
                    .filter(|s| !p.samples.contains(s))
                    .collect();
                let removed: Vec<&String> = p
                    .samples
                    .iter()
                    .filter(|s| !e.samples.contains(s))
                    .collect();
                if p.count != e.count || !added.is_empty() || !removed.is_empty() {
                    let mut l = format!(
                        "~ {}: {} -> {} notes",
                        e.label,
                        p.count.map_or("?".to_string(), |n| n.to_string()),
                        e.count.map_or("?".to_string(), |n| n.to_string())
                    );
                    for a in added {
                        l.push_str(&format!("\n    + {a}"));
                    }
                    for r in removed {
                        l.push_str(&format!("\n    - {r}"));
                    }
                    lines.push(l);
                }
            }
        }
    }
    for p in &prev.entries {
        if !next
            .entries
            .iter()
            .any(|e| e.label == p.label && e.kind == p.kind)
        {
            lines.push(format!("- source {}", p.label));
        }
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

// -------------------------------------------------------------------------------------------
// Instruction audit

/// `agent.inject-agents-md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum InjectMode {
    #[default]
    Auto,
    Always,
    Never,
}

/// Is `version` (`"2.1.325"` or `"2.1.325 (Claude Code)"`) older than [`VERIFIED_CLI`]? An
/// unparsable or missing version is treated as current.
pub fn cli_is_older(version: Option<&str>) -> bool {
    let Some(v) = version else { return false };
    let first = v.split_whitespace().next().unwrap_or("");
    let nums: Vec<u32> = first
        .split('.')
        .map_while(|p| p.parse::<u32>().ok())
        .collect();
    if nums.len() < 3 {
        return false;
    }
    (nums[0], nums[1], nums[2]) < VERIFIED_CLI
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum InstructionStatus {
    /// The CLI loads it itself (`AGENTS.md` alone, or imported by `CLAUDE.md`).
    LoadedByCli,
    /// Writer appends it to the system prompt, with the reason.
    Injected { reason: String },
    /// Setting `never`.
    NotInjected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstructionAudit {
    /// Vault-relative directory ("" for the vault root).
    pub dir: String,
    pub status: InstructionStatus,
    /// Injected inline text (`None` for a file over the cap, which is referenced by path).
    pub text: Option<String>,
    pub bytes: u64,
}

impl InstructionAudit {
    pub fn path(&self) -> String {
        if self.dir.is_empty() {
            AGENTS_FILE.to_string()
        } else {
            format!("{}/{AGENTS_FILE}", self.dir)
        }
    }
}

fn imports_agents(claude_md: &str) -> bool {
    claude_md.contains("@AGENTS.md") || claude_md.contains("@./AGENTS.md")
}

/// Audit one directory (two `exists` checks and at most one small read).
pub fn audit_dir(
    dir_abs: &Path,
    dir_rel: &str,
    mode: InjectMode,
    cli_old: bool,
) -> std::io::Result<Option<InstructionAudit>> {
    let agents = dir_abs.join(AGENTS_FILE);
    let meta = match std::fs::metadata(&agents) {
        Ok(m) if m.is_file() => m,
        _ => return Ok(None),
    };
    let make = |status: InstructionStatus| -> std::io::Result<Option<InstructionAudit>> {
        let inject = matches!(status, InstructionStatus::Injected { .. });
        let text = if inject && meta.len() <= MAX_INJECT_BYTES {
            Some(String::from_utf8_lossy(&std::fs::read(&agents)?).into_owned())
        } else {
            None
        };
        Ok(Some(InstructionAudit {
            dir: dir_rel.to_string(),
            status,
            text,
            bytes: meta.len(),
        }))
    };
    if mode == InjectMode::Never {
        return make(InstructionStatus::NotInjected);
    }
    if mode == InjectMode::Always {
        return make(InstructionStatus::Injected {
            reason: "forced by setting".into(),
        });
    }
    if cli_old {
        return make(InstructionStatus::Injected {
            reason: "Claude Code is older than the verified version".into(),
        });
    }
    let claude = dir_abs.join(CLAUDE_FILE);
    match std::fs::metadata(&claude) {
        Ok(m) if m.is_file() => {
            let take = m.len().min(1024 * 1024);
            let mut buf = Vec::new();
            use std::io::Read;
            std::fs::File::open(&claude)?
                .take(take)
                .read_to_end(&mut buf)?;
            if imports_agents(&String::from_utf8_lossy(&buf)) {
                make(InstructionStatus::LoadedByCli)
            } else {
                make(InstructionStatus::Injected {
                    reason: "shadowed by CLAUDE.md".into(),
                })
            }
        }
        _ => make(InstructionStatus::LoadedByCli),
    }
}

// -------------------------------------------------------------------------------------------
// Bundle

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextBundle {
    /// Value for `--append-system-prompt`: the Writer block, then instructions, then the project.
    pub append_system_prompt: Option<String>,
    pub manifest: Option<Manifest>,
    pub manifest_text: Option<String>,
    /// Vault root first, project folder last.
    pub instructions: Vec<InstructionAudit>,
}

pub struct BundleInput<'a> {
    /// Canonical vault root.
    pub root: &'a Path,
    pub project: Option<&'a ProjectDetail>,
    pub mode: InjectMode,
    pub cli_version: Option<&'a str>,
    pub index: Option<&'a dyn SourceIndex>,
    /// The managed `writer` skills are installed for the spawned CLI (selects the Writer block's
    /// variant).
    pub writer_cli: bool,
    /// The sub-agent roles the adapter produced (`None`: orchestration is off): the Writer block's
    /// orchestration line is rendered from them.
    pub orchestration: Option<&'a Rendered>,
    /// The Writer block's memory line (`None`: no memory line).
    pub memory: Option<MemoryNote<'a>>,
    /// The chat's backend: how its Writer block names Writer's tools.
    pub tools: &'a dyn ToolsAdapter,
}

/// The Writer system block for a chat: the vault's folder name and, for a project chat, its name
/// and vault-relative folder (never the absolute path).
fn writer_block(input: &BundleInput) -> String {
    let vault = input
        .root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    writer_prompt::render(&writer_prompt::PromptInput {
        writer_cli: input.writer_cli,
        orchestration: input.orchestration,
        memory: input.memory,
        tools: input.tools,
        place: writer_prompt::Place {
            vault,
            project: input
                .project
                .map(|p| (p.info.name.as_str(), p.info.path.as_str())),
        },
    })
}

/// Build the per-spawn context. Text only, no note bodies (a shadowed `AGENTS.md` is the one
/// file whose text is included, by design).
pub fn build(input: &BundleInput) -> std::io::Result<ContextBundle> {
    let cli_old = cli_is_older(input.cli_version);
    let mut instructions = Vec::new();
    if let Some(a) = audit_dir(input.root, "", input.mode, cli_old)? {
        instructions.push(a);
    }
    if let Some(p) = input.project {
        let dir = input.root.join(&p.info.path);
        if let Some(a) = audit_dir(&dir, &p.info.path, input.mode, cli_old)? {
            instructions.push(a);
        }
    }
    let manifest = match (input.project, input.index) {
        (Some(p), Some(ix)) => Some(build_manifest(p, ix)),
        (Some(p), None) => Some(Manifest {
            exclusions: vec![],
            unsupported: p.unsupported.clone(),
            web_urls: p.web_urls.clone(),
            youtube_urls: p.youtube_urls.clone(),
            entries: p
                .info
                .inclusions
                .iter()
                .map(|s| {
                    let (kind, label, _, _) = describe(s);
                    ManifestEntry {
                        kind: kind.into(),
                        label,
                        count: None,
                        samples: vec![],
                        warning: Some("not resolved".into()),
                    }
                })
                .collect(),
            more: 0,
        }),
        _ => None,
    };
    let manifest_text = manifest
        .as_ref()
        .map(Manifest::render)
        .filter(|t| !t.is_empty());

    // The Writer system block opens every prompt, before the instruction files and the project.
    let mut sections: Vec<String> = vec![writer_block(input)];
    let injected: Vec<&InstructionAudit> = instructions
        .iter()
        .filter(|a| matches!(a.status, InstructionStatus::Injected { .. }))
        .collect();
    if !injected.is_empty() {
        let mut s = String::from(
            "The following instruction files are not loaded automatically; follow them. Later instructions take precedence over earlier ones.\n",
        );
        for a in injected {
            match &a.text {
                Some(t) => s.push_str(&format!("\n### {}\n\n{}\n", a.path(), t.trim_end())),
                None => s.push_str(&format!(
                    "\n### {}\n\nThis file is large; read it with your file tools before starting: {}\n",
                    a.path(),
                    a.path()
                )),
            }
        }
        sections.push(s);
    }
    if let Some(p) = input.project {
        let mut s = format!("## Project: {}\n", p.info.name);
        if !p.info.description.trim().is_empty() {
            s.push_str(&format!("{}\n", p.info.description.trim()));
        }
        s.push_str(&format!("Project folder: {}\n", p.info.path));
        if let Some(t) = &manifest_text {
            s.push_str(
                "\nContext sources of this project (a focus aid, not a boundary). Read notes on demand; resolve tags and properties with the writer CLI skills (writer-search, writer-bases):\n",
            );
            s.push_str(t);
        }
        sections.push(s);
    }
    let append_system_prompt = (!sections.is_empty()).then(|| sections.join("\n"));
    Ok(ContextBundle {
        append_system_prompt,
        manifest,
        manifest_text,
        instructions,
    })
}

// -------------------------------------------------------------------------------------------
// The lane 1 port

/// [`ProjectPort`] over `project.rs` and [`build`]; install with
/// `AgentPorts::set_project(Arc::new(ProjectLibrary))`.
#[derive(Debug, Default)]
pub struct ProjectLibrary;

fn inject_mode(m: InjectAgentsMd) -> InjectMode {
    match m {
        InjectAgentsMd::Auto => InjectMode::Auto,
        InjectAgentsMd::Always => InjectMode::Always,
        InjectAgentsMd::Never => InjectMode::Never,
    }
}

impl ProjectPort for ProjectLibrary {
    fn resolve_cwd(
        &self,
        root: &Path,
        project_path: Option<&str>,
    ) -> Result<std::path::PathBuf, String> {
        project::resolve_cwd(root, project_path).map_err(|e| e.to_string())
    }

    fn append_system_prompt(&self, ctx: &SpawnContext<'_>) -> Result<Option<String>, String> {
        // A folder without a valid project.md is a plain folder chat: root-level audit only.
        let detail = match ctx.project_path.filter(|p| !p.is_empty()) {
            Some(p) => match project::read(ctx.root, p) {
                Ok(d) => Some(d),
                Err(project::ProjectError::NotFound(_)) => None,
                Err(e) => return Err(e.to_string()),
            },
            None => None,
        };
        let fs_index = FsSourceIndex {
            root: ctx.root.to_path_buf(),
        };
        let bundle = build(&BundleInput {
            root: ctx.root,
            project: detail.as_ref(),
            mode: inject_mode(ctx.inject_agents_md),
            cli_version: ctx.cli_version,
            index: Some(&fs_index),
            writer_cli: ctx.writer_cli,
            orchestration: ctx.orchestration,
            memory: ctx.memory,
            tools: ctx.tools,
        })
        .map_err(|e| e.to_string())?;
        Ok(
            match (
                ctx.requested_prompt.filter(|r| !r.trim().is_empty()),
                bundle.append_system_prompt,
            ) {
                (Some(r), Some(ours)) => Some(format!("{r}\n\n{ours}")),
                (Some(r), None) => Some(r.to_string()),
                (None, ours) => ours,
            },
        )
    }

    fn project_permission_mode(
        &self,
        root: &Path,
        project_path: Option<&str>,
    ) -> Option<AgentPermissionMode> {
        let detail = project::read(root, project_path?).ok()?;
        match detail.agent_mode.as_deref() {
            Some("acceptEdits") => Some(AgentPermissionMode::AcceptEdits),
            Some("manual") => Some(AgentPermissionMode::Manual),
            _ => None,
        }
    }

    fn touch_last_used(&self, root: &Path, project_path: &str) {
        let now = project::now_ms();
        let up = ProjectUpdate {
            touch_last_used: true,
            ..Default::default()
        };
        if let Err(e) = project::update(root, project_path, &up, now) {
            log::warn!("could not update a project's last-used time: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::claude_adapter::ClaudeAdapter;
    use crate::agent::events::NewProjectRequest;
    use crate::agent::project::{self, ProjectUpdate};
    use std::collections::HashMap;
    use tempfile::TempDir;

    struct Fake(HashMap<String, Vec<String>>);
    impl SourceIndex for Fake {
        fn query(&self, q: &SourceQuery) -> Result<QueryHits, String> {
            let key = match q {
                SourceQuery::Folder(p) => format!("folder:{p}"),
                SourceQuery::Tag(t) => format!("tag:{t}"),
                SourceQuery::HasProperty(p) => format!("prop:{p}"),
                SourceQuery::Note(p) => format!("note:{p}"),
            };
            let paths = self.0.get(&key).cloned().unwrap_or_default();
            Ok(QueryHits {
                total: paths.len(),
                paths,
            })
        }
    }

    /// The Writer block as `build` renders it for a bare chat (no orchestration, no memory).
    fn expected_block(root: &Path, project: Option<&ProjectDetail>, writer_cli: bool) -> String {
        writer_block(&BundleInput {
            root,
            project,
            mode: InjectMode::Auto,
            cli_version: None,
            index: None,
            writer_cli,
            orchestration: None,
            memory: None,
            tools: &ClaudeAdapter,
        })
    }

    #[test]
    fn the_block_names_the_vault_folder_and_the_project_by_relative_path() {
        let (_d, root, p) = project_with(&[], &[]);
        let vault = root.file_name().unwrap().to_str().unwrap();
        let text = expected_block(&root, Some(&p), false);
        assert!(text.contains(&format!(
            "Vault: {vault}. Working in project P (`Projects/P`).\n"
        )));
        assert!(!text.contains(root.to_str().unwrap()), "no absolute path");
        assert!(expected_block(&root, None, false).contains("Working at the vault root."));
    }

    fn project_with(
        inclusions: &[&str],
        exclusions: &[&str],
    ) -> (TempDir, std::path::PathBuf, ProjectDetail) {
        let d = TempDir::new().unwrap();
        let root = d.path().canonicalize().unwrap();
        project::create(
            &root,
            &NewProjectRequest {
                name: "P".into(),
                parent: None,
                description: "Desc".into(),
                inclusions: inclusions.iter().map(|s| s.to_string()).collect(),
                instructions: "Be brief.".into(),
            },
            1,
        )
        .unwrap();
        let p = project::update(
            &root,
            "Projects/P",
            &ProjectUpdate {
                exclusions: Some(exclusions.iter().map(|s| s.to_string()).collect()),
                ..Default::default()
            },
            1,
        )
        .unwrap();
        (d, root, p)
    }

    fn many(prefix: &str, n: usize) -> Vec<String> {
        (0..n).map(|i| format!("{prefix}/n{i:03}.md")).collect()
    }

    #[test]
    fn manifest_caps_samples_per_source_and_overall() {
        let (_d, _r, p) = project_with(&["A/", "B/", "C/", "D/", "E/", "F/"], &[]);
        let mut m = HashMap::new();
        for k in ["A", "B", "C", "D", "E", "F"] {
            m.insert(format!("folder:{k}"), many(k, 30));
        }
        let man = build_manifest(&p, &Fake(m));
        assert_eq!(man.entries.len(), 6);
        assert!(man.entries.iter().all(|e| e.count == Some(30)));
        assert!(man.entries[0].samples.len() == SAMPLES_PER_SOURCE);
        let listed: usize = man.entries.iter().map(|e| e.samples.len()).sum();
        assert_eq!(listed, MAX_LISTED_PATHS);
        assert_eq!(man.more, 6 * SAMPLES_PER_SOURCE - MAX_LISTED_PATHS);
        let text = man.render();
        assert!(text.contains("and 20 more"));
    }

    #[test]
    fn manifest_applies_folder_and_note_exclusions() {
        let (_d, _r, p) = project_with(&["Notes/", "#t"], &["Notes/Private/", "Notes/skip.md"]);
        let mut m = HashMap::new();
        m.insert(
            "folder:Notes".to_string(),
            vec![
                "Notes/a.md".into(),
                "Notes/Private/b.md".into(),
                "Notes/skip.md".into(),
            ],
        );
        m.insert(
            "tag:t".to_string(),
            vec!["x/y.md".into(), "Notes/Private/z.md".into()],
        );
        let man = build_manifest(&p, &Fake(m));
        assert_eq!(man.entries[0].samples, vec!["Notes/a.md"]);
        assert_eq!(man.entries[0].count, Some(1));
        assert_eq!(man.entries[1].samples, vec!["x/y.md"]);
        assert_eq!(man.exclusions.len(), 2);
        assert!(!man.render().contains("Private/b.md"));
    }

    #[test]
    fn manifest_diff() {
        let (_d, _r, p) = project_with(&["A/"], &[]);
        let mk = |paths: Vec<String>| {
            let mut m = HashMap::new();
            m.insert("folder:A".to_string(), paths);
            build_manifest(&p, &Fake(m))
        };
        let a = mk(vec!["A/1.md".into(), "A/2.md".into()]);
        assert_eq!(diff_manifests(&a, &a), None);
        let b = mk(vec!["A/1.md".into(), "A/3.md".into(), "A/4.md".into()]);
        let d = diff_manifests(&a, &b).unwrap();
        assert!(d.contains("2 -> 3 notes"), "{d}");
        assert!(d.contains("+ A/3.md") && d.contains("- A/2.md"), "{d}");
        let empty = Manifest::default();
        assert!(diff_manifests(&empty, &a).unwrap().contains("+ source A/"));
        assert!(diff_manifests(&a, &empty).unwrap().contains("- source A/"));
    }

    #[test]
    fn port_resolves_cwd_builds_prompt_and_reads_mode() {
        let (_d, root, _p) = project_with(&["Notes/"], &[]);
        std::fs::create_dir_all(root.join("Notes")).unwrap();
        std::fs::write(root.join("Notes/a.md"), "x").unwrap();
        std::fs::write(root.join("Projects/P/CLAUDE.md"), "c").unwrap();
        let lib = ProjectLibrary;
        let cwd = lib.resolve_cwd(&root, Some("Projects/P")).unwrap();
        assert_eq!(cwd, root.join("Projects/P"));
        assert!(lib.resolve_cwd(&root, Some("../x")).is_err());
        let ctx = SpawnContext {
            root: &root,
            cwd: &cwd,
            project_path: Some("Projects/P"),
            cli_version: Some("2.1.325"),
            inject_agents_md: InjectAgentsMd::Auto,
            requested_prompt: Some("from ui"),
            writer_cli: false,
            orchestration: None,
            memory: None,
            tools: &ClaudeAdapter,
        };
        let s = lib.append_system_prompt(&ctx).unwrap().unwrap();
        assert!(s.starts_with("from ui\n\n"));
        assert!(s.contains("Be brief.") && s.contains("Notes/a.md"));
        assert_eq!(lib.project_permission_mode(&root, Some("Projects/P")), None);
        project::update(
            &root,
            "Projects/P",
            &ProjectUpdate {
                agent_mode: Some("acceptEdits".into()),
                ..Default::default()
            },
            1,
        )
        .unwrap();
        assert_eq!(
            lib.project_permission_mode(&root, Some("Projects/P")),
            Some(AgentPermissionMode::AcceptEdits)
        );
        lib.touch_last_used(&root, "Projects/P");
        assert!(
            project::read(&root, "Projects/P")
                .unwrap()
                .info
                .last_used_at
                .unwrap()
                > 1_000_000
        );
        // Plain folder chat: no project header, only requested prompt.
        std::fs::create_dir_all(root.join("Plain")).unwrap();
        let ctx2 = SpawnContext {
            project_path: Some("Plain"),
            requested_prompt: None,
            ..ctx
        };
        assert_eq!(
            lib.append_system_prompt(&ctx2).unwrap(),
            Some(expected_block(&root, None, false))
        );
    }

    #[test]
    fn fs_index_resolves_folders_and_notes_only() {
        let d = TempDir::new().unwrap();
        let root = d.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("A/B")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join("A/x.md"), "").unwrap();
        std::fs::write(root.join("A/B/y.md"), "").unwrap();
        std::fs::write(root.join("A/skip.txt"), "").unwrap();
        std::fs::write(root.join(".hidden/z.md"), "").unwrap();
        let ix = FsSourceIndex { root };
        let h = ix.query(&SourceQuery::Folder("A".into())).unwrap();
        assert_eq!(h.paths, vec!["A/B/y.md", "A/x.md"]);
        assert_eq!(
            ix.query(&SourceQuery::Note("y.md".into())).unwrap().paths,
            vec!["A/B/y.md"]
        );
        assert_eq!(
            ix.query(&SourceQuery::Note("A/x.md".into())).unwrap().total,
            1
        );
        assert!(ix.query(&SourceQuery::Tag("t".into())).is_err());
    }

    #[test]
    fn cli_version_gate() {
        assert!(cli_is_older(Some("2.1.324 (Claude Code)")));
        assert!(cli_is_older(Some("1.9.999")));
        assert!(!cli_is_older(Some("2.1.325")));
        assert!(!cli_is_older(Some("2.2.0 (Claude Code)")));
        assert!(!cli_is_older(None));
        assert!(!cli_is_older(Some("weird")));
    }

    fn dir_with(files: &[(&str, &str)]) -> TempDir {
        let d = TempDir::new().unwrap();
        for (n, c) in files {
            std::fs::write(d.path().join(n), c).unwrap();
        }
        d
    }

    fn audit(d: &TempDir, mode: InjectMode, old: bool) -> Option<InstructionAudit> {
        audit_dir(d.path(), "Projects/P", mode, old).unwrap()
    }

    #[test]
    fn shadow_audit_matrix() {
        // AGENTS only: the CLI loads it.
        let d = dir_with(&[("AGENTS.md", "rules")]);
        assert_eq!(
            audit(&d, InjectMode::Auto, false).unwrap().status,
            InstructionStatus::LoadedByCli
        );
        assert!(audit(&d, InjectMode::Auto, false).unwrap().text.is_none());
        // CLAUDE only: nothing to inject.
        let d = dir_with(&[("CLAUDE.md", "x")]);
        assert!(audit(&d, InjectMode::Auto, false).is_none());
        // both, no import: shadowed, injected with its text.
        let d = dir_with(&[("AGENTS.md", "rules"), ("CLAUDE.md", "other")]);
        let a = audit(&d, InjectMode::Auto, false).unwrap();
        assert!(matches!(a.status, InstructionStatus::Injected { .. }));
        assert_eq!(a.text.as_deref(), Some("rules"));
        // both with import: loaded.
        let d = dir_with(&[("AGENTS.md", "rules"), ("CLAUDE.md", "see @AGENTS.md\n")]);
        assert_eq!(
            audit(&d, InjectMode::Auto, false).unwrap().status,
            InstructionStatus::LoadedByCli
        );
        // old CLI: injected even when alone.
        let d = dir_with(&[("AGENTS.md", "rules")]);
        assert!(matches!(
            audit(&d, InjectMode::Auto, true).unwrap().status,
            InstructionStatus::Injected { .. }
        ));
        // forced / disabled.
        assert!(matches!(
            audit(&d, InjectMode::Always, false).unwrap().status,
            InstructionStatus::Injected { .. }
        ));
        let d2 = dir_with(&[("AGENTS.md", "r"), ("CLAUDE.md", "c")]);
        assert_eq!(
            audit(&d2, InjectMode::Never, true).unwrap().status,
            InstructionStatus::NotInjected
        );
        // no AGENTS.md at all.
        let d3 = dir_with(&[]);
        assert!(audit(&d3, InjectMode::Always, true).is_none());
    }

    #[test]
    fn large_agents_md_is_referenced_not_inlined() {
        let big = "x".repeat(MAX_INJECT_BYTES as usize + 1);
        let d = dir_with(&[("AGENTS.md", &big), ("CLAUDE.md", "c")]);
        let a = audit(&d, InjectMode::Auto, false).unwrap();
        assert!(a.text.is_none());
        assert!(matches!(a.status, InstructionStatus::Injected { .. }));
    }

    #[test]
    fn bundle_orders_vault_first_project_last_and_lists_sources() {
        let (_d, root, p) = project_with(&["Notes/"], &[]);
        std::fs::write(root.join("AGENTS.md"), "vault rules").unwrap();
        std::fs::write(root.join("CLAUDE.md"), "claude vault").unwrap();
        std::fs::write(root.join("Projects/P/CLAUDE.md"), "claude project").unwrap();
        let mut m = HashMap::new();
        m.insert("folder:Notes".to_string(), vec!["Notes/a.md".into()]);
        let fake = Fake(m);
        let b = build(&BundleInput {
            root: &root,
            project: Some(&p),
            mode: InjectMode::Auto,
            cli_version: Some("2.1.325 (Claude Code)"),
            index: Some(&fake),
            writer_cli: true,
            orchestration: None,
            memory: None,
            tools: &ClaudeAdapter,
        })
        .unwrap();
        let s = b.append_system_prompt.unwrap();
        let v = s.find("### AGENTS.md").unwrap();
        let pr = s.find("### Projects/P/AGENTS.md").unwrap();
        assert!(v < pr);
        assert!(s.contains("vault rules") && s.contains("Be brief."));
        assert!(s.contains("## Project: P") && s.contains("Notes/a.md"));
        assert_eq!(b.instructions.len(), 2);
    }

    #[test]
    fn bundle_is_the_writer_block_without_project_or_shadow() {
        let d = TempDir::new().unwrap();
        let root = d.path().canonicalize().unwrap();
        let input = |writer_cli| BundleInput {
            root: &root,
            project: None,
            mode: InjectMode::Auto,
            cli_version: None,
            index: None,
            writer_cli,
            orchestration: None,
            memory: None,
            tools: &ClaudeAdapter,
        };
        for cli in [false, true] {
            let b = build(&input(cli)).unwrap();
            assert_eq!(
                b.append_system_prompt.unwrap(),
                expected_block(&root, None, cli)
            );
        }
        // A project with a native-loaded AGENTS.md: the block, then the header, no instruction text.
        let (_d2, root2, p) = project_with(&[], &[]);
        let b = build(&BundleInput {
            root: &root2,
            project: Some(&p),
            mode: InjectMode::Auto,
            cli_version: Some("2.1.325"),
            index: None,
            writer_cli: false,
            orchestration: None,
            memory: None,
            tools: &ClaudeAdapter,
        })
        .unwrap();
        let s = b.append_system_prompt.unwrap();
        assert!(s.starts_with(&expected_block(&root2, Some(&p), false)));
        assert!(s.contains("## Project: P") && !s.contains("Be brief."));
    }

    /// Golden order of the whole prompt: Writer block, shadowed instructions (vault then project),
    /// project section; the shadowed audit text is untouched by the block.
    #[test]
    fn golden_prompt_order_with_shadowed_instructions() {
        let (_d, root, p) = project_with(&[], &[]);
        std::fs::write(root.join("AGENTS.md"), "vault rules\n").unwrap();
        std::fs::write(root.join("CLAUDE.md"), "c").unwrap();
        let b = build(&BundleInput {
            root: &root,
            project: Some(&p),
            mode: InjectMode::Auto,
            cli_version: Some("2.1.325"),
            index: None,
            writer_cli: true,
            orchestration: None,
            memory: None,
            tools: &ClaudeAdapter,
        })
        .unwrap();
        let expected = format!(
            "{}\nThe following instruction files are not loaded automatically; follow them. Later instructions take precedence over earlier ones.\n\n### AGENTS.md\n\nvault rules\n\n## Project: P\nDesc\nProject folder: Projects/P\n",
            expected_block(&root, Some(&p), true)
        );
        assert_eq!(b.append_system_prompt.unwrap(), expected);
    }
}
