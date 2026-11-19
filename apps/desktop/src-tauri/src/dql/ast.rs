//! The DQL syntax tree: a query and the expressions inside it. Offsets are byte offsets into the
//! query text, kept where an error can point at them (a variable or a call).

#[derive(Clone, Debug, PartialEq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    And,
    Or,
}

/// A date shorthand (`date(today)`, `date(eom)`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shorthand {
    Now,
    Today,
    Yesterday,
    Tomorrow,
    StartOf(Unit),
    EndOf(Unit),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    Week,
    Month,
    Year,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
    /// A date literal, normalised (`date(2024-01-15)`).
    Date(String),
    Shorthand(Shorthand),
    /// A duration literal as Bases duration text (`dur(1 day)`).
    Duration(String),
    Link {
        path: String,
        display: Option<String>,
    },
    List(Vec<Expr>),
    Object(Vec<(String, Expr)>),
    Var {
        name: String,
        pos: usize,
    },
    /// `a.b`
    Field(Box<Expr>, String),
    /// `a[b]`
    Index(Box<Expr>, Box<Expr>),
    Call {
        callee: Box<Expr>,
        args: Vec<Expr>,
        pos: usize,
    },
    Lambda {
        params: Vec<String>,
        body: Box<Expr>,
    },
    Not(Box<Expr>),
    Bin(BinOp, Box<Expr>, Box<Expr>),
}

/// An expression with the name its column or group gets: the `AS` name, else the expression's
/// own text.
#[derive(Clone, Debug, PartialEq)]
pub struct NamedField {
    pub name: String,
    pub expr: Expr,
    pub explicit: bool,
    pub pos: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Tag(String),
    /// `"Folder"` or `"Folder/Note"`.
    Path(String),
    /// `[[Note]]`: the pages that link to it.
    Incoming(String),
    /// `outgoing([[Note]])`: the pages it links to.
    Outgoing(String),
    Not(Box<Source>),
    And(Box<Source>, Box<Source>),
    Or(Box<Source>, Box<Source>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Header {
    Table {
        without_id: bool,
        fields: Vec<NamedField>,
    },
    List {
        without_id: bool,
        format: Option<Expr>,
    },
    Task,
    Calendar(NamedField),
}

impl Header {
    pub fn keyword(&self) -> &'static str {
        match self {
            Header::Table { .. } => "TABLE",
            Header::List { .. } => "LIST",
            Header::Task => "TASK",
            Header::Calendar(_) => "CALENDAR",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Clause {
    Where { expr: Expr, pos: usize },
    Sort { keys: Vec<(Expr, bool)>, pos: usize },
    Limit { expr: Expr, pos: usize },
    Flatten { field: NamedField, pos: usize },
    Group { field: NamedField, pos: usize },
}

impl Clause {
    pub fn keyword(&self) -> &'static str {
        match self {
            Clause::Where { .. } => "WHERE",
            Clause::Sort { .. } => "SORT",
            Clause::Limit { .. } => "LIMIT",
            Clause::Flatten { .. } => "FLATTEN",
            Clause::Group { .. } => "GROUP BY",
        }
    }
    pub fn pos(&self) -> usize {
        match self {
            Clause::Where { pos, .. }
            | Clause::Sort { pos, .. }
            | Clause::Limit { pos, .. }
            | Clause::Flatten { pos, .. }
            | Clause::Group { pos, .. } => *pos,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Query {
    pub header: Header,
    pub from: Option<Source>,
    pub clauses: Vec<Clause>,
}
