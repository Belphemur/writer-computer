//! The DQL parser: query text to [`Query`]. Hand-written recursive descent that follows
//! Dataview's grammar (`src/query/parse.ts`, `src/expression/parse.ts`, MIT, reimplemented):
//! the same clause forms, `and`/`or`/`&`/`|` at one precedence level, left-associative, and
//! identifiers that may contain `-`. Where Dataview's grammar is loose in a way that only hurts
//! (`trueish` read as `true`, `x order` read as `x or der`), keywords need a word boundary here.
//! Never panics; an error carries the byte offset it points at.

use super::ast::*;
use crate::index::inline_fields::{date_prefix, duration_prefix};

#[derive(Clone, Debug, PartialEq)]
pub struct ParseError {
    pub pos: usize,
    pub message: String,
}

type Res<T> = Result<T, ParseError>;

/// Words that cannot be a variable (Dataview's `KEYWORDS`, plus `SORT` so that
/// `LIST SORT x` does not read `SORT` as the format).
const KEYWORDS: [&str; 6] = ["FROM", "WHERE", "LIMIT", "GROUP", "FLATTEN", "SORT"];

const SHORTHANDS: [(&str, Shorthand); 16] = [
    ("start-of-month", Shorthand::StartOf(Unit::Month)),
    ("start-of-week", Shorthand::StartOf(Unit::Week)),
    ("start-of-year", Shorthand::StartOf(Unit::Year)),
    ("end-of-month", Shorthand::EndOf(Unit::Month)),
    ("end-of-week", Shorthand::EndOf(Unit::Week)),
    ("end-of-year", Shorthand::EndOf(Unit::Year)),
    ("yesterday", Shorthand::Yesterday),
    ("tomorrow", Shorthand::Tomorrow),
    ("today", Shorthand::Today),
    ("now", Shorthand::Now),
    ("sow", Shorthand::StartOf(Unit::Week)),
    ("eow", Shorthand::EndOf(Unit::Week)),
    ("som", Shorthand::StartOf(Unit::Month)),
    ("eom", Shorthand::EndOf(Unit::Month)),
    ("soy", Shorthand::StartOf(Unit::Year)),
    ("eoy", Shorthand::EndOf(Unit::Year)),
];

const MAX_DEPTH: usize = 64;

fn is_emoji(c: char) -> bool {
    let n = c as u32;
    n >= 0x1F000 || (0x2600..=0x27BF).contains(&n) || (0x2B00..=0x2BFF).contains(&n)
}

fn ident_start(c: char) -> bool {
    c.is_alphabetic() || is_emoji(c)
}

fn ident_part(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-' || is_emoji(c)
}

struct P<'a> {
    s: &'a str,
    pos: usize,
    depth: usize,
}

/// Parse a whole query.
pub fn parse_query(text: &str) -> Res<Query> {
    let mut p = P {
        s: text,
        pos: 0,
        depth: 0,
    };
    p.query()
}

/// Parse one expression (the whole text).
pub fn parse_expression(text: &str) -> Res<Expr> {
    let mut p = P {
        s: text,
        pos: 0,
        depth: 0,
    };
    p.ws();
    let e = p.expr()?;
    p.ws();
    if p.pos < text.len() {
        return Err(p.err("unexpected text after the expression"));
    }
    Ok(e)
}

impl<'a> P<'a> {
    fn err(&self, message: impl Into<String>) -> ParseError {
        ParseError {
            pos: self.pos,
            message: message.into(),
        }
    }

