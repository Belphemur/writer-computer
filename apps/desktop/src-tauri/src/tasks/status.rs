//! Task statuses: the symbol between the brackets, its type and the symbol a toggle moves to.
//!
//! Semantics follow the Tasks plugin's registry (MIT, `src/Statuses/*`, see
//! `THIRD_PARTY_NOTICES.md`): an unknown symbol is a TODO whose next symbol is `x`, a toggle moves
//! to the configured next symbol, and a recurring task that was completed restarts at the first
//! TODO (else IN_PROGRESS) status of the chain, else a space. One deliberate difference: `X` is a
//! done alias of `x` (Writer always treated it so).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusType {
    Todo,
    Done,
    InProgress,
    OnHold,
    Cancelled,
    NonTask,
}

impl StatusType {
    pub const fn as_str(self) -> &'static str {
        match self {
            StatusType::Todo => "TODO",
            StatusType::Done => "DONE",
            StatusType::InProgress => "IN_PROGRESS",
            StatusType::OnHold => "ON_HOLD",
            StatusType::Cancelled => "CANCELLED",
            StatusType::NonTask => "NON_TASK",
        }
    }

    pub fn parse(s: &str) -> Option<StatusType> {
        Some(match s.trim().to_ascii_uppercase().as_str() {
            "TODO" => StatusType::Todo,
            "DONE" => StatusType::Done,
            "IN_PROGRESS" => StatusType::InProgress,
            "ON_HOLD" => StatusType::OnHold,
            "CANCELLED" => StatusType::Cancelled,
            "NON_TASK" => StatusType::NonTask,
            _ => return None,
        })
    }

    /// The Tasks plugin's "done": not something still to do.
    pub fn is_closed(self) -> bool {
        matches!(
            self,
            StatusType::Done | StatusType::Cancelled | StatusType::NonTask
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub symbol: char,
    pub name: String,
    pub next: char,
    pub kind: StatusType,
}

impl Status {
    pub fn new(symbol: char, name: &str, next: char, kind: StatusType) -> Status {
        Status {
            symbol,
            name: name.to_string(),
            next,
            kind,
        }
    }

    fn unknown(symbol: char) -> Status {
        Status::new(symbol, "Unknown", 'x', StatusType::Todo)
    }
}

/// The registered statuses, first registration of a symbol wins.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusTable {
    list: Vec<Status>,
}

impl Default for StatusTable {
    fn default() -> Self {
        StatusTable {
            list: vec![
                Status::new(' ', "Todo", 'x', StatusType::Todo),
                Status::new('x', "Done", ' ', StatusType::Done),
                Status::new('/', "In Progress", 'x', StatusType::InProgress),
                Status::new('-', "Cancelled", ' ', StatusType::Cancelled),
                Status::new('X', "Done", ' ', StatusType::Done),
            ],
        }
    }
}

impl StatusTable {
    /// `first` take precedence over what is already registered (the defaults).
    pub fn with_first(mut self, first: Vec<Status>) -> StatusTable {
        let mut list: Vec<Status> = Vec::new();
        for s in first {
            if !list.iter().any(|x| x.symbol == s.symbol) {
                list.push(s);
            }
        }
        for s in std::mem::take(&mut self.list) {
            if !list.iter().any(|x| x.symbol == s.symbol) {
                list.push(s);
            }
        }
        self.list = list;
        self
    }

    /// Statuses added after the ones already registered (a lower-priority layer).
    pub fn with_last(mut self, last: Vec<Status>) -> StatusTable {
        for s in last {
            if !self.list.iter().any(|x| x.symbol == s.symbol) {
                self.list.push(s);
            }
        }
        self
    }

    pub fn all(&self) -> &[Status] {
        &self.list
    }

    pub fn get(&self, symbol: char) -> Option<&Status> {
        self.list.iter().find(|s| s.symbol == symbol)
    }

    pub fn status_of(&self, symbol: char) -> Status {
        self.get(symbol)
            .cloned()
            .unwrap_or_else(|| Status::unknown(symbol))
    }

    pub fn kind_of(&self, symbol: char) -> StatusType {
        self.get(symbol).map_or(StatusType::Todo, |s| s.kind)
    }

