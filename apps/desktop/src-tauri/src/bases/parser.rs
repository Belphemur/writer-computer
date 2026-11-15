//! Recursive-descent parser for the Bases expression language.
//!
//! Precedence, loosest to tightest: `||`, `&&`, `== !=`, `< > <= >=`, `+ -`,
//! `* / %`, unary `! -`, postfix `.name` / `[index]` / `(args)`. Nesting depth
//! is capped so hostile input cannot overflow the stack. The parser never
//! panics; it returns the first syntax error with its position.

use super::ast::{BinaryOp, Expr, UnaryOp};
use super::lexer::{tokenize, ParseError, Tok, Token};

const MAX_DEPTH: usize = 96;
const MAX_HEIGHT: usize = 200;

pub fn parse(src: &str) -> Result<Expr, ParseError> {
    let tokens = tokenize(src)?;
    if tokens.len() == 1 {
        return Err(ParseError::new(0, "empty expression"));
    }
    let mut p = Parser {
        tokens,
        i: 0,
        depth: 0,
    };
    let e = p.expr()?;
    match p.peek().tok {
        Tok::Eof => Ok(e),
        ref t => Err(ParseError::new(
            p.peek().pos,
            format!("unexpected {}", t.describe()),
        )),
    }
}

struct Parser {
    tokens: Vec<Token>,
    i: usize,
    depth: usize,
}

/// A parsed node and the height of its tree. The height is capped so the
/// recursive evaluator, printer and `Drop` can never overflow the stack, even
/// for long left-nested chains such as `1+1+1+...` or `a[0][0][0]...`.
type Node = (Expr, usize);

fn mk(e: Expr, h: usize) -> Result<Node, ParseError> {
    if h > MAX_HEIGHT {
        Err(ParseError::new(0, "expression too large"))
    } else {
        Ok((e, h))
    }
}

impl Parser {
    fn peek(&self) -> &Token {
        // tokenize always ends with Eof and we never advance past it
        &self.tokens[self.i.min(self.tokens.len() - 1)]
    }

    fn bump(&mut self) -> Token {
        let t = self.peek().clone();
        if self.i < self.tokens.len() - 1 {
            self.i += 1;
        }
        t
    }

    fn enter(&mut self) -> Result<(), ParseError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(ParseError::new(
                self.peek().pos,
                "expression nested too deeply",
            ));
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    fn expect(&mut self, want: Tok, what: &str) -> Result<(), ParseError> {
        if self.peek().tok == want {
            self.bump();
            Ok(())
        } else {
            Err(ParseError::new(
                self.peek().pos,
                format!("expected {what}, found {}", self.peek().tok.describe()),
            ))
        }
    }

    fn expr(&mut self) -> Result<Expr, ParseError> {
        self.expr_node().map(|n| n.0)
    }

    fn expr_node(&mut self) -> Result<Node, ParseError> {
        self.enter()?;
        let r = self.binary(0);
        self.leave();
        r
    }

    fn op_at(&self, level: usize) -> Option<BinaryOp> {
        let t = &self.peek().tok;
        match (level, t) {
            (0, Tok::OrOr) => Some(BinaryOp::Or),
            (1, Tok::AndAnd) => Some(BinaryOp::And),
            (2, Tok::EqEq) => Some(BinaryOp::Eq),
            (2, Tok::NotEq) => Some(BinaryOp::Ne),
            (3, Tok::Lt) => Some(BinaryOp::Lt),
            (3, Tok::Gt) => Some(BinaryOp::Gt),
            (3, Tok::Le) => Some(BinaryOp::Le),
            (3, Tok::Ge) => Some(BinaryOp::Ge),
            (4, Tok::Plus) => Some(BinaryOp::Add),
            (4, Tok::Minus) => Some(BinaryOp::Sub),
            (5, Tok::Star) => Some(BinaryOp::Mul),
            (5, Tok::Slash) => Some(BinaryOp::Div),
            (5, Tok::Percent) => Some(BinaryOp::Mod),
            _ => None,
        }
    }