    fn rest(&self) -> &'a str {
        &self.s[self.pos..]
    }

    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }

    fn eat(&mut self, lit: &str) -> bool {
        if self.rest().starts_with(lit) {
            self.pos += lit.len();
            true
        } else {
            false
        }
    }

    fn ws(&mut self) {
        while let Some(c) = self.peek() {
            if !c.is_whitespace() {
                break;
            }
            self.pos += c.len_utf8();
        }
    }

    /// White space and `// comments` between clauses.
    fn ws_comments(&mut self) {
        loop {
            self.ws();
            if self.rest().starts_with("//") {
                self.pos += self.rest().find('\n').unwrap_or(self.rest().len());
            } else {
                break;
            }
        }
    }

    fn at_eof(&self) -> bool {
        self.pos >= self.s.len()
    }

    /// The word at the cursor, if it is `kw` (case-insensitive) followed by a non-identifier
    /// character; consumes it.
    fn keyword(&mut self, kw: &str) -> bool {
        let r = self.rest();
        if r.len() >= kw.len()
            && r.is_char_boundary(kw.len())
            && r[..kw.len()].eq_ignore_ascii_case(kw)
            && !r[kw.len()..].starts_with(ident_part)
        {
            self.pos += kw.len();
            true
        } else {
            false
        }
    }

    fn at_keyword(&self, kw: &str) -> bool {
        let mut c = P {
            s: self.s,
            pos: self.pos,
            depth: 0,
        };
        c.keyword(kw)
    }

    /// Is the cursor at a keyword that ends a field list (`FROM`, `WHERE`, `GROUP BY`, ...)?
    fn at_clause_start(&self) -> bool {
        ["FROM", "WHERE", "SORT", "LIMIT", "GROUP", "FLATTEN"]
            .iter()
            .any(|k| self.at_keyword(k))
            || self.rest().starts_with("//")
    }

    fn identifier(&mut self) -> Option<String> {
        let r = self.rest();
        let first = r.chars().next().filter(|c| ident_start(*c))?;
        let len = first.len_utf8()
            + r[first.len_utf8()..]
                .chars()
                .take_while(|c| ident_part(*c))
                .map(char::len_utf8)
                .sum::<usize>();
        self.pos += len;
        Some(r[..len].to_string())
    }

    // ----- query -----------------------------------------------------------

    fn query(&mut self) -> Res<Query> {
        self.ws_comments();
        let header = self.header()?;
        self.ws_comments();
        let from = if self.keyword("FROM") {
            self.ws();
            Some(self.source()?)
        } else {
            None
        };
        let mut clauses = Vec::new();
        loop {
            self.ws_comments();
            if self.at_eof() {
                break;
            }
            let pos = self.pos;
            if self.at_keyword("FROM") {
                return Err(self.err("FROM must come right after TABLE, LIST, TASK or CALENDAR"));
            }
            let clause = if self.keyword("WHERE") {
                self.ws();
                Clause::Where {
                    expr: self.expr()?,
                    pos,
                }
            } else if self.keyword("SORT") {
                self.ws();
                Clause::Sort {
                    keys: self.sort_keys()?,
                    pos,
                }
            } else if self.keyword("LIMIT") {
                self.ws();
                Clause::Limit {
                    expr: self.expr()?,
                    pos,
                }
            } else if self.keyword("FLATTEN") {
                self.ws();
                Clause::Flatten {
                    field: self.named_field()?,
                    pos,
                }
            } else if self.at_keyword("GROUP") {
                self.keyword("GROUP");
                self.ws();
                if !self.keyword("BY") {
                    return Err(self.err("expected BY after GROUP"));
                }
                self.ws();
                Clause::Group {
                    field: self.named_field()?,
                    pos,
                }
            } else {
                return Err(self.err("expected FROM, WHERE, SORT, LIMIT, GROUP BY or FLATTEN"));
            };
            clauses.push(clause);
        }
        Ok(Query {
            header,
            from,
            clauses,
        })
    }

    fn header(&mut self) -> Res<Header> {
        if self.keyword("TABLE") {
            let (without_id, fields) = {
                let mut without_id = false;
                let mut fields = Vec::new();
                self.ws();
                if self.at_eof() || self.at_clause_start() {
                    (without_id, fields)
                } else {
                    if self.keyword("WITHOUT") {
                        self.ws();
                        if !self.keyword("ID") {
                            return Err(self.err("expected ID after WITHOUT"));
                        }
                        without_id = true;
                        self.ws();
                    }
                    while !self.at_eof() && !self.at_clause_start() {
                        fields.push(self.named_field()?);
                        let save = self.pos;
                        self.ws();
                        if !self.eat(",") {
                            self.pos = save;
                            break;
                        }
                        self.ws();
                    }
                    (without_id, fields)
                }
            };
            Ok(Header::Table { without_id, fields })
        } else if self.keyword("LIST") {
            self.ws();
            let mut without_id = false;
            if self.keyword("WITHOUT") {
                self.ws();
                if !self.keyword("ID") {
                    return Err(self.err("expected ID after WITHOUT"));
                }
                without_id = true;
                self.ws();
            }
            let format = if self.at_eof() || self.at_clause_start() {
                None
            } else {
                Some(self.expr()?)
            };
            Ok(Header::List { without_id, format })
        } else if self.keyword("TASK") {
            Ok(Header::Task)
        } else if self.keyword("CALENDAR") {
            self.ws();
            Ok(Header::Calendar(self.named_field()?))
        } else {
            Err(self.err("expected TABLE, LIST, TASK or CALENDAR"))
        }
    }

    fn named_field(&mut self) -> Res<NamedField> {
        let start = self.pos;
        let expr = self.expr()?;
        let end = self.pos;
        let save = self.pos;
        self.ws();
        if self.keyword("AS") && self.rest().starts_with(char::is_whitespace) {
            self.ws();
            let name = match self.peek() {
                Some('"') => self.string()?,
                _ => self
                    .identifier()
                    .ok_or_else(|| self.err("expected a name after AS"))?,
            };
            return Ok(NamedField {
                name,
                expr,
                explicit: true,
                pos: start,
            });
        }
        self.pos = save;
        let raw: String = self.s[start..end]
            .split(['\r', '\n'])
            .map(str::trim)
            .collect();
        Ok(NamedField {
            name: raw,
            expr,
            explicit: false,
            pos: start,
        })
    }

    fn sort_keys(&mut self) -> Res<Vec<(Expr, bool)>> {
        let mut keys = Vec::new();
        loop {
            let e = self.expr()?;
            self.ws();
            let desc = if self.keyword("DESCENDING") || self.keyword("DESC") {
                true
            } else {
                let _ = self.keyword("ASCENDING") || self.keyword("ASC");
                false
            };
            keys.push((e, desc));
            let save = self.pos;
            self.ws();
            if self.eat(",") {
                self.ws();
            } else {
                self.pos = save;
                return Ok(keys);
            }
        }
    }

    // ----- sources -----------------------------------------------------------

    fn source(&mut self) -> Res<Source> {
        let mut left = self.atom_source()?;
        loop {
            let save = self.pos;
            self.ws();
            let op = if self.keyword("and") || self.eat("&") {
                Some(true)
            } else if self.keyword("or") || self.eat("|") {
                Some(false)
            } else {
                None
            };
            let Some(is_and) = op else {
                self.pos = save;
                return Ok(left);
            };
            self.ws();
            match self.atom_source() {
                Ok(right) => {
                    left = if is_and {
                        Source::And(Box::new(left), Box::new(right))
                    } else {
                        Source::Or(Box::new(left), Box::new(right))
                    };
                }
                Err(e) => {
                    self.pos = save;
                    return if self.at_eof() { Ok(left) } else { Err(e) };
                }
            }
        }
    }

    fn atom_source(&mut self) -> Res<Source> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.err("the query is nested too deeply"));
        }
        let r = self.atom_source_inner();
        self.depth -= 1;
        r
    }

    fn atom_source_inner(&mut self) -> Res<Source> {
        if self.eat("(") {
            self.ws();
            let s = self.source()?;
            self.ws();
            if !self.eat(")") {
                return Err(self.err("expected `)`"));
            }
            return Ok(s);
        }
        if self.eat("-") || self.eat("!") {
            return Ok(Source::Not(Box::new(self.atom_source()?)));
        }
        if self.rest().starts_with("outgoing(") {
            self.pos += "outgoing(".len();
            self.ws();
            let (path, _) = self.link()?;
            self.ws();
            if !self.eat(")") {
                return Err(self.err("expected `)`"));
            }
            return Ok(Source::Outgoing(path));
        }
        if self.rest().starts_with("[[") {
            let (path, _) = self.link()?;
            return Ok(Source::Incoming(path));
        }
        if self.peek() == Some('"') {
            return Ok(Source::Path(self.string()?));
        }
        if self.peek() == Some('#') {
            let start = self.pos;
            self.pos += 1;
            let body: usize = self
                .rest()
                .chars()
                .take_while(|c| is_tag_char(*c))
                .map(char::len_utf8)
                .sum();
            self.pos += body;
            return Ok(Source::Tag(self.s[start + 1..self.pos].to_string()));
        }
        if self.rest().starts_with("csv(") {
            return Err(self.err("csv() sources are not supported"));
        }
        Err(self.err("expected a source: #tag, \"folder\", [[link]], outgoing([[link]]) or (...)"))
    }

    // ----- expressions ---------------------------------------------------------

    fn expr(&mut self) -> Res<Expr> {
        self.level(0)
    }

    fn level(&mut self, level: usize) -> Res<Expr> {
        if level == 4 {
            return self.indexed();
        }
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.err("the expression is nested too deeply"));
        }
        let r = self.level_inner(level);
        self.depth -= 1;
        r
    }

    fn level_inner(&mut self, level: usize) -> Res<Expr> {
        let mut left = self.level(level + 1)?;
        loop {
            let save = self.pos;
            self.ws();
            let Some(op) = self.operator(level) else {
                self.pos = save;
                return Ok(left);
            };
            self.ws();
            // an operator with nothing usable after it is an error at the operand
            let right = self.level(level + 1)?;
            left = Expr::Bin(op, Box::new(left), Box::new(right));
        }
    }

    fn operator(&mut self, level: usize) -> Option<BinOp> {
        match level {
            0 => {
                if self.keyword("and") || self.eat("&") {
                    Some(BinOp::And)
                } else if self.keyword("or") || self.eat("|") {
                    Some(BinOp::Or)
                } else {
                    None
                }
            }
            1 => {
                for (lit, op) in [
                    (">=", BinOp::Ge),
                    ("<=", BinOp::Le),
                    ("!=", BinOp::Ne),
                    (">", BinOp::Gt),
                    ("<", BinOp::Lt),
                ] {
                    if self.eat(lit) {
                        return Some(op);
                    }
                }
                // `=>` is a lambda arrow, never a comparison
                (!self.rest().starts_with("=>") && self.eat("=")).then_some(BinOp::Eq)
            }
            2 => {
                if self.eat("+") {
                    Some(BinOp::Add)
                } else if self.eat("-") {
                    Some(BinOp::Sub)
                } else {
                    None
                }
            }
            _ => {
                if self.eat("*") {
                    Some(BinOp::Mul)
                } else if self.eat("%") {
                    Some(BinOp::Mod)
                } else if !self.rest().starts_with("//") && self.eat("/") {
                    Some(BinOp::Div)
                } else {
                    None
                }
            }
        }
    }

    fn indexed(&mut self) -> Res<Expr> {
        let start = self.pos;
        let mut e = self.atom()?;
        loop {
            if self.rest().starts_with('.') {
                let save = self.pos;
                self.pos += 1;
                match self.identifier() {
                    Some(name) => e = Expr::Field(Box::new(e), name),
                    None => {
                        self.pos = save;
                        return Ok(e);
                    }
                }
            } else if self.rest().starts_with('[') && !self.rest().starts_with("[[") {
                self.pos += 1;
                self.ws();
                let idx = self.expr()?;
                self.ws();
                if !self.eat("]") {
                    return Err(self.err("expected `]`"));
                }
                e = Expr::Index(Box::new(e), Box::new(idx));
            } else if self.rest().starts_with('(') {
                self.pos += 1;
                self.ws();
                let mut args = Vec::new();
                if !self.rest().starts_with(')') {
                    loop {
                        args.push(self.expr()?);
                        let save = self.pos;
                        self.ws();
                        if self.eat(",") {
                            self.ws();
                        } else {
                            self.pos = save;
                            break;
                        }
                    }
                }
                self.ws();
                if !self.eat(")") {
                    return Err(self.err("expected `)` to close the call"));
                }
                e = Expr::Call {
                    callee: Box::new(e),
                    args,
                    pos: start,
                };
            } else {
                return Ok(e);
            }
        }
    }

    fn atom(&mut self) -> Res<Expr> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.err("the expression is nested too deeply"));
        }
        let r = self.atom_inner();
        self.depth -= 1;
        r
    }

    fn atom_inner(&mut self) -> Res<Expr> {
        let start = self.pos;
        let r = self.rest();
        if r.starts_with("![[") || r.starts_with("[[") {
            self.eat("!");
            let (path, display) = self.link()?;
            return Ok(Expr::Link { path, display });
        }
        if self.eat("!") {
            return Ok(Expr::Not(Box::new(self.indexed()?)));
        }
        match self.peek() {
            Some('[') => return self.list(),
            Some('{') => return self.object(),
            Some('(') => {
                if let Some(l) = self.lambda()? {
                    return Ok(l);
                }
                self.pos += 1;
                self.ws();
                let e = self.expr()?;
                self.ws();
                if !self.eat(")") {
                    return Err(self.err("expected `)`"));
                }
                return Ok(e);
            }
            Some('"') => return Ok(Expr::Str(self.string()?)),
            Some(c) if c.is_ascii_digit() || c == '-' => {
                if let Some(n) = self.number() {
                    return Ok(Expr::Number(n));
                }
            }
            _ => {}
        }
        if let Some(e) = self.literal_word() {
            return Ok(e);
        }
        if let Some(e) = self.special_call() {
            return Ok(e);
        }
        if let Some(name) = self.identifier() {
            if KEYWORDS.contains(&name.to_ascii_uppercase().as_str()) {
                self.pos = start;
                return Err(self.err(format!("`{name}` is a keyword here, not a field")));
            }
            return Ok(Expr::Var { name, pos: start });
        }
        Err(self.err("expected a value: a field, number, string, date, list or `(`"))
    }

    fn literal_word(&mut self) -> Option<Expr> {
        for (word, e) in [
            ("true", Expr::Bool(true)),
            ("True", Expr::Bool(true)),
            ("false", Expr::Bool(false)),
            ("False", Expr::Bool(false)),
            ("null", Expr::Null),
        ] {
            let r = self.rest();
            if r.starts_with(word) && !r[word.len()..].starts_with(ident_part) {
                self.pos += word.len();
                return Some(e);
            }
        }
        None
    }

    /// `date(...)` and `dur(...)` literals; anything else with those names is a normal call.
    fn special_call(&mut self) -> Option<Expr> {
        let save = self.pos;
        let is_date = self.rest().starts_with("date(");
        if !is_date && !self.rest().starts_with("dur(") {
            return None;
        }
        self.pos += if is_date { 5 } else { 4 };
        self.ws();
        let e = if is_date {
            let short = SHORTHANDS
                .iter()
                .find(|(n, _)| self.rest().starts_with(n))
                .map(|(n, s)| (n.len(), *s));
            match short {
                Some((len, s)) => {
                    self.pos += len;
                    Some(Expr::Shorthand(s))
                }
                None => date_prefix(self.rest()).map(|(d, len)| {
                    self.pos += len;
                    Expr::Date(d)
                }),
            }
        } else {
            duration_prefix(self.rest()).map(|(d, len)| {
                self.pos += len;
                Expr::Duration(d)
            })
        };
        self.ws();
        match e {
            Some(e) if self.eat(")") => Some(e),
            _ => {
                self.pos = save;
                None
            }
        }
    }

    fn number(&mut self) -> Option<f64> {
        let start = self.pos;
        self.eat("-");
        let digits = self.rest().bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            self.pos = start;
            return None;
        }
        self.pos += digits;
        if self.rest().starts_with('.')
            && self.rest()[1..].starts_with(|c: char| c.is_ascii_digit())
        {
            self.pos += 1;
            self.pos += self.rest().bytes().take_while(u8::is_ascii_digit).count();
        }
        self.s[start..self.pos].parse().ok()
    }

    fn string(&mut self) -> Res<String> {
        let start = self.pos;
        self.pos += 1; // the opening quote
        let mut out = String::new();
        let mut chars = self.rest().char_indices();
        while let Some((i, c)) = chars.next() {
            match c {
                '"' => {
                    self.pos += i + 1;
                    return Ok(out);
                }
                '\\' => match chars.next() {
                    Some((_, '"')) => out.push('"'),
                    Some((_, '\\')) => out.push('\\'),
                    Some((_, other)) => {
                        out.push('\\');
                        out.push(other);
                    }
                    None => break,
                },
                other => out.push(other),
            }
        }
        self.pos = start;
        Err(self.err("this string is not closed"))
    }

    /// `[[path#sub|display]]`: the path without sub-path, and the display text.
    fn link(&mut self) -> Res<(String, Option<String>)> {
        let r = self.rest();
        let Some(inner) = r.strip_prefix("[[") else {
            return Err(self.err("expected a [[link]]"));
        };
        let Some(close) = inner.find("]]") else {
            return Err(self.err("this link is not closed"));
        };
        let body = &inner[..close];
        if body.contains(['[', ']']) {
            return Err(self.err("expected a [[link]]"));
        }
        self.pos += 2 + close + 2;
        let mut pipe = None;
        let b = body.as_bytes();
        for (i, ch) in body.char_indices() {
            if ch == '|' && (i == 0 || b[i - 1] != b'\\') {
                pipe = Some(i);
                break;
            }
        }
        let (target, display) = match pipe {
            Some(i) => (&body[..i], Some(body[i + 1..].to_string())),
            None => (body, None),
        };
        let target = target.replace("\\|", "|");
        let path = target
            .split(['#', '^'])
            .next()
            .unwrap_or_default()
            .to_string();
        Ok((path, display))
    }

    fn list(&mut self) -> Res<Expr> {
        self.pos += 1;
        self.ws();
        let mut items = Vec::new();
        if !self.rest().starts_with(']') {
            loop {
                items.push(self.expr()?);
                let save = self.pos;
                self.ws();
                if self.eat(",") {
                    self.ws();
                } else {
                    self.pos = save;
                    break;
                }
            }
        }
        self.ws();
        if !self.eat("]") {
            return Err(self.err("expected `]` to close the list"));
        }
        Ok(Expr::List(items))
    }

    fn object(&mut self) -> Res<Expr> {
        self.pos += 1;
        self.ws();
        let mut fields = Vec::new();
        if !self.rest().starts_with('}') {
            loop {
                let key = if self.peek() == Some('"') {
                    self.string()?
                } else {
                    self.identifier()
                        .ok_or_else(|| self.err("expected a field name"))?
                };
                self.ws();
                if !self.eat(":") {
                    return Err(self.err("expected `:` after the field name"));
                }
                self.ws();
                fields.push((key, self.expr()?));
                let save = self.pos;
                self.ws();
                if self.eat(",") {
                    self.ws();
                } else {
                    self.pos = save;
                    break;
                }
            }
        }
        self.ws();
        if !self.eat("}") {
            return Err(self.err("expected `}` to close the object"));
        }
        Ok(Expr::Object(fields))
    }

    /// `(a, b) => body`, or `None` (cursor restored) when the parenthesis is not a lambda's.
    fn lambda(&mut self) -> Res<Option<Expr>> {
        let save = self.pos;
        self.pos += 1;
        self.ws();
        let mut params = Vec::new();
        if !self.rest().starts_with(')') {
            loop {
                match self.identifier() {
                    Some(p) => params.push(p),
                    None => {
                        self.pos = save;
                        return Ok(None);
                    }
                }
                self.ws();
                if self.eat(",") {
                    self.ws();
                } else {
                    break;
                }
            }
        }
        if !self.eat(")") {
            self.pos = save;
            return Ok(None);
        }
        self.ws();
        if !self.eat("=>") {
            self.pos = save;
            return Ok(None);
        }
        self.ws();
        let body = self.expr()?;
        Ok(Some(Expr::Lambda {
            params,
            body: Box::new(body),
        }))
    }
}

fn is_tag_char(c: char) -> bool {
    !(c.is_whitespace()
        || matches!(
            c,
            '\'' | '!'
                | '"'
                | '#'
                | '$'
                | '%'
                | '&'
                | '('
                | ')'
                | '*'
                | '+'
                | ','
                | '.'
                | ':'
                | ';'
                | '<'
                | '='
                | '>'
                | '?'
                | '@'
                | '^'
                | '`'
                | '{'
                | '|'
                | '}'
                | '~'
                | '['
                | ']'
                | '\\'
        )
        || ('\u{2000}'..='\u{206F}').contains(&c)
        || ('\u{2E00}'..='\u{2E7F}').contains(&c))
}

/// 1-based line and column of byte offset `pos` in `text`.
pub fn line_col(text: &str, pos: usize) -> (usize, usize) {
    let pos = pos.min(text.len());
    let before = &text[..text.floor_char_boundary(pos)];
    let line = before.matches('\n').count() + 1;
    let col = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
    (line, col)
}
