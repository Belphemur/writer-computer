//! The commit message builder (spec `SPECs/git-sync-spec.md` "Commit messages"): the format of
//! conventional commits, not their spec. The type says who made the commit, the scope says what
//! happened, so `git log` alone shows a user's commit from an agent's.
//!
//! ```text
//! user(edit): Meeting notes, Plan (+2)
//! agent(edit): Rewrite the interview guide
//! chore(setup): start version history
//!
//! Writer-Device: Studio Mac
//! ```
//!
//! Pure: no IO, no repository. The template `git.commit-message` shapes only the subject; the
//! `type(scope): ` prefix and the trailers are always Writer's.

/// Who made the commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Type {
    User,
    Agent,
    Chore,
}

impl Type {
    pub fn as_str(self) -> &'static str {
        match self {
            Type::User => "user",
            Type::Agent => "agent",
            Type::Chore => "chore",
        }
    }

    pub fn parse(s: &str) -> Option<Type> {
        match s {
            "user" => Some(Type::User),
            "agent" => Some(Type::Agent),
            "chore" => Some(Type::Chore),
            _ => None,
        }
    }
}

/// What happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Edit,
    Add,
    Delete,
    Move,
    Restore,
    Merge,
    Setup,
    Ignore,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Edit => "edit",
            Scope::Add => "add",
            Scope::Delete => "delete",
            Scope::Move => "move",
            Scope::Restore => "restore",
            Scope::Merge => "merge",
            Scope::Setup => "setup",
            Scope::Ignore => "ignore",
        }
    }

    pub fn parse(s: &str) -> Option<Scope> {
        [
            Scope::Edit,
            Scope::Add,
            Scope::Delete,
            Scope::Move,
            Scope::Restore,
            Scope::Merge,
            Scope::Setup,
            Scope::Ignore,
        ]
        .into_iter()
        .find(|c| c.as_str() == s)
    }
}

/// One file's change, paths vault-relative with forward slashes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Add(String),
    Edit(String),
    Delete(String),
    /// A rename is a move.
    Move {
        from: String,
        to: String,
    },
}

impl Change {
    /// The path the file has after the change (the one that goes into the tree), `None` for a delete.
    pub fn path(&self) -> &str {
        match self {
            Change::Add(p) | Change::Edit(p) | Change::Delete(p) => p,
            Change::Move { to, .. } => to,
        }
    }

    fn scope(&self) -> Scope {
        match self {
            Change::Add(_) => Scope::Add,
            Change::Edit(_) => Scope::Edit,
            Change::Delete(_) => Scope::Delete,
            Change::Move { .. } => Scope::Move,
        }
    }
}

/// The scope of a set of changes: the kind they all share, `edit` when they mix.
pub fn scope_of(changes: &[Change]) -> Scope {
    let mut kinds = changes.iter().map(Change::scope);
    match kinds.next() {
        Some(first) if kinds.all(|k| k == first) => first,
        _ => Scope::Edit,
    }
}

/// A note by title (no `.md`), any other file by its name with the extension.
fn title(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name).to_string()
}

/// A path as the move subject names it: with its folders, without `.md`.
fn shown_path(path: &str) -> &str {
    path.strip_suffix(".md").unwrap_or(path)
}

fn one(change: &Change) -> String {
    match change {
        Change::Move { from, to } => format!("{} → {}", shown_path(from), shown_path(to)),
        other => title(other.path()),
    }
}

/// The changed notes by title, at most two named, then `(+n)`; a move names `from → to`.
pub fn notes(changes: &[Change]) -> String {
    let named: Vec<String> = changes.iter().take(2).map(one).collect();
    let mut out = named.join(", ");
    if changes.len() > 2 {
        out.push_str(&format!(" (+{})", changes.len() - 2));
    }
    out
}