    fn binary(&mut self, level: usize) -> Result<Node, ParseError> {
        if level > 5 {
            return self.unary();
        }
        let (mut left, mut lh) = self.binary(level + 1)?;
        while let Some(op) = self.op_at(level) {
            self.bump();
            let (right, rh) = self.binary(level + 1)?;
            let h = lh.max(rh) + 1;
            let n = mk(Expr::Binary(op, Box::new(left), Box::new(right)), h)
                .map_err(|e| ParseError::new(self.peek().pos, e.message))?;
            left = n.0;
            lh = n.1;
        }
        Ok((left, lh))
    }

    fn unary(&mut self) -> Result<Node, ParseError> {
        self.enter()?;
        let op = match self.peek().tok {
            Tok::Bang => Some(UnaryOp::Not),
            Tok::Minus => Some(UnaryOp::Neg),
            _ => None,
        };
        let r = match op {
            Some(op) => {
                self.bump();
                self.unary()
                    .and_then(|(e, h)| mk(Expr::Unary(op, Box::new(e)), h + 1))
            }
            None => self.postfix(),
        };
        self.leave();
        r
    }

    fn postfix(&mut self) -> Result<Node, ParseError> {
        let (mut e, mut h) = self.primary()?;
        loop {
            let pos = self.peek().pos;
            let next = match self.peek().tok {
                Tok::Dot => {
                    self.bump();
                    let t = self.bump();
                    match t.tok {
                        Tok::Ident(name) => Expr::Member(Box::new(e), name),
                        other => {
                            return Err(ParseError::new(
                                t.pos,
                                format!("expected a name after \".\", found {}", other.describe()),
                            ))
                        }
                    }
                }
                Tok::LBracket => {
                    self.bump();
                    let (idx, ih) = self.expr_node()?;
                    self.expect(Tok::RBracket, "\"]\"")?;
                    h = h.max(ih);
                    Expr::Index(Box::new(e), Box::new(idx))
                }
                Tok::LParen => {
                    self.bump();
                    let (args, ah) = self.args(Tok::RParen, "\")\"")?;
                    h = h.max(ah);
                    Expr::Call(Box::new(e), args)
                }
                _ => return Ok((e, h)),
            };
            h += 1;
            let n = mk(next, h).map_err(|er| ParseError::new(pos, er.message))?;
            e = n.0;
        }
    }

    fn args(&mut self, close: Tok, what: &str) -> Result<(Vec<Expr>, usize), ParseError> {
        let mut args = Vec::new();
        let mut h = 0;
        if self.peek().tok == close {
            self.bump();
            return Ok((args, h));
        }
        loop {
            let (e, eh) = self.expr_node()?;
            h = h.max(eh);
            args.push(e);
            match self.peek().tok {
                Tok::Comma => {
                    self.bump();
                    // tolerate a trailing comma
                    if self.peek().tok == close {
                        self.bump();
                        return Ok((args, h));
                    }
                }
                ref t if *t == close => {
                    self.bump();
                    return Ok((args, h));
                }
                ref t => {
                    return Err(ParseError::new(
                        self.peek().pos,
                        format!("expected \",\" or {what}, found {}", t.describe()),
                    ))
                }
            }
        }
    }

