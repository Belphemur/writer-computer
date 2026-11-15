//! Tokenizer for the Bases expression language. Never panics: every failure is
//! a [`ParseError`] with a byte position.

use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum Tok {
    Num(f64),
    Str(String),
    Regex { source: String, flags: String },
    Ident(String),
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Dot,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Bang,
    EqEq,
    NotEq,
    Lt,
    Gt,
    Le,
    Ge,
    AndAnd,
    OrOr,
    Eof,
}

impl Tok {
    pub fn describe(&self) -> String {
        match self {
            Tok::Num(n) => format!("number {n}"),
            Tok::Str(_) => "string".into(),
            Tok::Regex { .. } => "regular expression".into(),
            Tok::Ident(n) => format!("name \"{n}\""),
            Tok::LParen => "\"(\"".into(),
            Tok::RParen => "\")\"".into(),
            Tok::LBracket => "\"[\"".into(),
            Tok::RBracket => "\"]\"".into(),
            Tok::Comma => "\",\"".into(),
            Tok::Dot => "\".\"".into(),
            Tok::Plus => "\"+\"".into(),
            Tok::Minus => "\"-\"".into(),
            Tok::Star => "\"*\"".into(),
            Tok::Slash => "\"/\"".into(),
            Tok::Percent => "\"%\"".into(),
            Tok::Bang => "\"!\"".into(),
            Tok::EqEq => "\"==\"".into(),
            Tok::NotEq => "\"!=\"".into(),
            Tok::Lt => "\"<\"".into(),
            Tok::Gt => "\">\"".into(),
            Tok::Le => "\"<=\"".into(),
            Tok::Ge => "\">=\"".into(),
            Tok::AndAnd => "\"&&\"".into(),
            Tok::OrOr => "\"||\"".into(),
            Tok::Eof => "end of expression".into(),
        }
    }
}

/// Syntax error with a byte offset into the expression source.
#[derive(Clone, Debug, PartialEq)]
pub struct ParseError {
    pub pos: usize,
    pub message: String,
}

impl ParseError {
    pub fn new(pos: usize, message: impl Into<String>) -> Self {
        ParseError {
            pos,
            message: message.into(),
        }
    }