/// Placeholder values for `git.commit-message`.
#[derive(Debug, Clone, Default)]
pub struct TemplateCtx {
    /// `2026-11-20 14:03`, formatted by the caller (this module has no clock).
    pub date: String,
    pub hostname: String,
}

/// The default template: the note names alone.
pub const DEFAULT_TEMPLATE: &str = "{{notes}}";

/// Fills `{{notes}}`, `{{date}}`, `{{hostname}}`, `{{numFiles}}` and `{{files}}`.
pub fn subject_from_template(template: &str, changes: &[Change], ctx: &TemplateCtx) -> String {
    let template = if template.trim().is_empty() {
        DEFAULT_TEMPLATE
    } else {
        template
    };
    let files: Vec<&str> = changes.iter().map(Change::path).collect();
    template
        .replace("{{notes}}", &notes(changes))
        .replace("{{date}}", &ctx.date)
        .replace("{{hostname}}", &ctx.hostname)
        .replace("{{numFiles}}", &changes.len().to_string())
        .replace("{{files}}", &files.join(", "))
}

/// The trailers of a commit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Trailers {
    pub device: String,
    /// Agent commits: the chat id.
    pub chat: Option<String>,
    /// Agent commits: the backend (`claude`, `opencode`), never the scope.
    pub agent: Option<String>,
    /// Agent commits: the main agent's model, then one per distinct sub-agent model. Empty when
    /// the backend reported none (never guessed).
    pub models: Vec<String>,
    /// Agent commits: the turn's id (`Writer-Turn`), so a Changes card finds its own commit.
    pub turn: Option<String>,
    /// Files this commit moved, `(from, to)`: how the history of a file follows a rename that git
    /// cannot see by content (the moved file was edited too).
    pub moves: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub ty: Type,
    pub scope: Scope,
    pub subject: String,
    pub trailers: Trailers,
}

fn moves_of(changes: &[Change]) -> Vec<(String, String)> {
    changes
        .iter()
        .filter_map(|c| match c {
            Change::Move { from, to } => Some((from.clone(), to.clone())),
            _ => None,
        })
        .collect()
}

/// A path in a trailer value: `%`, spaces and control characters are percent-encoded, so no run of
/// spaces, newline or ` -> ` in a file name can be altered or split.
fn encode_path(p: &str) -> String {
    p.chars()
        .map(|c| {
            if c == '%' || c == ' ' || c.is_control() {
                format!("%{:02X}", c as u32)
            } else {
                c.to_string()
            }
        })
        .collect()
}

