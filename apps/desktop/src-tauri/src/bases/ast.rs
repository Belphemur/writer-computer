//! Expression syntax tree, plus a canonical printer (`to_source`) used by the
//! round-trip property test and by error messages.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnaryOp {
    Not,
    Neg,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryOp {
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

impl BinaryOp {
    pub fn symbol(self) -> &'static str {
        match self {
            BinaryOp::Add => "+",
            BinaryOp::Sub => "-",
            BinaryOp::Mul => "*",
            BinaryOp::Div => "/",
            BinaryOp::Mod => "%",
            BinaryOp::Eq => "==",
            BinaryOp::Ne => "!=",
            BinaryOp::Lt => "<",
            BinaryOp::Gt => ">",
            BinaryOp::Le => "<=",
            BinaryOp::Ge => ">=",
            BinaryOp::And => "&&",
            BinaryOp::Or => "||",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
    Regex {
        source: String,
        flags: String,
    },
    List(Vec<Expr>),
    /// A bare name: a lambda variable, a namespace (`file`, `note`, `formula`,
    /// `this`) or a note property.
    Ident(String),
    Member(Box<Expr>, String),
    Index(Box<Expr>, Box<Expr>),
    /// `callee(args)`; `callee` is an `Ident` (global function) or a `Member`
    /// (method call).
    Call(Box<Expr>, Vec<Expr>),
    Unary(UnaryOp, Box<Expr>),
    Binary(BinaryOp, Box<Expr>, Box<Expr>),
}

fn escape_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl Expr {
    /// Fully parenthesised source that parses back to an equal tree.
    pub fn to_source(&self) -> String {
        match self {
            Expr::Null => "null".into(),
            Expr::Bool(b) => b.to_string(),
            Expr::Number(n) => format!("{n}"),
            Expr::Str(s) => escape_str(s),
            Expr::Regex { source, flags } => format!("/{source}/{flags}"),
            Expr::List(items) => format!(
                "[{}]",
                items
                    .iter()
                    .map(Expr::to_source)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Expr::Ident(n) => n.clone(),
            Expr::Member(o, n) => format!("{}.{n}", o.paren_if_needed()),
            Expr::Index(o, i) => format!("{}[{}]", o.paren_if_needed(), i.to_source()),
            Expr::Call(c, args) => format!(
                "{}({})",
                c.paren_if_needed(),
                args.iter()
                    .map(Expr::to_source)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Expr::Unary(UnaryOp::Not, e) => format!("!{}", e.paren_if_needed()),
            Expr::Unary(UnaryOp::Neg, e) => format!("-{}", e.paren_if_needed()),
            Expr::Binary(op, l, r) => {
                format!("({} {} {})", l.to_source(), op.symbol(), r.to_source())
            }
        }
    }

    fn paren_if_needed(&self) -> String {
        match self {
            Expr::Unary(..) | Expr::Number(_) => format!("({})", self.to_source()),
            _ => self.to_source(),
        }
    }

    /// Visit this node and all children, parents first.
    pub fn walk(&self, f: &mut dyn FnMut(&Expr)) {
        f(self);
        match self {
            Expr::List(items) => items.iter().for_each(|e| e.walk(f)),
            Expr::Member(o, _) => o.walk(f),
            Expr::Index(o, i) => {
                o.walk(f);
                i.walk(f);
            }
            Expr::Call(c, args) => {
                c.walk(f);
                args.iter().for_each(|e| e.walk(f));
            }
            Expr::Unary(_, e) => e.walk(f),
            Expr::Binary(_, l, r) => {
                l.walk(f);
                r.walk(f);
            }
            _ => {}
        }
    }
}

/// A property reference as used in `order`, `sort`, `groupBy`, `summaries` and
/// `properties` keys: `note.x` (or bare `x`), `file.x`, `formula.x`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum PropertyId {
    Note(String),
    File(String),
    Formula(String),
}

impl PropertyId {
    /// A bare name (which may contain spaces, hyphens or dots) is a note
    /// property; only the exact prefixes `note.`, `file.` and `formula.`
    /// select a namespace.
    pub fn parse(s: &str) -> PropertyId {
        if let Some(r) = s.strip_prefix("note.") {
            PropertyId::Note(r.to_string())
        } else if let Some(r) = s.strip_prefix("file.") {
            PropertyId::File(r.to_string())
        } else if let Some(r) = s.strip_prefix("formula.") {
            PropertyId::Formula(r.to_string())
        } else {
            PropertyId::Note(s.to_string())
        }
    }

    /// Canonical key: `note.` is dropped, the others keep their prefix. Two ids
    /// that name the same property have the same key.
    pub fn key(&self) -> String {
        match self {
            PropertyId::Note(n) => n.clone(),
            PropertyId::File(n) => format!("file.{n}"),
            PropertyId::Formula(n) => format!("formula.{n}"),
        }
    }
}
