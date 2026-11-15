//! Safe translation of a user search string into an FTS5 `MATCH` expression.
//!
//! Nothing the user types is ever passed to FTS5 as syntax: every term is
//! emitted as a double-quoted string (with `"` doubled), so operators such as
//! `NEAR`, `AND`, `NOT`, `:`, `^`, `(` and `*` inside text are plain data, and
//! the result is *bound* as a parameter, never concatenated into SQL.
//!
//! Grammar (whitespace separated):
//! - `word`, `"a phrase"`            positive terms; terms are ANDed
//! - `word*`, `"a phrase"*`          prefix match on the last token
//! - `-word`, `-"a phrase"`          exclude notes containing it
//! - `a OR b`                        alternatives (`AND` is implicit and optional)
//! - `path:x`, `file:x`, `tag:x`     filters: path substring, file-name substring, tag
//!   (also `path:"my dir"`)
//!
//! A query without any positive term matches nothing (it is not an error).

use super::fts::space_cjk;
use super::IndexError;

pub const MAX_QUERY_CHARS: usize = 2000;
pub const MAX_TERMS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Filter {
    /// Substring of the vault-relative path (case-insensitive for ASCII).
    Path(String),
    /// Substring of the file base name.
    File(String),
    /// Normalised tag (lowercase, no `#`); nested tags match their ancestors.
    Tag(String),
    /// A filter whose value can never match (an invalid tag).
    Never,
}

/// A positive term kept for the case-sensitive post-filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Term {
    /// Alphanumeric words of the term as typed.
    pub words: Vec<String>,
    pub prefix: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParsedQuery {
    /// Full expression for `notes_fts`; `None` when there is no positive term.
    pub match_expr: Option<String>,
    /// Positive terms ORed: what to look for in individual lines.
    pub line_expr: Option<String>,
    pub filters: Vec<Filter>,
    pub positives: Vec<Term>,
}

struct Item {
    text: String,
    prefix: bool,
    /// A bare word (not a quoted phrase): eligible for `as_you_type`.
    bare: bool,
}

impl Item {
    fn fts(&self) -> Option<String> {
        fts_string(&self.text, self.prefix)
    }
}

fn words_of(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// `"text"` or `"text"*` for FTS5; `None` when the text has no token at all
/// (pure punctuation), which FTS5 would reject or ignore.
fn fts_string(text: &str, prefix: bool) -> Option<String> {
    let spaced = space_cjk(text);
    if !spaced.chars().any(char::is_alphanumeric) {
        return None;
    }
    let mut out = String::with_capacity(spaced.len() + 4);
    out.push('"');
    for c in spaced.chars() {
        if c == '"' {
            out.push('"');
        }
        if c != '\0' {
            out.push(c);
        }
    }
    out.push('"');
    if prefix {
        out.push('*');
    }
    Some(out)
}

struct Cursor<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
}

impl Cursor<'_> {
    fn skip_ws(&mut self) {
        while self.chars.peek().is_some_and(|c| c.is_whitespace()) {
            self.chars.next();
        }
    }

    /// Read up to the closing quote (the opening one is already consumed). An
    /// unterminated quote runs to the end of the input.
    fn quoted(&mut self) -> String {
        let mut s = String::new();
        for c in self.chars.by_ref() {
            if c == '"' {
                break;
            }
            s.push(c);
        }
        s
    }

    fn bare(&mut self) -> String {
        let mut s = String::new();
        while let Some(&c) = self.chars.peek() {
            if c.is_whitespace() {
                break;
            }
            s.push(c);
            self.chars.next();
        }
        s
    }
}

const FILTER_KEYS: [&str; 4] = ["path", "folder", "file", "tag"];

fn make_filter(key: &str, value: &str) -> Filter {
    match key {
        "path" | "folder" => Filter::Path(value.to_string()),
        "file" => Filter::File(value.to_string()),
        _ => match super::markdown::normalize_tag(value) {
            Some(t) => Filter::Tag(t),
            None => Filter::Never,
        },
    }
}