fn decode_path(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(v) = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One line: trailers and subjects never carry a newline.
fn single_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl Message {
    /// The user's commit of `changes`, the subject from the template.
    pub fn user(changes: &[Change], template: &str, ctx: &TemplateCtx, device: &str) -> Message {
        Message {
            ty: Type::User,
            scope: scope_of(changes),
            subject: subject_from_template(template, changes, ctx),
            trailers: Trailers {
                device: device.to_string(),
                moves: moves_of(changes),
                ..Trailers::default()
            },
        }
    }

    /// The user's own special commits: a restore, a merge-view resolution.
    pub fn user_scoped(scope: Scope, subject: &str, device: &str) -> Message {
        Message {
            ty: Type::User,
            scope,
            subject: subject.to_string(),
            trailers: Trailers {
                device: device.to_string(),
                ..Trailers::default()
            },
        }
    }

    /// One agent turn: the subject is the chat title.
    pub fn agent(
        changes: &[Change],
        title: &str,
        turn: AgentTurnInfo<'_>,
        device: &str,
    ) -> Message {
        let mut models: Vec<String> = Vec::new();
        for m in turn.models {
            if !m.trim().is_empty() && !models.contains(m) {
                models.push(m.clone());
            }
        }
        Message {
            ty: Type::Agent,
            scope: scope_of(changes),
            subject: title.to_string(),
            trailers: Trailers {
                device: device.to_string(),
                chat: Some(turn.chat_id.to_string()),
                agent: Some(turn.backend.to_string()),
                models,
                turn: turn.turn_id.map(str::to_string),
                moves: moves_of(changes),
            },
        }
    }

    /// Writer's own housekeeping (`setup`, `ignore`).
    pub fn chore(scope: Scope, subject: &str, device: &str) -> Message {
        Message {
            ty: Type::Chore,
            scope,
            subject: subject.to_string(),
            trailers: Trailers {
                device: device.to_string(),
                ..Trailers::default()
            },
        }
    }

    /// The commit message text.
    pub fn render(&self) -> String {
        let subject = single_line(&self.subject);
        let mut out = format!(
            "{}({}): {}\n\n",
            self.ty.as_str(),
            self.scope.as_str(),
            subject
        );
        out.push_str(&format!(
            "Writer-Device: {}\n",
            single_line(&self.trailers.device)
        ));
        if let Some(chat) = &self.trailers.chat {
            out.push_str(&format!("Writer-Chat: {}\n", single_line(chat)));
        }
        if let Some(agent) = &self.trailers.agent {
            out.push_str(&format!("Writer-Agent: {}\n", single_line(agent)));
        }
        for model in &self.trailers.models {
            out.push_str(&format!("Writer-Model: {}\n", single_line(model)));
        }
        if let Some(turn) = &self.trailers.turn {
            out.push_str(&format!("Writer-Turn: {}\n", single_line(turn)));
        }
        for (from, to) in &self.trailers.moves {
            out.push_str(&format!(
                "Writer-Move-From: {}\nWriter-Move-To: {}\n",
                encode_path(from),
                encode_path(to)
            ));
        }
        out
    }
}

/// What an agent commit needs to know about its turn.
#[derive(Debug, Clone, Copy)]
pub struct AgentTurnInfo<'a> {
    pub chat_id: &'a str,
    /// The agent's id of the turn (`TurnChangesSummary.turnId`), when it has one.
    pub turn_id: Option<&'a str>,
    pub backend: &'a str,
    pub models: &'a [String],
}

/// A commit message read back (`git:log`): the parts of [`Message`] that were parsed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Parsed {
    pub ty: Option<Type>,
    pub scope: Option<Scope>,
    pub subject: String,
    pub device: Option<String>,
    pub chat: Option<String>,
    pub agent: Option<String>,
    pub models: Vec<String>,
    pub turn: Option<String>,
    pub moves: Vec<(String, String)>,
}

/// Reads a message written by [`Message::render`] (or anything else: a foreign commit has no type,
/// scope or trailers and keeps its first line as the subject).
pub fn parse(text: &str) -> Parsed {
    let mut lines = text.lines();
    let first = lines.next().unwrap_or("").trim();
    let mut parsed = Parsed {
        subject: first.to_string(),
        ..Parsed::default()
    };
    let mut move_from: Option<String> = None;
    if let Some((head, rest)) = first.split_once("): ") {
        if let Some((ty, scope)) = head.split_once('(') {
            if let (Some(ty), Some(scope)) = (Type::parse(ty), Scope::parse(scope)) {
                parsed.ty = Some(ty);
                parsed.scope = Some(scope);
                parsed.subject = rest.to_string();
            }
        }
    }
    for line in lines {
        let Some((key, value)) = line.split_once(": ") else {
            continue;
        };
        let value = value.trim().to_string();
        match key {
            "Writer-Device" => parsed.device = Some(value),
            "Writer-Chat" => parsed.chat = Some(value),
            "Writer-Agent" => parsed.agent = Some(value),
            "Writer-Model" => parsed.models.push(value),
            "Writer-Turn" => parsed.turn = Some(value),
            "Writer-Move-From" => move_from = Some(decode_path(&value)),
            "Writer-Move-To" => {
                if let Some(from) = move_from.take() {
                    parsed.moves.push((from, decode_path(&value)));
                }
            }
            _ => {}
        }
    }
    parsed
}