    fn primary(&mut self) -> Result<Node, ParseError> {
        let t = self.bump();
        let leaf = |e: Expr| Ok((e, 1));
        match t.tok {
            Tok::Num(n) => leaf(Expr::Number(n)),
            Tok::Str(s) => leaf(Expr::Str(s)),
            Tok::Regex { source, flags } => leaf(Expr::Regex { source, flags }),
            Tok::Ident(name) => leaf(match name.as_str() {
                "true" => Expr::Bool(true),
                "false" => Expr::Bool(false),
                "null" => Expr::Null,
                _ => Expr::Ident(name),
            }),
            Tok::LParen => {
                let n = self.expr_node()?;
                self.expect(Tok::RParen, "\")\"")?;
                Ok(n)
            }
            Tok::LBracket => {
                let (items, h) = self.args(Tok::RBracket, "\"]\"")?;
                mk(Expr::List(items), h + 1)
            }
            other => Err(ParseError::new(
                t.pos,
                format!("unexpected {}", other.describe()),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(s: &str) -> String {
        parse(s).unwrap().to_source()
    }

    #[test]
    fn precedence_and_associativity() {
        assert_eq!(src("1 + 2 * 3"), "(1 + (2 * 3))");
        assert_eq!(src("1 - 2 - 3"), "((1 - 2) - 3)");
        assert_eq!(src("a || b && c"), "(a || (b && c))");
        assert_eq!(
            src("a == 1 && b != 2 || c"),
            "(((a == 1) && (b != 2)) || c)"
        );
        assert_eq!(src("a < b + 1"), "(a < (b + 1))");
        assert_eq!(src("!a && b"), "(!a && b)");
        assert_eq!(src("-a * b"), "(-a * b)");
        assert_eq!(src("(1 + 2) * 3"), "((1 + 2) * 3)");
        assert_eq!(src("a % 2 == 0"), "((a % 2) == 0)");
    }

    #[test]
    fn postfix_chains() {
        assert_eq!(
            src("file.name.lower().contains(\"x\")"),
            "file.name.lower().contains(\"x\")"
        );
        assert_eq!(src("note[\"creation date\"]"), "note[\"creation date\"]");
        assert_eq!(src("tags[0].length"), "tags[0].length");
        assert_eq!(src("formula.age + 1"), "(formula.age + 1)");
        assert_eq!(src("list(1, 2)[1]"), "list(1, 2)[1]");
    }

    #[test]
    fn literals() {
        assert_eq!(parse("null").unwrap(), Expr::Null);
        assert_eq!(parse("true").unwrap(), Expr::Bool(true));
        assert_eq!(
            parse("[1, [2], \"a\"]").unwrap().to_source(),
            "[1, [2], \"a\"]"
        );
        assert_eq!(parse("[]").unwrap(), Expr::List(vec![]));
        assert_eq!(parse("[1,]").unwrap(), Expr::List(vec![Expr::Number(1.0)]));
        assert!(matches!(parse("/a+/gi").unwrap(), Expr::Regex { .. }));
        assert_eq!(parse("'a'").unwrap(), Expr::Str("a".into()));
        assert_eq!(parse("1.5").unwrap(), Expr::Number(1.5));
    }

    #[test]
    fn lambda_expressions_parse_as_plain_args() {
        assert_eq!(
            src("tags.map(value.lower()).filter(value != \"x\")"),
            "tags.map(value.lower()).filter((value != \"x\"))"
        );
        assert_eq!(
            src("nums.reduce(acc + value, 0)"),
            "nums.reduce((acc + value), 0)"
        );
    }

    #[test]
    fn errors_carry_positions() {
        let e = parse("1 +").unwrap_err();
        assert_eq!(e.pos, 3);
        let e = parse("a.").unwrap_err();
        assert!(e.message.contains("name"));
        let e = parse("(1 + 2").unwrap_err();
        assert!(e.message.contains("\")\""));
        let e = parse("f(1 2)").unwrap_err();
        assert_eq!(e.pos, 4);
        assert!(parse("").is_err());
        assert!(parse("   ").is_err());
        assert!(parse("1 2").is_err());
        assert!(parse("a ? b : c").is_err());
        assert!(parse("x[").is_err());
    }

    #[test]
    fn deep_nesting_is_an_error_not_a_crash() {
        let deep = "(".repeat(5000) + "1" + &")".repeat(5000);
        assert!(parse(&deep).is_err());
        let bang = "!".repeat(5000) + "a";
        assert!(parse(&bang).is_err());
        // long chains are capped by tree height, not by token count
        let idx = "a".to_string() + &"[1]".repeat(3000);
        assert!(parse(&idx).is_err());
        let ok = "a".to_string() + &"[1]".repeat(150);
        assert!(parse(&ok).is_ok());
        let sum = "1+".repeat(3000) + "1";
        assert!(parse(&sum).is_err());
    }
}