/// `as_you_type`: the user is still typing, so a trailing bare word (no space
/// after it) is matched as a prefix, as if it ended in `*`.
pub fn parse_query(input: &str, as_you_type: bool) -> Result<ParsedQuery, IndexError> {
    if input.chars().count() > MAX_QUERY_CHARS {
        return Err(IndexError::Invalid(format!(
            "search query is longer than {MAX_QUERY_CHARS} characters"
        )));
    }
    let mut cur = Cursor {
        chars: input.chars().peekable(),
    };
    let mut groups: Vec<Vec<Item>> = vec![Vec::new()];
    let mut negatives: Vec<Item> = Vec::new();
    let mut filters = Vec::new();
    let mut count = 0usize;
    // The last thing consumed was a positive bare word (as-you-type prefix).
    let mut trailing_bare = false;

    loop {
        cur.skip_ws();
        let Some(&first) = cur.chars.peek() else {
            break;
        };
        trailing_bare = false;
        let mut negated = false;
        let (text, prefix_marker, bare);
        if first == '-' {
            cur.chars.next();
            // A lone `-` or `- x` is not an exclusion.
            if cur.chars.peek().is_none_or(|c| c.is_whitespace()) {
                continue;
            }
            negated = true;
        }
        if cur.chars.peek() == Some(&'"') {
            cur.chars.next();
            text = cur.quoted();
            prefix_marker = cur.chars.peek() == Some(&'*');
            if prefix_marker {
                cur.chars.next();
            }
            bare = false;
        } else {
            let mut word = cur.bare();
            if !negated {
                if word == "OR" {
                    if groups.last().is_some_and(|g| !g.is_empty()) {
                        groups.push(Vec::new());
                    }
                    continue;
                }
                if word == "AND" {
                    continue;
                }
                if let Some((key, rest)) = word.split_once(':') {
                    let key = key.to_lowercase();
                    if FILTER_KEYS.contains(&key.as_str()) {
                        let value = match rest.strip_prefix('"') {
                            // `path:"my dir"`: the bare read stopped at the first space.
                            Some(inner) => match inner.split_once('"') {
                                Some((v, _)) => v.to_string(),
                                None => format!("{inner}{}", cur.quoted()),
                            },
                            None => rest.to_string(),
                        };
                        if !value.trim().is_empty() {
                            filters.push(make_filter(&key, value.trim()));
                        }
                        continue;
                    }
                }
            }
            prefix_marker = word.ends_with('*');
            if prefix_marker {
                word.pop();
            }
            text = word;
            bare = true;
        }
        let item = Item {
            text,
            prefix: prefix_marker,
            bare,
        };
        if item.fts().is_none() {
            continue; // no token at all (punctuation)
        }
        count += 1;
        if count > MAX_TERMS {
            return Err(IndexError::Invalid(format!(
                "search query has more than {MAX_TERMS} terms"
            )));
        }
        if negated {
            negatives.push(item);
        } else {
            trailing_bare = item.bare;
            groups.last_mut().expect("one group").push(item);
        }
    }
    if as_you_type && trailing_bare && !input.ends_with(char::is_whitespace) {
        if let Some(last) = groups.last_mut().and_then(|g| g.last_mut()) {
            last.prefix = true;
        }
    }

    let groups: Vec<Vec<Item>> = groups.into_iter().filter(|g| !g.is_empty()).collect();
    if groups.is_empty() {
        return Ok(ParsedQuery {
            filters,
            ..ParsedQuery::default()
        });
    }
    let fts_of = |i: &Item| i.fts().expect("token-less items were dropped");
    let alternatives: Vec<String> = groups
        .iter()
        .map(|g| {
            format!(
                "({})",
                g.iter().map(fts_of).collect::<Vec<_>>().join(" AND ")
            )
        })
        .collect();
    let mut expr = alternatives.join(" OR ");
    if !negatives.is_empty() {
        let neg: Vec<String> = negatives.iter().map(fts_of).collect();
        expr = format!("({expr}) NOT ({})", neg.join(" OR "));
    }
    let line_expr = groups
        .iter()
        .flatten()
        .map(fts_of)
        .collect::<Vec<_>>()
        .join(" OR ");
    Ok(ParsedQuery {
        match_expr: Some(expr),
        line_expr: Some(line_expr),
        filters,
        positives: groups
            .iter()
            .flatten()
            .map(|i| Term {
                words: words_of(&i.text),
                prefix: i.prefix,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expr(q: &str) -> Option<String> {
        parse_query(q, false).unwrap().match_expr
    }

    #[test]
    fn terms_phrases_prefix_exclusion_or() {
        assert_eq!(expr("alpha beta").unwrap(), "(\"alpha\" AND \"beta\")");
        assert_eq!(expr("\"exact phrase\"").unwrap(), "(\"exact phrase\")");
        assert_eq!(expr("alp*").unwrap(), "(\"alp\"*)");
        assert_eq!(expr("a OR b c").unwrap(), "(\"a\") OR (\"b\" AND \"c\")");
        assert_eq!(
            expr("keep -drop -\"two words\"").unwrap(),
            "((\"keep\")) NOT (\"drop\" OR \"two words\")"
        );
        assert_eq!(expr("东京").unwrap(), "(\" 东  京 \")");
    }

    #[test]
    fn syntax_characters_are_data() {
        assert_eq!(
            expr("NEAR(a b) col:x ^start a\"b").unwrap(),
            "(\"NEAR(a\" AND \"b)\" AND \"col:x\" AND \"^start\" AND \"a\"\"b\")"
        );
        assert_eq!(
            expr("\"unterminated phrase").unwrap(),
            "(\"unterminated phrase\")"
        );
        // Pure punctuation has no token: dropped, not an FTS syntax error.
        assert_eq!(expr("!!! ---"), None);
        assert_eq!(expr("-onlyneg"), None);
        assert_eq!(expr(""), None);
    }

    #[test]
    fn filters_and_line_expr() {
        let q = parse_query("tag:#Project path:\"My Dir\" file:note word", false).unwrap();
        assert_eq!(
            q.filters,
            vec![
                Filter::Tag("project".into()),
                Filter::Path("My Dir".into()),
                Filter::File("note".into())
            ]
        );
        assert_eq!(q.line_expr.as_deref(), Some("\"word\""));
        let none = parse_query("tag:", false).unwrap();
        assert!(none.filters.is_empty() && none.match_expr.is_none());
        assert_eq!(
            parse_query("tag:%%%", false).unwrap().filters,
            vec![Filter::Never]
        );
    }

    #[test]
    fn as_you_type_prefixes_only_the_trailing_bare_word() {
        let e = |q: &str| parse_query(q, true).unwrap().match_expr.unwrap();
        assert_eq!(e("alpha har"), "(\"alpha\" AND \"har\"*)");
        assert_eq!(e("alpha har "), "(\"alpha\" AND \"har\")");
        assert_eq!(e("alpha \"har\""), "(\"alpha\" AND \"har\")");
        assert_eq!(e("alpha har -x"), "((\"alpha\" AND \"har\")) NOT (\"x\")");
        assert_eq!(e("alpha har OR "), "(\"alpha\" AND \"har\")");
    }

    #[test]
    fn limits_are_explicit_errors() {
        let many = (0..65)
            .map(|i| format!("w{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(matches!(
            parse_query(&many, false),
            Err(IndexError::Invalid(_))
        ));
        assert!(matches!(
            parse_query(&"a".repeat(MAX_QUERY_CHARS + 1), false),
            Err(IndexError::Invalid(_))
        ));
    }
}