    /// 1-based (line, column) of the error in `src`, counting characters.
    pub fn line_col(&self, src: &str) -> (usize, usize) {
        let mut line = 1;
        let mut col = 1;
        for (i, c) in src.char_indices() {
            if i >= self.pos {
                break;
            }
            if c == '\n' {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
        }
        (line, col)
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (at {})", self.message, self.pos)
    }
}

impl std::error::Error for ParseError {}

#[derive(Clone, Debug)]
pub struct Token {
    pub tok: Tok,
    pub pos: usize,
}

fn is_ident_start(c: char) -> bool {
    c == '_' || c == '$' || c.is_alphabetic()
}

fn is_ident_char(c: char) -> bool {
    c == '_' || c == '$' || c.is_alphanumeric()
}

/// Whether a `/` after this token is a division (true) or starts a regexp.
fn ends_value(t: &Tok) -> bool {
    matches!(
        t,
        Tok::Num(_) | Tok::Str(_) | Tok::Regex { .. } | Tok::Ident(_) | Tok::RParen | Tok::RBracket
    )
}

pub fn tokenize(src: &str) -> Result<Vec<Token>, ParseError> {
    let chars: Vec<(usize, char)> = src.char_indices().collect();
    let mut out: Vec<Token> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let (pos, c) = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let two = chars.get(i + 1).map(|x| x.1);
        let push = |out: &mut Vec<Token>, tok: Tok| out.push(Token { tok, pos });
        match c {
            '(' => push(&mut out, Tok::LParen),
            ')' => push(&mut out, Tok::RParen),
            '[' => push(&mut out, Tok::LBracket),
            ']' => push(&mut out, Tok::RBracket),
            ',' => push(&mut out, Tok::Comma),
            '+' => push(&mut out, Tok::Plus),
            '-' => push(&mut out, Tok::Minus),
            '*' => push(&mut out, Tok::Star),
            '%' => push(&mut out, Tok::Percent),
            '.' => push(&mut out, Tok::Dot),
            '!' => {
                if two == Some('=') {
                    push(&mut out, Tok::NotEq);
                    i += 1;
                } else {
                    push(&mut out, Tok::Bang);
                }
            }
            '=' => {
                if two == Some('=') {
                    push(&mut out, Tok::EqEq);
                    i += 1;
                } else {
                    return Err(ParseError::new(
                        pos,
                        "unexpected \"=\": use \"==\" to compare",
                    ));
                }
            }
            '<' => {
                if two == Some('=') {
                    push(&mut out, Tok::Le);
                    i += 1;
                } else {
                    push(&mut out, Tok::Lt);
                }
            }
            '>' => {
                if two == Some('=') {
                    push(&mut out, Tok::Ge);
                    i += 1;
                } else {
                    push(&mut out, Tok::Gt);
                }
            }
            '&' => {
                if two == Some('&') {
                    push(&mut out, Tok::AndAnd);
                    i += 1;
                } else {
                    return Err(ParseError::new(pos, "unexpected \"&\": use \"&&\""));
                }
            }
            '|' => {
                if two == Some('|') {
                    push(&mut out, Tok::OrOr);
                    i += 1;
                } else {
                    return Err(ParseError::new(pos, "unexpected \"|\": use \"||\""));
                }
            }
            '"' | '\'' => {
                let (s, next) = lex_string(&chars, i)?;
                out.push(Token {
                    tok: Tok::Str(s),
                    pos,
                });
                i = next;
                continue;
            }
            '/' => {
                let regex_ok = out.last().map(|t| !ends_value(&t.tok)).unwrap_or(true);
                if regex_ok {
                    let (tok, next) = lex_regex(&chars, i)?;
                    out.push(Token { tok, pos });
                    i = next;
                    continue;
                }
                push(&mut out, Tok::Slash);
            }
            c if c.is_ascii_digit() => {
                let mut j = i;
                while j < chars.len() && chars[j].1.is_ascii_digit() {
                    j += 1;
                }
                if j + 1 < chars.len() && chars[j].1 == '.' && chars[j + 1].1.is_ascii_digit() {
                    j += 1;
                    while j < chars.len() && chars[j].1.is_ascii_digit() {
                        j += 1;
                    }
                }
                let text: String = chars[i..j].iter().map(|x| x.1).collect();
                let n: f64 = text
                    .parse()
                    .map_err(|_| ParseError::new(pos, format!("invalid number \"{text}\"")))?;
                if !n.is_finite() {
                    return Err(ParseError::new(pos, "number too large"));
                }
                out.push(Token {
                    tok: Tok::Num(n),
                    pos,
                });
                i = j;
                continue;
            }
            c if is_ident_start(c) => {
                let mut j = i;
                while j < chars.len() && is_ident_char(chars[j].1) {
                    j += 1;
                }
                let text: String = chars[i..j].iter().map(|x| x.1).collect();
                out.push(Token {
                    tok: Tok::Ident(text),
                    pos,
                });
                i = j;
                continue;
            }
            other => {
                return Err(ParseError::new(
                    pos,
                    format!("unexpected character \"{other}\""),
                ))
            }
        }
        i += 1;
    }
    out.push(Token {
        tok: Tok::Eof,
        pos: src.len(),
    });
    Ok(out)
}

fn lex_string(chars: &[(usize, char)], start: usize) -> Result<(String, usize), ParseError> {
    let quote = chars[start].1;
    let mut s = String::new();
    let mut i = start + 1;
    while i < chars.len() {
        let c = chars[i].1;
        if c == quote {
            return Ok((s, i + 1));
        }
        if c == '\\' {
            i += 1;
            let Some(&(epos, e)) = chars.get(i) else {
                break;
            };
            match e {
                'n' => s.push('\n'),
                't' => s.push('\t'),
                'r' => s.push('\r'),
                '0' => s.push('\0'),
                '\\' => s.push('\\'),
                '"' => s.push('"'),
                '\'' => s.push('\''),
                'u' => {
                    // \uXXXX or \u{X...}
                    let (code, next) = lex_unicode_escape(chars, i + 1)
                        .ok_or_else(|| ParseError::new(epos, "invalid \\u escape"))?;
                    s.push(code);
                    i = next;
                    continue;
                }
                // Unknown escapes keep the backslash so regexp-ish strings
                // such as "\d+" survive.
                other => {
                    s.push('\\');
                    s.push(other);
                }
            }
            i += 1;
            continue;
        }
        s.push(c);
        i += 1;
    }
    Err(ParseError::new(chars[start].0, "unterminated string"))
}