    /// The symbol a user-typed status names: a registered symbol (`x`, ` `, `/`, a custom one) or
    /// a status name (`done`, `todo`, `in-progress`, `cancelled`, a custom status's name; case and
    /// `-`/`_`/space are not significant). A name that is a status type (`todo`) picks the first
    /// status of that type. `None` when nothing matches; see [`StatusTable::describe`].
    pub fn resolve(&self, input: &str) -> Option<char> {
        let mut chars = input.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            return self.get(c).map(|s| s.symbol);
        }
        let norm = |s: &str| s.trim().to_ascii_lowercase().replace(['-', '_'], " ");
        let want = norm(input);
        self.list
            .iter()
            .find(|s| norm(&s.name) == want)
            .or_else(|| {
                self.list
                    .iter()
                    .find(|s| norm(&s.kind.as_str().replace('_', " ")) == want)
            })
            .map(|s| s.symbol)
    }

    /// The statuses a user can name, for an error message: `"x" done, " " todo, ...`.
    pub fn describe(&self) -> String {
        self.list
            .iter()
            .map(|s| {
                format!(
                    "\"{}\" ({})",
                    s.symbol,
                    s.name.to_ascii_lowercase().replace(' ', "-")
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The symbol a toggle moves to.
    pub fn next_symbol(&self, symbol: char) -> char {
        self.status_of(symbol).next
    }

    /// The status of a recurring task's next occurrence after `completed` was toggled to.
    pub fn recurrence_symbol(&self, completed: char) -> char {
        let first = self.next_symbol(completed);
        for wanted in [StatusType::Todo, StatusType::InProgress] {
            let mut at = first;
            for _ in 0..self.list.len() {
                if self.kind_of(at) == wanted {
                    return at;
                }
                at = self.next_symbol(at);
            }
        }
        ' '
    }

    /// Statuses cycled by the editor checkbox: the table's order.
    pub fn same_cycle(&self) -> Vec<char> {
        self.list.iter().map(|s| s.symbol).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_takes_symbols_and_names() {
        let t = StatusTable::default().with_first(vec![Status::new(
            '!',
            "Important",
            'x',
            StatusType::Todo,
        )]);
        assert_eq!(t.resolve("x"), Some('x'));
        assert_eq!(t.resolve(" "), Some(' '));
        assert_eq!(t.resolve("!"), Some('!'));
        assert_eq!(t.resolve("?"), None);
        assert_eq!(t.resolve("Done"), Some('x'));
        assert_eq!(t.resolve("in-progress"), Some('/'));
        assert_eq!(t.resolve("cancelled"), Some('-'));
        assert_eq!(t.resolve("important"), Some('!'));
        // a status named "Todo" wins; a type name alone picks the first status of that type
        assert_eq!(t.resolve("todo"), Some(' '));
        assert_eq!(t.resolve("on-hold"), None);
        assert_eq!(t.resolve("nope"), None);
    }

    #[test]
    fn default_toggles() {
        let t = StatusTable::default();
        assert_eq!(t.next_symbol(' '), 'x');
        assert_eq!(t.next_symbol('x'), ' ');
        assert_eq!(t.next_symbol('X'), ' ');
        assert_eq!(t.next_symbol('/'), 'x');
        assert_eq!(t.next_symbol('-'), ' ');
        // unknown symbols are TODO and complete with `x`
        assert_eq!(t.kind_of('?'), StatusType::Todo);
        assert_eq!(t.next_symbol('?'), 'x');
    }

    #[test]
    fn custom_cycle_and_recurrence_restart() {
        let t = StatusTable::default().with_first(vec![
            Status::new('!', "Important", '/', StatusType::Todo),
            Status::new('/', "Doing", 'x', StatusType::InProgress),
            Status::new('x', "Done", '!', StatusType::Done),
        ]);
        assert_eq!(t.next_symbol('x'), '!');
        // a completed recurring task restarts at the first TODO of the chain
        assert_eq!(t.recurrence_symbol('x'), '!');
        // no TODO in the chain: IN_PROGRESS, else a space
        let t = StatusTable::default().with_first(vec![
            Status::new('x', "Done", '/', StatusType::Done),
            Status::new('/', "Doing", 'x', StatusType::InProgress),
        ]);
        assert_eq!(t.recurrence_symbol('x'), '/');
        let t = StatusTable::default().with_first(vec![
            Status::new('x', "Done", 'q', StatusType::Done),
            Status::new('q', "Q", 'x', StatusType::NonTask),
        ]);
        assert_eq!(t.recurrence_symbol('x'), ' ');
    }

    #[test]
    fn first_registration_wins() {
        let t = StatusTable::default()
            .with_first(vec![Status::new(' ', "Open", '/', StatusType::Todo)])
            .with_last(vec![Status::new(' ', "Late", 'x', StatusType::Todo)]);
        assert_eq!(t.next_symbol(' '), '/');
        assert_eq!(t.get(' ').unwrap().name, "Open");
    }
}