fn lex_unicode_escape(chars: &[(usize, char)], mut i: usize) -> Option<(char, usize)> {
    let mut hex = String::new();
    if chars.get(i).map(|x| x.1) == Some('{') {
        i += 1;
        while let Some(&(_, c)) = chars.get(i) {
            i += 1;
            if c == '}' {
                let v = u32::from_str_radix(&hex, 16).ok()?;
                return Some((char::from_u32(v)?, i));
            }
            if !c.is_ascii_hexdigit() || hex.len() >= 6 {
                return None;
            }
            hex.push(c);
        }
        None
    } else {
        for _ in 0..4 {
            let c = chars.get(i)?.1;
            if !c.is_ascii_hexdigit() {
                return None;
            }
            hex.push(c);
            i += 1;
        }
        let v = u32::from_str_radix(&hex, 16).ok()?;
        Some((char::from_u32(v)?, i))
    }
}

fn lex_regex(chars: &[(usize, char)], start: usize) -> Result<(Tok, usize), ParseError> {
    let mut i = start + 1;
    let mut source = String::new();
    let mut in_class = false;
    while i < chars.len() {
        let c = chars[i].1;
        match c {
            '\n' => break,
            '\\' => {
                source.push(c);
                i += 1;
                match chars.get(i) {
                    Some(&(_, n)) if n != '\n' => source.push(n),
                    _ => break,
                }
            }
            '[' => {
                in_class = true;
                source.push(c);
            }
            ']' => {
                in_class = false;
                source.push(c);
            }
            '/' if !in_class => {
                i += 1;
                let mut flags = String::new();
                while i < chars.len() && chars[i].1.is_ascii_alphabetic() {
                    flags.push(chars[i].1);
                    i += 1;
                }
                if source.is_empty() {
                    return Err(ParseError::new(chars[start].0, "empty regular expression"));
                }
                return Ok((Tok::Regex { source, flags }, i));
            }
            c => source.push(c),
        }
        i += 1;
    }
    Err(ParseError::new(
        chars[start].0,
        "unterminated regular expression",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(s: &str) -> Vec<Tok> {
        tokenize(s).unwrap().into_iter().map(|t| t.tok).collect()
    }

    #[test]
    fn basic_tokens() {
        assert_eq!(
            toks("a.b(1, \"x\") >= 2.5"),
            vec![
                Tok::Ident("a".into()),
                Tok::Dot,
                Tok::Ident("b".into()),
                Tok::LParen,
                Tok::Num(1.0),
                Tok::Comma,
                Tok::Str("x".into()),
                Tok::RParen,
                Tok::Ge,
                Tok::Num(2.5),
                Tok::Eof
            ]
        );
    }

    #[test]
    fn regex_vs_division() {
        assert!(matches!(toks("a / b / c")[1], Tok::Slash));
        assert!(matches!(toks("(1) / 2")[3], Tok::Slash));
        assert!(matches!(toks("x.matches(/ab+/i)")[4], Tok::Regex { .. }));
        assert!(
            matches!(&toks("/[/]x/g")[0], Tok::Regex { source, flags } if source == "[/]x" && flags == "g")
        );
    }

    #[test]
    fn string_escapes() {
        assert_eq!(
            toks(r#""a\nb\"c\u0041\u{1F600}""#)[0],
            Tok::Str("a\nb\"cA\u{1F600}".into())
        );
        assert_eq!(toks(r#"'it\'s'"#)[0], Tok::Str("it's".into()));
        assert_eq!(toks(r#""\d+""#)[0], Tok::Str("\\d+".into()));
    }

    #[test]
    fn errors_have_positions() {
        let e = tokenize("a = 1").unwrap_err();
        assert_eq!(e.pos, 2);
        let e = tokenize("\"abc").unwrap_err();
        assert_eq!(e.pos, 0);
        assert!(tokenize("a # b").is_err());
        assert!(tokenize("\"\\u12\"").is_err());
        assert_eq!(e.line_col("\"abc"), (1, 1));
    }

    #[test]
    fn unicode_identifiers() {
        assert_eq!(toks("créé")[0], Tok::Ident("créé".into()));
        assert_eq!(
            toks("a-b"),
            vec![
                Tok::Ident("a".into()),
                Tok::Minus,
                Tok::Ident("b".into()),
                Tok::Eof
            ]
        );
    }
}
