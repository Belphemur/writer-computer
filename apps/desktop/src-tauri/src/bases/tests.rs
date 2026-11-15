//! Engine-level tests: expression semantics against the synthetic vault, golden
//! `.base` queries, document round trips and hand-rolled randomized properties.
//! Everything uses the injected clock (2024-03-15T10:30:00, a Friday).

use super::ast::{BinaryOp, Expr, UnaryOp};
use super::context::{Clock, FixedClock};
use super::datetime::{self, DurationValue};
use super::document::{Direction, Document, DocumentError, Filter};
use super::functions::FUNCTIONS;
use super::interp::{FormulaSet, Interp, Scope};
use super::parser;
use super::query::{run_view, BaseQueryResult, QueryErrorKind, QueryOptions};
use super::testkit::*;
use super::value::{compare_for_sort, ErrorKind, Value};
use crate::bases::choices::FilterErrorPolicy;
use std::rc::Rc;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

struct Env {
    store: Rc<Store>,
    clock: FixedClock,
    formulas: FormulaSet,
}

impl Env {
    fn new() -> Env {
        Env {
            store: sample_store(),
            clock: clock(),
            formulas: FormulaSet::default(),
        }
    }

    fn with_formulas(pairs: &[(&str, &str)]) -> Env {
        let mut e = Env::new();
        let v: Vec<(String, String)> = pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        e.formulas = FormulaSet::compile(&v);
        e
    }

    fn at(&self, row: &str, this: Option<&str>, src: &str) -> Value {
        let ctx = Mem::rc(&self.store, row);
        let this = this.map(|p| Mem::rc(&self.store, p));
        Interp::new(&self.clock, &self.formulas, ctx, this).eval_source(src)
    }

    fn ev(&self, src: &str) -> Value {
        self.at("Projects/Plan.md", Some("Home.md"), src)
    }

    fn disp(&self, src: &str) -> String {
        self.ev(src).display()
    }
}

fn is_err(v: &Value, kind: ErrorKind) -> bool {
    matches!(v, Value::Error(e) if e.kind == kind)
}

/// Tiny deterministic PRNG (xorshift64*), so the randomized tests are
/// reproducible without a dev-dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + self.below((hi - lo + 1) as u64) as i64
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len() as u64) as usize]
    }
}

// ---------------------------------------------------------------------------
// operators, coercions, truthiness (U12)
// ---------------------------------------------------------------------------

#[test]
fn arithmetic_and_precedence() {
    let e = Env::new();
    for (src, want) in [
        ("1 + 2 * 3", "7"),
        ("(1 + 2) * 3", "9"),
        ("10 % 4", "2"),
        ("7 / 2", "3.5"),
        ("-3 + 5", "2"),
        ("2 * -3", "-6"),
        ("\"a\" + \"b\"", "ab"),
        ("\"a\" + 1", "a1"),
        ("1 + \"a\"", "1a"),
        ("\"n=\" + 2.5", "n=2.5"),
    ] {
        assert_eq!(e.disp(src), want, "{src}");
    }
    assert!(is_err(&e.ev("1 / 0"), ErrorKind::Runtime));
    assert!(is_err(&e.ev("1 % 0"), ErrorKind::Runtime));
    assert!(is_err(&e.ev("null + 1"), ErrorKind::Type));
    assert!(is_err(&e.ev("\"a\" - 1"), ErrorKind::Type));
    assert!(is_err(&e.ev("\"a\" + null"), ErrorKind::Type));
    assert!(is_err(&e.ev("[1] + [2]"), ErrorKind::Type));
    assert!(is_err(&e.ev("-\"a\""), ErrorKind::Type));
}

#[test]
fn comparison_and_equality() {
    let e = Env::new();
    for (src, want) in [
        ("1 == 1", true),
        ("1 != 2", true),
        ("\"1\" == 1", false),
        ("true == 1", false),
        ("null == null", true),
        ("null == 0", false),
        ("null != 0", true),
        ("1 < 2", true),
        ("2 <= 2", true),
        ("3 > 4", false),
        ("\"a\" < \"b\"", true),
        ("\"apple\" < \"Banana\"", true),
        ("null < 1", false),
        ("null >= null", false),
        ("1 < \"a\"", false),
        ("[1, 2] == [1, 2]", true),
        ("[1, 2] == [2, 1]", false),
        ("date(\"2024-03-10\") < today()", true),
        ("date(\"2024-03-15\") == today()", true),
        ("today() == \"2024-03-15\"", false),
        ("true && false", false),
        ("false || \"x\"", true),
        ("!0", true),
        ("!\"\"", true),
        ("![]", false),
        ("!null", true),
        ("1 < 2 && 2 < 3", true),
    ] {
        assert_eq!(e.ev(src), Value::Bool(want), "{src}");
    }
}

#[test]
fn logical_operators_short_circuit_and_propagate_errors() {
    let e = Env::new();
    assert_eq!(e.ev("false && 1 / 0"), Value::Bool(false));
    assert_eq!(e.ev("true || 1 / 0"), Value::Bool(true));
    assert!(e.ev("true && 1 / 0").as_error().is_some());
    assert!(e.ev("1 / 0 || true").as_error().is_some());
    assert!(e.ev("!(1 / 0)").as_error().is_some());
}

#[test]
fn if_is_lazy_and_does_not_swallow_errors() {
    let e = Env::new();
    assert_eq!(e.disp("if(true, 1, 2)"), "1");
    assert_eq!(e.disp("if(false, 1, 2)"), "2");
    assert!(e.ev("if(false, 1)").is_null());
    assert_eq!(e.disp("if(null, \"a\", \"b\")"), "b");
    assert_eq!(e.disp("if(true, 1, 1 / 0)"), "1");
    assert!(e.ev("if(1 / 0, 1, 2)").as_error().is_some());
    assert!(e.ev("if(true, 1 / 0, 2)").as_error().is_some());
    assert!(is_err(&e.ev("if(true)"), ErrorKind::Arity));
}

#[test]
fn property_namespaces_and_missing_values() {
    let e = Env::new();
    assert_eq!(e.disp("status"), "active");
    assert_eq!(e.disp("note.status"), "active");
    assert_eq!(e.disp("note[\"status\"]"), "active");
    assert!(e.ev("nonexistent").is_null());
    assert!(e.ev("nonexistent.length").is_null());
    assert!(e.ev("nonexistent.lower()").is_null());
    assert!(is_err(
        &e.ev("nonexistent.nosuchmethod()"),
        ErrorKind::UnknownMethod
    ));
    assert!(is_err(&e.ev("nosuchfn(1)"), ErrorKind::UnknownFunction));
    assert!(is_err(&e.ev("len(status)"), ErrorKind::UnknownFunction));
    assert!(is_err(&e.ev("\"x\".length()"), ErrorKind::UnknownMethod));
    assert!(is_err(&e.ev("\"x\".lower(1)"), ErrorKind::Arity));
    assert!(is_err(&e.ev("formula.nope"), ErrorKind::UnknownFormula));
    // a property may shadow a function name
    let ctx = Env::new();
    assert_eq!(
        ctx.at("Projects/Task 01.md", None, "status").display(),
        "active"
    );
    // names with spaces use bracket syntax; underscores do not match
    assert_eq!(
        e.at("Projects/Task 06.md", None, "note[\"creation date\"].year")
            .display(),
        "2024"
    );
    assert!(e.at("Projects/Task 06.md", None, "creation_date").is_null());
    // `this`
    assert_eq!(e.disp("this.file.name"), "Home.md");
    assert_eq!(e.disp("this.name"), "Home.md");
    assert!(e.ev("this.status").is_null());
    assert_eq!(
        e.at("Home.md", Some("Projects/Plan.md"), "this.status")
            .display(),
        "active"
    );
    assert_eq!(
        e.at("Home.md", Some("Projects/Plan.md"), "this.note.score")
            .display(),
        "8.5"
    );
}

// ---------------------------------------------------------------------------
// formulas
// ---------------------------------------------------------------------------

#[test]
fn formulas_reference_each_other_and_report_cycles() {
    let e = Env::with_formulas(&[
        ("a", "formula.b + 1"),
        ("b", "2"),
        ("c1", "formula.c2"),
        ("c2", "formula.c1"),
        ("me", "formula.me"),
        ("bad", "1 +"),
        ("upper", "status.title()"),
    ]);
    assert_eq!(e.disp("formula.a"), "3");
    assert_eq!(e.disp("formula[\"a\"] * 2"), "6");
    assert!(is_err(&e.ev("formula.c1"), ErrorKind::Circular));
    assert!(is_err(&e.ev("formula.me"), ErrorKind::Circular));
    assert!(is_err(&e.ev("formula.bad"), ErrorKind::Syntax));
    assert_eq!(e.disp("formula.upper"), "Active");
    // one broken formula does not affect another
    assert_eq!(e.disp("formula.b"), "2");
}

#[test]
fn formula_chain_depth_is_bounded() {
    let pairs: Vec<(String, String)> = (0..200)
        .map(|i| (format!("f{i}"), format!("formula.f{} + 1", i + 1)))
        .chain(std::iter::once(("f200".to_string(), "0".to_string())))
        .collect();
    let mut e = Env::new();
    e.formulas = FormulaSet::compile(&pairs);
    let v = e.ev("formula.f0");
    assert!(is_err(&v, ErrorKind::Runtime), "{v:?}");
    assert_eq!(e.disp("formula.f190"), "10");
}

// ---------------------------------------------------------------------------
// dates and durations (U3, U9, U10)
// ---------------------------------------------------------------------------

#[test]
fn clock_dates_and_arithmetic() {
    let e = Env::new();
    for (src, want) in [
        ("today()", "2024-03-15"),
        ("now()", "2024-03-15T10:30:00"),
        ("today() + \"1d\"", "2024-03-16"),
        ("today() - \"2 weeks\"", "2024-03-01"),
        ("date(\"2024-01-31\") + \"1M\"", "2024-02-29"),
        ("date(\"2024-01-31\") + \"1y\"", "2025-01-31"),
        ("now() - \"2h\"", "2024-03-15T08:30:00"),
        ("today() + \"1h\"", "2024-03-15T01:00:00"),
        ("date(\"2024-03-15 14:05:09\")", "2024-03-15T14:05:09"),
        ("date(\"2024-03-15T14:05:09Z\")", "2024-03-15T14:05:09"),
        ("date(\"2024-03-15\").date()", "2024-03-15"),
        ("date(\"2024-03-15 14:05:09\").date()", "2024-03-15"),
        ("date(\"2024-03-15 14:05:09\").time()", "14:05:09"),
        ("(date(\"2024-03-20\") - today()).days", "5"),
        ("(today() - date(\"2024-03-01\")).days", "14"),
        ("(now() - date(\"2024-03-15\")).hours", "10.5"),
        ("(now() - date(\"2024-03-15\")).minutes", "630"),
        ("(now() - date(\"2024-03-15\")).seconds", "37800"),
        ("duration(\"2 weeks\").days", "14"),
        ("duration(\"1d\") * 3", "3d"),
        ("duration(\"1h\") + duration(\"30m\")", "1h 30m"),
        ("duration(\"1d\") / 2", "12h"),
        ("-duration(\"1d\")", "-1d"),
        ("date(\"2024-03-15\").year", "2024"),
        ("date(\"2024-03-15\").month", "3"),
        ("date(\"2024-03-15\").day", "15"),
        ("now().hour", "10"),
        ("now().minute", "30"),
        ("now().second", "0"),
        ("now().millisecond", "0"),
        (
            "date(\"2024-03-15\").format(\"ddd, MMM D YYYY\")",
            "Fri, Mar 15 2024",
        ),
        ("now().format(\"HH:mm\")", "10:30"),
        ("now().format(\"h:mm A\")", "10:30 AM"),
        ("date(\"2024-03-10\").relative()", "5 days ago"),
        ("date(\"2024-03-17\").relative()", "in 2 days"),
        ("now().relative()", "a few seconds ago"),
        ("number(date(\"1970-01-02\"))", "86400000"),
    ] {
        assert_eq!(e.disp(src), want, "{src}");
    }
    assert!(is_err(&e.ev("date(\"nonsense\")"), ErrorKind::Runtime));
    assert!(is_err(&e.ev("date(null)"), ErrorKind::Type));
    assert!(is_err(&e.ev("date(5)"), ErrorKind::Type));
    assert!(is_err(&e.ev("3 * duration(\"1d\")"), ErrorKind::Type));
    assert!(is_err(&e.ev("today() + \"soon\""), ErrorKind::Runtime));
    assert!(is_err(&e.ev("today() + 1"), ErrorKind::Type));
    assert!(is_err(&e.ev("duration(\"x\")"), ErrorKind::Runtime));
}

#[test]
fn explicit_offset_in_date_strings_uses_the_clock_offset() {
    let mut e = Env::new();
    e.clock = FixedClock {
        utc_ms: d("2024-03-15T10:30:00"),
        offset_minutes: 120,
    };
    // now() is local: UTC 10:30 at +02:00 => 12:30
    assert_eq!(e.disp("now()"), "2024-03-15T12:30:00");
    assert_eq!(
        e.disp("date(\"2024-03-15T10:00:00Z\")"),
        "2024-03-15T12:00:00"
    );
    assert_eq!(
        e.disp("date(\"2024-03-15T10:00:00+02:00\")"),
        "2024-03-15T10:00:00"
    );
    assert_eq!(e.disp("now().format(\"Z\")"), "+02:00");
}

// ---------------------------------------------------------------------------
// strings, numbers, lists, objects, regexp
// ---------------------------------------------------------------------------

#[test]
fn string_functions() {
    let e = Env::new();
    for (src, want) in [
        ("\"Hello\".length", "5"),
        ("\"Hello\".lower()", "hello"),
        ("\"hello wORLD\".title()", "Hello World"),
        ("\"  x \".trim()", "x"),
        ("\"abc\".contains(\"b\")", "true"),
        ("\"abc\".contains(\"B\")", "false"),
        ("\"abc\".containsAll(\"a\", \"c\")", "true"),
        ("\"abc\".containsAll(\"a\", \"z\")", "false"),
        ("\"abc\".containsAny(\"x\", \"c\")", "true"),
        ("\"abc\".endsWith(\"bc\")", "true"),
        ("\"abc\".startsWith(\"ab\")", "true"),
        ("\"abc\".reverse()", "cba"),
        ("\"ab\".repeat(3)", "ababab"),
        ("\"hello\".slice(1, 3)", "el"),
        ("\"hello\".slice(-2)", "lo"),
        ("\"hello\".slice(2)", "llo"),
        ("\"a,b,c\".split(\",\").length", "3"),
        ("\"a,b,c\".split(\",\", 2).length", "2"),
        ("\"a1b22c\".split(/\\d+/).join(\"|\")", "a|b|c"),
        ("\"heLLo\".replace(\"L\", \"l\")", "hello"),
        ("\"aaa\".replace(\"a\", \"b\")", "bbb"),
        ("\"abc\".replace(/b/, \"[$&]\")", "a[b]c"),
        ("\"a-b-c\".replace(/-/g, \"+\")", "a+b+c"),
        ("\"a-b-c\".replace(/-/, \"+\")", "a+b-c"),
        (
            "\"john smith\".replace(/(\\w+) (\\w+)/, \"$2, $1\")",
            "smith, john",
        ),
        ("\"\".isEmpty()", "true"),
        ("\"x\".isEmpty()", "false"),
        ("\"a\\tb\".length", "3"),
        ("\"日本語\".length", "3"),
        ("\"x\".isType(\"string\")", "true"),
        ("\"x\".toString()", "x"),
    ] {
        assert_eq!(e.disp(src), want, "{src}");
    }
    assert!(is_err(&e.ev("\"abc\".contains(1)"), ErrorKind::Type));
    assert!(is_err(&e.ev("\"ab\".repeat(-1)"), ErrorKind::Runtime));
    assert!(is_err(
        &e.ev("\"ab\".repeat(100000000)"),
        ErrorKind::Runtime
    ));
    assert!(is_err(&e.ev("\"x\".replace(1, \"a\")"), ErrorKind::Type));
}

#[test]
fn regexp_values() {
    let e = Env::new();
    assert_eq!(e.ev("/ab+/.matches(\"xabbby\")"), Value::Bool(true));
    assert_eq!(e.ev("/^ab$/i.matches(\"AB\")"), Value::Bool(true));
    assert_eq!(e.ev("/^ab$/.matches(\"AB\")"), Value::Bool(false));
    assert_eq!(e.ev("/a/.isType(\"regexp\")"), Value::Bool(true));
    assert!(is_err(&e.ev("/(/"), ErrorKind::Runtime));
    assert!(is_err(&e.ev("/a/z"), ErrorKind::Runtime));
}

#[test]
fn number_functions() {
    let e = Env::new();
    for (src, want) in [
        ("(-3).abs()", "3"),
        ("(2.1).ceil()", "3"),
        ("(2.9).floor()", "2"),
        ("(2.5).round()", "3"),
        ("(-2.5).round()", "-3"),
        ("3.14159.round(2)", "3.14"),
        ("(1234).round(-2)", "1200"),
        ("(2.5).toFixed(0)", "3"),
        ("(1.005).toFixed(2)", "1.00"),
        ("(3).toFixed(2)", "3.00"),
        ("(-0.5).toFixed(0)", "-1"),
        ("number(\"42\")", "42"),
        ("number(\" 4.5 \")", "4.5"),
        ("number(true)", "1"),
        ("number(false)", "0"),
        ("min(3, 1, 2)", "1"),
        ("max(3, 1, 2)", "3"),
        ("max(5)", "5"),
        ("(5).isEmpty()", "false"),
        ("(5).isType(\"number\")", "true"),
        ("(5).toString()", "5"),
    ] {
        assert_eq!(e.disp(src), want, "{src}");
    }
    assert!(is_err(&e.ev("number(\"x\")"), ErrorKind::Runtime));
    assert!(is_err(&e.ev("number(\"\")"), ErrorKind::Runtime));
    assert!(is_err(&e.ev("number(null)"), ErrorKind::Type));
    assert!(is_err(&e.ev("max()"), ErrorKind::Arity));
    assert!(is_err(&e.ev("max(\"a\", 1)"), ErrorKind::Type));
    let r = e.ev("random()");
    assert!(matches!(r, Value::Number(x) if (0.0..1.0).contains(&x)));
}

#[test]
fn list_functions() {
    let e = Env::new();
    for (src, want) in [
        ("[1, 2, 3].length", "3"),
        ("[1, 2, 3][1]", "2"),
        ("[3, 1, 2].sort()", "1, 2, 3"),
        ("[\"b\", \"A\", \"a\"].sort()", "A, a, b"),
        ("[1, 2, 2, 1].unique()", "1, 2"),
        ("[1, 2, 3].reverse()", "3, 2, 1"),
        ("[1, 2, 3, 4].slice(1, 3)", "2, 3"),
        ("[1, 2, 3, 4].slice(-2)", "3, 4"),
        ("[1, 2, 3, 4].slice(10)", ""),
        ("[1, 2, 3].join(\"-\")", "1-2-3"),
        ("[1, 2, 3].map(value * 2)", "2, 4, 6"),
        ("[1, 2, 3].map(value + index)", "1, 3, 5"),
        ("[1, 2, 3, 4].filter(value % 2 == 0)", "2, 4"),
        ("[1, 2, 3, 4].filter(index > 0)", "2, 3, 4"),
        ("[1, 2, 3].reduce(acc + value, 0)", "6"),
        ("[\"a\", \"b\"].reduce(acc + value, \"\")", "ab"),
        ("[1, 2, 3].reduce(acc + index, 10)", "13"),
        ("[1, 2, 3].contains(2)", "true"),
        ("[1, 2, 3].contains(9)", "false"),
        ("[1, 2, 3].containsAll(1, 2)", "true"),
        ("[1, 2, 3].containsAny(9, 2)", "true"),
        ("[].isEmpty()", "true"),
        ("[1].isEmpty()", "false"),
        ("[1, [2, 3], [[4]]].flat().length", "4"),
        ("[1, 2, 3, 4].mean()", "2.5"),
        ("[1, 2, 3, 4].median()", "2.5"),
        ("[3, 1, 2].median()", "2"),
        ("[1, 2, 3, 4].sum()", "10"),
        ("[4, 9, 2].min()", "2"),
        ("[4, 9, 2].max()", "9"),
        ("[2, 4, 4, 4, 5, 5, 7, 9].stddev()", "2"),
        ("[].mean()", ""),
        ("list(1).length", "1"),
        ("list([1, 2]).length", "2"),
        ("[1,2].isType(\"list\")", "true"),
    ] {
        assert_eq!(e.disp(src), want, "{src}");
    }
    // flat() flattens one level only
    assert!(matches!(e.ev("[[1, [2]]].flat()[1]"), Value::List(_)));
    // nested lambdas shadow value
    assert_eq!(
        e.ev("[[1, 2], [3]].map(value.map(value * 10))").to_json()["value"][0]["value"][1]["value"],
        20.0
    );
    // errors inside lambdas propagate
    assert!(e.ev("[1, 2].map(value / 0)").as_error().is_some());
    assert!(e.ev("[1, 2].filter(nosuch(1))").as_error().is_some());
}

#[test]
fn object_functions() {
    let e = Env::new();
    for (src, want) in [
        ("meta.team", "core"),
        ("meta[\"size\"]", "3"),
        ("note.meta.team", "core"),
        ("meta.keys()", "team, size"),
        ("meta.values()", "core, 3"),
        ("meta.isEmpty()", "false"),
        ("meta.missing", ""),
        ("meta.isType(\"object\")", "true"),
    ] {
        assert_eq!(e.disp(src), want, "{src}");
    }
}

#[test]
fn any_functions_and_types() {
    let e = Env::new();
    for (src, want) in [
        ("0.isTruthy()", "false"),
        ("1.isTruthy()", "true"),
        ("\"\".isTruthy()", "false"),
        ("null.isTruthy()", "false"),
        ("null.isEmpty()", "true"),
        ("null.toString()", ""),
        ("[1, 2].toString()", "1, 2"),
        ("true.toString()", "true"),
        ("1.isType(\"string\")", "false"),
        ("null.isType(\"null\")", "true"),
        ("today().isType(\"date\")", "true"),
        ("duration(\"1d\").isType(\"duration\")", "true"),
        ("html(\"<b>\").isType(\"html\")", "true"),
        ("icon(\"star\").isType(\"icon\")", "true"),
        ("image(\"a.png\").isType(\"image\")", "true"),
        (
            "escapeHTML(\"<a href='x'>&\")",
            "&lt;a href=&#39;x&#39;&gt;&amp;",
        ),
        ("file.isType(\"file\")", "true"),
        ("link(\"Alice\").isType(\"link\")", "true"),
    ] {
        assert_eq!(e.disp(src), want, "{src}");
    }
}

#[test]
fn registry_surface_matches_the_docs() {
    let mut names: Vec<String> = FUNCTIONS.iter().map(|f| f.name.to_string()).collect();
    names.sort();
    names.dedup();
    let mut documented = vec![
        // global
        "escapeHTML",
        "date",
        "duration",
        "file",
        "html",
        "if",
        "image",
        "icon",
        "link",
        "list",
        "max",
        "min",
        "now",
        "number",
        "random",
        "today",
        // any
        "isTruthy",
        "isType",
        "toString",
        "isEmpty",
        // string
        "contains",
        "containsAll",
        "containsAny",
        "endsWith",
        "lower",
        "replace",
        "repeat",
        "reverse",
        "slice",
        "split",
        "startsWith",
        "title",
        "trim",
        // number
        "abs",
        "ceil",
        "floor",
        "round",
        "toFixed",
        // date
        "format",
        "time",
        "relative",
        // list
        "filter",
        "flat",
        "join",
        "map",
        "reduce",
        "sort",
        "unique",
        // link, file, object, regexp
        "asFile",
        "linksTo",
        "asLink",
        "hasLink",
        "hasProperty",
        "hasTag",
        "inFolder",
        "keys",
        "values",
        "matches",
        // U13 extensions
        "sum",
        "mean",
        "median",
        "stddev",
    ];
    documented.sort();
    documented.dedup();
    assert_eq!(names, documented);
    for f in FUNCTIONS {
        assert!(!f.doc.is_empty());
    }
}

#[test]
fn every_function_has_signature_doc_and_return_type() {
    let infos = super::functions::function_infos();
    assert_eq!(infos.len(), FUNCTIONS.len());
    for i in &infos {
        assert!(
            !i.signature.trim().is_empty(),
            "{} has no signature",
            i.name
        );
        assert!(!i.doc.trim().is_empty(), "{} has no doc", i.name);
        assert!(
            !i.returns.trim().is_empty(),
            "{} has no return type",
            i.name
        );
        assert!(!i.receivers.is_empty(), "{} has no receiver", i.name);
        assert!(
            i.signature.contains(&format!("{}(", i.name)),
            "{}: signature {:?} does not name the function",
            i.name,
            i.signature
        );
        assert!(
            !i.signature.contains("(U"),
            "{}: note belongs in doc",
            i.name
        );
        assert!(i.doc.ends_with('.'), "{}: doc is a sentence", i.name);
        if let Some(max) = i.max_args {
            assert!(i.min_args <= max, "{}", i.name);
        }
    }
    let by = |n: &str, r: &str| {
        infos
            .iter()
            .find(|i| i.name == n && i.receivers.contains(&r))
            .unwrap_or_else(|| panic!("{n} on {r}"))
    };
    assert_eq!(by("date", "global").returns, "date");
    assert_eq!(by("if", "global").returns, "any");
    assert_eq!(
        by("slice", "string").signature,
        "string.slice(start, end?): string"
    );
    assert_eq!(by("max", "global").max_args, None);
    assert_eq!(by("isEmpty", "list").kind, "method");
    assert_eq!(by("sum", "list").signature, "list.sum(): number");
}

// ---------------------------------------------------------------------------
// files, links, tags, this (U11, U14, U15, U18)
// ---------------------------------------------------------------------------

#[test]
fn file_fields_and_methods() {
    let e = Env::new();
    for (src, want) in [
        ("file.name", "Plan.md"),
        ("file.basename", "Plan"),
        ("file.path", "Projects/Plan.md"),
        ("file.folder", "Projects"),
        ("file.ext", "md"),
        ("file.size", "100"),
        ("file.ctime", "2024-01-01T09:00:00"),
        ("file.mtime", "2024-02-01T09:00:00"),
        ("file.tags", "project"),
        ("file.links.length", "2"),
        ("file.backlinks.length", "3"),
        ("file.properties.score", "8.5"),
        ("file.file.name", "Plan.md"),
        ("file.hasTag(\"project\")", "true"),
        ("file.hasTag(\"PROJECT\")", "true"),
        ("file.hasTag(\"#project\")", "true"),
        ("file.hasTag(\"nope\", \"project\")", "true"),
        ("file.hasTag(\"nope\")", "false"),
        ("file.inFolder(\"Projects\")", "true"),
        ("file.inFolder(\"Projects/\")", "true"),
        ("file.inFolder(\"Proj\")", "false"),
        ("file.inFolder(\"\")", "true"),
        ("file.hasLink(\"Alice\")", "true"),
        ("file.hasLink(\"People/Alice\")", "true"),
        ("file.hasLink(\"Bob\")", "false"),
        ("file.hasLink(file(\"Archive/Plan\"))", "true"),
        ("file.hasProperty(\"score\")", "true"),
        ("file.hasProperty(\"zzz\")", "false"),
        ("file.asLink()", "Projects/Plan.md"),
        ("file.asLink(\"Plan\")", "Plan"),
        ("link(file.path, \"Shown\")", "Shown"),
        ("file(\"Nope\")", ""),
        ("file(\"[[Alice]]\")", "People/Alice.md"),
    ] {
        assert_eq!(e.disp(src), want, "{src}");
    }
    assert!(is_err(&e.ev("file.nosuch"), ErrorKind::UnknownField));
    // nested tags: Task 01 is tagged project/alpha, so "project" matches too
    assert_eq!(
        e.at("Projects/Task 01.md", None, "file.hasTag(\"project\")"),
        Value::Bool(true)
    );
    assert_eq!(
        e.at(
            "Projects/Task 01.md",
            None,
            "file.hasTag(\"project/alpha\")"
        ),
        Value::Bool(true)
    );
    assert_eq!(
        e.at("Projects/Task 01.md", None, "file.hasTag(\"proj\")"),
        Value::Bool(false)
    );
}

#[test]
fn linked_note_lookups() {
    let e = Env::new();
    let t1 = "Projects/Task 01.md";
    for (src, want) in [
        ("owner.asFile().properties.role", "lead"),
        ("owner.asFile().name", "Alice.md"),
        ("owner.asFile().hasTag(\"person\")", "true"),
        ("owner.linksTo(file(\"People/Alice\"))", "true"),
        ("owner.linksTo(file(\"People/Bob\"))", "false"),
        ("owner == file(\"People/Alice\")", "true"),
        ("owner == link(\"Alice\")", "true"),
        ("owner == link(\"People/Alice\")", "true"),
        ("owner == link(\"Bob\")", "false"),
        ("owner.toString()", "Alice"),
        ("link(\"Missing Note\").asFile()", ""),
        ("owner.isType(\"link\")", "true"),
        ("owner.asFile().properties.keys()", "role, aliases, born"),
    ] {
        assert_eq!(e.at(t1, None, src).display(), want, "{src}");
    }
    // `author == this`, `authors.contains(this)`
    assert_eq!(
        e.at(t1, Some("People/Alice.md"), "owner == this"),
        Value::Bool(true)
    );
    assert_eq!(
        e.at(t1, Some("People/Bob.md"), "owner == this"),
        Value::Bool(false)
    );
    assert_eq!(
        e.at(t1, Some("People/Alice.md"), "[owner].contains(this)"),
        Value::Bool(true)
    );
    // a list of wikilinks in a property
    let mut env = Env::new();
    let mut notes = env.store.notes.clone();
    notes.push(Note::new("Projects/Multi.md").p(
        "related",
        list(vec![s("[[Alice]]"), s("[[Bob|the dev]]"), s("plain text")]),
    ));
    env.store = Store::new(notes);
    let m = "Projects/Multi.md";
    assert_eq!(
        env.at(m, None, "related[1].toString()").display(),
        "the dev"
    );
    assert_eq!(
        env.at(m, None, "related[1].asFile().name").display(),
        "Bob.md"
    );
    assert_eq!(
        env.at(m, None, "related[2].isType(\"string\")"),
        Value::Bool(true)
    );
    assert_eq!(
        env.at(m, None, "related.map(value.isType(\"link\"))")
            .display(),
        "true, true, false"
    );
}

#[test]
fn duplicate_basenames_resolve_deterministically() {
    // Two notes called Plan.md: the in-memory resolver (stand-in for the index,
    // U18) picks the first path in sorted order.
    let e = Env::new();
    assert_eq!(e.disp("link(\"Plan\").asFile().path"), "Archive/Plan.md");
    assert_eq!(
        e.disp("link(\"Projects/Plan\").asFile().path"),
        "Projects/Plan.md"
    );
    assert_eq!(e.disp("file(\"Plan\").folder"), "Archive");
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

const FULL_BASE: &str = r#"
name: Work overview
filters:
  and:
    - file.inFolder("Projects")
    - file.ext == "md"
    - or:
        - status == "active"
        - status == "planned"
    - not:
        - file.hasTag("archive")
formulas:
  days_left: 'if(due, (due - today()).days, "")'
  label: '"[" + status + "]"'
properties:
  status:
    displayName: Status
  formula.days_left:
    displayName: Days left
  file.name:
    displayName: Name
  creation date:
    displayName: Created
summaries:
  avgScore: values.mean().round(3)
views:
  - type: table
    name: Active tasks
    filters:
      and:
        - priority >= 1
    groupBy:
      property: status
      direction: DESC
    sort:
      - property: due
        direction: ASC
      - property: file.name
        direction: DESC
    order:
      - file.name
      - status
      - due
      - formula.days_left
      - creation date
    limit: 10
    columnSize:
      file.name: 420
      status: 120
    summaries:
      file.name: Count
      priority: Sum
    rowHeight: medium
    custom:
      nested:
        zeta: 1
        alpha: [a, b]
  - type: cards
    name: Gallery
    cardSize: 220
    imageProperty: cover
  - type: kanban
    name: Board
    groupBy:
      property: status
"#;

#[test]
fn document_parses_every_documented_key() {
    let doc = Document::parse(FULL_BASE).unwrap();
    assert!(doc.warnings.is_empty(), "{:?}", doc.warnings);
    assert_eq!(doc.name.as_deref(), Some("Work overview"));
    assert_eq!(doc.formulas.len(), 2);
    assert_eq!(doc.formulas[0].0, "days_left");
    assert_eq!(doc.properties.len(), 4);
    assert_eq!(doc.summaries[0].0, "avgScore");
    assert_eq!(doc.views.len(), 3);
    let v = &doc.views[0];
    assert_eq!(v.view_type, "table");
    assert_eq!(v.name, "Active tasks");
    assert_eq!(v.limit, Some(10));
    assert_eq!(v.group_by.as_ref().unwrap().direction, Direction::Desc);
    assert_eq!(v.sort.len(), 2);
    assert_eq!(v.sort[1].direction, Direction::Desc);
    assert_eq!(v.order.as_ref().unwrap().len(), 5);
    assert_eq!(v.summaries.len(), 2);
    assert_eq!(v.column_size.len(), 2);
    assert!(v.extra.iter().any(|(k, _)| k == "rowHeight"));
    assert!(v.extra.iter().any(|(k, _)| k == "custom"));
    assert_eq!(doc.views[1].view_type, "cards");
    assert!(doc.views[1].extra.iter().any(|(k, _)| k == "cardSize"));
    assert_eq!(doc.views[2].view_type, "kanban");
    match doc.filters.as_ref().unwrap() {
        Filter::And(items) => {
            assert_eq!(items.len(), 4);
            assert!(matches!(items[2], Filter::Or(_)));
            assert!(matches!(items[3], Filter::Not(_)));
        }
        other => panic!("{other:?}"),
    }
    assert!(doc.view(Some("gallery")).is_some());
    assert!(doc.view(Some("nope")).is_none());
    assert_eq!(doc.view(None).unwrap().name, "Active tasks");
}

#[test]
fn document_round_trips_with_unknown_keys_and_order() {
    let doc = Document::parse(FULL_BASE).unwrap();
    let yaml = doc.to_yaml();
    let again = Document::parse(&yaml).unwrap();
    assert_eq!(doc, again, "{yaml}");
    // key order of the original is kept, including nested unknown mappings
    let name_at = yaml.find("name: Work overview").unwrap();
    let filters_at = yaml.find("filters:").unwrap();
    let views_at = yaml.find("views:").unwrap();
    assert!(name_at < filters_at && filters_at < views_at);
    let zeta = yaml.find("zeta").unwrap();
    let alpha = yaml.find("alpha").unwrap();
    assert!(zeta < alpha, "nested unknown keys keep their order");
    // a second emit is byte-stable
    assert_eq!(again.to_yaml(), yaml);
}

#[test]
fn document_is_lenient_but_explicit() {
    // empty and comment-only files are valid, empty documents
    assert_eq!(Document::parse("").unwrap().views.len(), 0);
    assert_eq!(Document::parse("# nothing\n").unwrap().views.len(), 0);
    assert_eq!(
        Document::parse("views:\n  - type: table\n    name: Table\n")
            .unwrap()
            .views
            .len(),
        1
    );
    // YAML syntax error carries a position
    match Document::parse("views: [unclosed\n  - x") {
        Err(DocumentError::Yaml { line, .. }) => assert!(line >= 1),
        other => panic!("{other:?}"),
    }
    // wrong top-level shape
    assert!(matches!(
        Document::parse("- a\n- b\n"),
        Err(DocumentError::Shape { .. })
    ));
    assert!(
        matches!(Document::parse("views: 3\n"), Err(DocumentError::Shape { path, .. }) if path == "views")
    );
    // malformed filters are errors (never silently dropped)
    let e = Document::parse("filters:\n  maybe:\n    - a\n").unwrap_err();
    assert!(e.to_string().contains("filters"), "{e}");
    assert!(Document::parse("views:\n  - type: table\n    filters:\n      and: 5\n").is_err());
    assert!(Document::parse(
        "views:\n  - type: table\n    filters:\n      and: [a]\n      or: [b]\n"
    )
    .is_err());
    // other oddities become warnings and the original value survives
    let doc = Document::parse(
        "views:\n  - type: table\n    name: T\n    limit: lots\n    order: nope\n    sort:\n      - property: x\n        direction: sideways\n  - name: no type\n",
    )
    .unwrap();
    assert!(doc.warnings.len() >= 3, "{:?}", doc.warnings);
    assert_eq!(doc.views[0].limit, None);
    assert!(doc.views[0].extra.iter().any(|(k, _)| k == "limit"));
    assert_eq!(doc.views[0].sort[0].direction, Direction::Asc);
    assert_eq!(doc.views[1].view_type, "table");
    // filters as a bare string, a single string in a group, and a group of one
    let doc = Document::parse(
        "filters: 'file.ext == \"md\"'\nviews:\n  - type: table\n    name: A\n    filters:\n      and: status == 1\n",
    )
    .unwrap();
    assert_eq!(doc.filters, Some(Filter::Expr("file.ext == \"md\"".into())));
    assert_eq!(
        doc.views[0].filters,
        Some(Filter::And(vec![Filter::Expr("status == 1".into())]))
    );
    // multiple YAML documents: first wins, with a warning
    let doc = Document::parse("name: a\n---\nname: b\n").unwrap();
    assert_eq!(doc.name.as_deref(), Some("a"));
    assert_eq!(doc.warnings.len(), 1);
    // aliases are not supported, reported
    let doc = Document::parse("x: &a 1\ny: *a\nviews: []\n").unwrap();
    assert!(!doc.extra.is_empty());
}

#[test]
fn document_property_names_with_spaces_and_sort_forms() {
    let doc = Document::parse(
        "views:\n  - type: table\n    name: T\n    order:\n      - creation date\n      - note.status\n    sort:\n      - due\n      - property: creation date\n        direction: desc\n    groupBy: status\n",
    )
    .unwrap();
    let v = &doc.views[0];
    assert_eq!(v.order.as_ref().unwrap()[0], "creation date");
    assert_eq!(v.sort[0].property, "due");
    assert_eq!(v.sort[1].direction, Direction::Desc);
    assert_eq!(v.group_by.as_ref().unwrap().property, "status");
    let ser = serde_json::to_value(&doc).unwrap();
    assert_eq!(ser["views"][0]["groupBy"]["direction"], "ASC");
}

// ---------------------------------------------------------------------------
// queries (golden-style)
// ---------------------------------------------------------------------------

fn run(base: &str, view: Option<&str>) -> BaseQueryResult {
    run_with(base, view, None, false)
}

fn run_with(base: &str, view: Option<&str>, this: Option<&str>, narrow: bool) -> BaseQueryResult {
    let doc = Document::parse(base).expect("base parses");
    let store = sample_store();
    let mut src = MemSource::new(&store);
    src.this = this.map(str::to_string);
    src.narrow = narrow;
    run_view(&doc, view, &src, &clock(), &QueryOptions::default())
}

fn paths(r: &BaseQueryResult) -> Vec<&str> {
    r.rows.iter().map(|x| x.path.as_str()).collect()
}

fn col(r: &BaseQueryResult, key: &str) -> Vec<String> {
    let i = r.columns.iter().position(|c| c.key == key).expect("column");
    r.rows.iter().map(|x| x.cells[i].display.clone()).collect()
}

#[test]
fn query_filters_global_and_view_are_anded() {
    let r = run(
        r#"
filters:
  and:
    - file.inFolder("Projects")
    - file.ext == "md"
views:
  - type: table
    name: T
    filters:
      and:
        - status == "active"
        - priority >= 1
    order: [file.name, status, priority]
"#,
        None,
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    // active tasks (i % 5 in {0,3}) with priority i % 4 >= 1
    assert_eq!(
        paths(&r),
        [
            "Projects/Task 04.md",
            "Projects/Task 06.md",
            "Projects/Task 11.md"
        ]
    );
    assert_eq!(col(&r, "status"), vec!["active"; r.rows.len()]);
    assert!(col(&r, "priority").iter().all(|p| p != "0"));
    assert_eq!(r.total_matched, r.rows.len());
    // Plan.md has status active but no priority: excluded by `priority >= 1`
    assert!(!paths(&r).contains(&"Projects/Plan.md"));
}

#[test]
fn query_or_not_and_bare_property_filters() {
    let r = run(
        r#"
filters:
  and:
    - file.ext == "md"
    - not:
        - file.hasTag("person", "journal")
        - file.inFolder("Inbox")
    - or:
        - score > 5
        - file.name == "Home.md"
        - file.hasTag("work") && done
views:
  - type: table
    name: T
    order: [file.name]
"#,
        None,
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    let got = paths(&r);
    assert!(got.contains(&"Home.md"));
    assert!(got.contains(&"Projects/Plan.md"));
    assert!(!got.contains(&"Archive/Plan.md")); // score 4
                                                // done tasks: i % 3 == 0
    for i in [0, 3, 6, 9] {
        assert!(got.contains(&format!("Projects/Task {:02}.md", i + 1).as_str()));
    }
    assert!(!got.iter().any(|p| p.starts_with("People/")));
}

#[test]
fn query_sort_multi_key_null_ordering_and_stability() {
    let base = |dir: &str| {
        format!(
            r#"
filters: file.ext == "md"
views:
  - type: table
    name: T
    sort:
      - property: due
        direction: {dir}
    order: [file.name, due]
"#
        )
    };
    let asc = run(&base("ASC"), None);
    let names = col(&asc, "file.name");
    // nulls and missing first (source order), then dates, then strings
    let nulls_end = asc
        .rows
        .iter()
        .position(|r| matches!(r.cells[1].value, Value::Date(_)))
        .unwrap();
    assert!(asc.rows[..nulls_end]
        .iter()
        .all(|r| r.cells[1].value.is_null()));
    let null_paths: Vec<&str> = asc.rows[..nulls_end]
        .iter()
        .map(|r| r.path.as_str())
        .collect();
    assert!(
        null_paths.windows(2).all(|w| w[0] < w[1]),
        "ties keep source order: {null_paths:?}"
    );
    assert!(!names.is_empty());
    let dates: Vec<&str> = asc
        .rows
        .iter()
        .filter(|r| matches!(r.cells[1].value, Value::Date(_)))
        .map(|r| r.cells[1].display.as_str())
        .collect();
    let mut sorted = dates.clone();
    sorted.sort();
    assert_eq!(dates, sorted);
    let tail: Vec<&str> = asc
        .rows
        .iter()
        .rev()
        .take(2)
        .map(|r| r.cells[1].display.as_str())
        .collect();
    assert_eq!(tail, ["someday", ""]); // strings last: "" < "someday"
                                       // DESC is the exact reverse of the key order
    let desc = run(&base("DESC"), None);
    let keys = |r: &BaseQueryResult| -> Vec<String> {
        r.rows.iter().map(|x| x.cells[1].display.clone()).collect()
    };
    let mut rev = keys(&asc);
    rev.reverse();
    assert_eq!(keys(&desc), rev);
    // two keys: priority DESC, then name ASC (stable on ties)
    let r = run(
        r#"
filters: file.inFolder("Projects") && file.name.startsWith("Task")
views:
  - type: table
    name: T
    sort:
      - property: priority
        direction: DESC
      - property: file.name
    order: [file.name, priority]
"#,
        None,
    );
    let pri = col(&r, "priority");
    assert!(pri.windows(2).all(|w| w[0] >= w[1]), "{pri:?}");
    for pair in r.rows.windows(2) {
        if pair[0].cells[1].display == pair[1].cells[1].display {
            assert!(pair[0].cells[0].display < pair[1].cells[0].display);
        }
    }
}

#[test]
fn query_group_by_orders_groups_and_applies_limit() {
    let base = r#"
filters: file.inFolder("Projects") && file.name.startsWith("Task")
views:
  - type: table
    name: T
    groupBy:
      property: status
      direction: DESC
    sort:
      - property: file.name
    order: [file.name, status]
    limit: LIMIT
    summaries:
      file.name: Count
"#;
    let r = run(&base.replace("LIMIT", "100"), None);
    let groups = r.groups.as_ref().unwrap();
    let keys: Vec<&str> = groups.iter().map(|g| g.key.display.as_str()).collect();
    assert_eq!(keys, ["planned", "done", "active"]);
    assert_eq!(groups.iter().map(|g| g.len).sum::<usize>(), r.rows.len());
    for g in groups {
        let rows = &r.rows[g.start..g.start + g.len];
        assert!(rows.iter().all(|x| x.cells[1].display == g.key.display));
        assert!(
            rows.windows(2).all(|w| w[0].path <= w[1].path),
            "sort kept in group"
        );
        assert_eq!(g.summaries[0].as_ref().unwrap().display, g.len.to_string());
    }
    assert_eq!(
        r.summaries[0].as_ref().unwrap().display,
        r.rows.len().to_string()
    );
    // limit cuts across groups and drops emptied ones
    let r = run(&base.replace("LIMIT", "5"), None);
    assert_eq!(r.rows.len(), 5);
    assert_eq!(r.total_matched, 12);
    let groups = r.groups.as_ref().unwrap();
    assert_eq!(groups.iter().map(|g| g.len).sum::<usize>(), 5);
    assert!(groups.iter().all(|g| g.len > 0));
    // ASC
    let r = run(&base.replace("LIMIT", "100").replace("DESC", "ASC"), None);
    let keys: Vec<&str> = r
        .groups
        .as_ref()
        .unwrap()
        .iter()
        .map(|g| g.key.display.as_str())
        .collect();
    assert_eq!(keys, ["active", "done", "planned"]);
}

#[test]
fn query_group_order_manual_list_value_and_null_group() {
    let r = run(
        r#"
filters: file.inFolder("Projects") && file.name.startsWith("Task")
views:
  - type: table
    name: T
    groupBy:
      property: status
    groupOrder: [planned, done]
    order: [file.name]
"#,
        None,
    );
    let keys: Vec<&str> = r
        .groups
        .as_ref()
        .unwrap()
        .iter()
        .map(|g| g.key.display.as_str())
        .collect();
    assert_eq!(keys, ["planned", "done", "active"]);
    // list-valued property: the whole list is the key
    let r = run(
        r#"
filters: file.inFolder("Projects") && file.name.startsWith("Task")
views:
  - type: table
    name: T
    groupBy: tags
    order: [file.name]
"#,
        None,
    );
    let keys: Vec<String> = r
        .groups
        .as_ref()
        .unwrap()
        .iter()
        .map(|g| g.key.display.clone())
        .collect();
    assert_eq!(keys, ["work, even", "work, odd"]);
    // missing values group together as null, lowest
    let r = run(
        r#"
filters: file.ext == "md"
views:
  - type: table
    name: T
    groupBy: status
    order: [file.name]
"#,
        None,
    );
    let g = r.groups.as_ref().unwrap();
    assert!(g[0].key.value.is_null());
    assert!(g[0].len > 5);
}

#[test]
fn query_formulas_errors_are_per_cell_and_display_names() {
    let r = run(
        r#"
filters: file.inFolder("Projects") && file.name.startsWith("Task")
formulas:
  days_left: 'if(due, (due - today()).days, "")'
  broken: 'len(status)'
  syntax: '1 +'
properties:
  formula.days_left:
    displayName: Days left
  status:
    displayName: State
views:
  - type: table
    name: T
    order: [file.name, status, formula.days_left, formula.broken, formula.syntax, formula.missing]
    sort:
      - property: file.name
"#,
        None,
    );
    assert!(r.error.is_none());
    let names: Vec<&str> = r.columns.iter().map(|c| c.display_name.as_str()).collect();
    assert_eq!(
        names,
        [
            "file.name",
            "State",
            "Days left",
            "formula.broken",
            "formula.syntax",
            "formula.missing"
        ]
    );
    // Task 01: due 2024-03-10 -> -5 days
    assert_eq!(r.rows[0].cells[2].display, "-5");
    // Task 04: due is the string "someday": a per-cell type error
    let t4 = r
        .rows
        .iter()
        .find(|x| x.path.ends_with("Task 04.md"))
        .unwrap();
    assert!(is_err(&t4.cells[2].value, ErrorKind::Type));
    // Task 08: due null -> if() falls to ""
    let t8 = r
        .rows
        .iter()
        .find(|x| x.path.ends_with("Task 08.md"))
        .unwrap();
    assert_eq!(t8.cells[2].display, "");
    for row in &r.rows {
        assert!(is_err(&row.cells[3].value, ErrorKind::UnknownFunction));
        assert!(is_err(&row.cells[4].value, ErrorKind::Syntax));
        assert!(is_err(&row.cells[5].value, ErrorKind::UnknownFormula));
    }
}

#[test]
fn query_filter_error_is_an_explicit_view_error() {
    let base = |filter: &str| {
        format!("views:\n  - type: table\n    name: T\n    filters:\n      and:\n        - '{filter}'\n    order: [file.name]\n")
    };
    // runtime error in a filter (the real vaults' len(x)): explicit error state
    let r = run(&base("len(status) > 0"), None);
    let err = r.error.as_ref().unwrap();
    assert_eq!(err.kind, QueryErrorKind::FilterEval);
    assert_eq!(err.expression.as_deref(), Some("len(status) > 0"));
    assert!(err.path.is_some());
    assert!(r.rows.is_empty() && r.groups.is_none());
    assert_eq!(r.columns.len(), 1, "header is still available");
    // syntax error
    let r = run(&base("status =="), None);
    let err = r.error.as_ref().unwrap();
    assert_eq!(err.kind, QueryErrorKind::FilterSyntax);
    assert!(err.message.contains("line 1"));
    // lenient policy: failing rows are dropped instead
    let doc = Document::parse(&base("len(status) > 0")).unwrap();
    let store = sample_store();
    let src = MemSource::new(&store);
    let lenient = QueryOptions {
        filter_errors: FilterErrorPolicy::RowFails,
    };
    let r = run_view(&doc, None, &src, &clock(), &lenient);
    assert!(r.error.is_none() && r.rows.is_empty());
    // type error from mixed property types surfaces too (due is text on one row)
    let r = run(&base("(due - today()).days < 100"), None);
    assert_eq!(r.error.as_ref().unwrap().kind, QueryErrorKind::FilterEval);
}

#[test]
fn query_missing_view_and_implicit_view() {
    let r = run("views:\n  - type: table\n    name: A\n", Some("B"));
    assert_eq!(r.error.as_ref().unwrap().kind, QueryErrorKind::ViewNotFound);
    // no views at all: an implicit table of every file, name column
    let r = run("", None);
    assert!(r.error.is_none());
    assert_eq!(r.view.index, None);
    assert_eq!(r.columns.len(), 1);
    assert_eq!(
        r.rows.len(),
        sample_store().notes.len(),
        "no filter shows all files, attachments too"
    );
    assert!(paths(&r).contains(&"attachments/photo.png"));
    // empty order list: no columns
    let r = run(
        "views:\n  - type: table\n    name: A\n    order: []\n",
        None,
    );
    assert!(r.columns.is_empty());
    assert!(r.rows.iter().all(|x| x.cells.is_empty()));
    // opaque view types still run
    let r = run(
        "views:\n  - type: kanban\n    name: K\n    order: [file.name]\n",
        Some("k"),
    );
    assert!(r.error.is_none());
    assert_eq!(r.view.view_type, "kanban");
}

#[test]
fn query_summaries_builtin_and_custom() {
    let r = run(
        r#"
filters: file.ext == "md"
summaries:
  avgScore: values.mean().round(3)
  scoreSpread: values.max() - values.min()
  broken: values.nosuch()
  syn: '1 +'
views:
  - type: table
    name: T
    order: [file.name, score, born, done, due, status, tags, mood, stamp, weekly]
    summaries:
      file.name: Count
      score: avgScore
      born: Range
      done: Checked
      due: Latest
      status: Unique
      tags: Empty
      mood: Sum
      stamp: Earliest
      weekly: Unchecked
      file.nosummary: Whatever
"#,
        None,
    );
    let sum = |key: &str| -> String {
        let i = r.columns.iter().position(|c| c.key == key).unwrap();
        r.summaries[i].as_ref().unwrap().display.clone()
    };
    assert_eq!(sum("file.name"), r.rows.len().to_string());
    assert_eq!(sum("score"), "6.25"); // (8.5 + 4) / 2
    assert_eq!(sum("born"), "730d"); // 1993-05-20 .. 1995-05-20
    assert_eq!(sum("done"), "4");
    assert_eq!(sum("due"), "2024-03-20");
    assert_eq!(sum("status"), "3"); // active, done, planned
    assert_eq!(sum("mood"), "20");
    assert_eq!(sum("stamp"), "2024-03-01T07:00:00");
    assert_eq!(sum("weekly"), "4");
    // tags: empty list on one note, missing on many
    let empty: usize = sum("tags").parse().unwrap();
    assert!(empty > 10);
    // columns without a configured summary have none
    let i = r.columns.iter().position(|c| c.key == "file.name").unwrap();
    assert_eq!(r.columns[i].summary.as_deref(), Some("Count"));
}

#[test]
fn builtin_summary_semantics() {
    use super::query::summarize_builtin as sb;
    let v = |xs: &[f64]| xs.iter().map(|x| n(*x)).collect::<Vec<_>>();
    assert_eq!(sb("Sum", &v(&[1.0, 2.0, 3.5])).unwrap().display(), "6.5");
    assert_eq!(sb("Average", &v(&[1.0, 2.0])).unwrap().display(), "1.5");
    assert_eq!(sb("Min", &v(&[3.0, 1.0])).unwrap().display(), "1");
    assert_eq!(sb("Max", &v(&[3.0, 1.0])).unwrap().display(), "3");
    assert_eq!(sb("Median", &v(&[1.0, 5.0, 3.0])).unwrap().display(), "3");
    assert_eq!(
        sb("Median", &v(&[1.0, 2.0, 3.0, 4.0])).unwrap().display(),
        "2.5"
    );
    assert_eq!(
        sb("Stddev", &v(&[2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0]))
            .unwrap()
            .display(),
        "2"
    );
    assert_eq!(sb("Range", &v(&[1.0, 9.0])).unwrap().display(), "8");
    // non-numbers are ignored; nothing numeric: Sum is 0, the rest null
    let mixed = vec![n(2.0), s("x"), Value::Null, n(4.0)];
    assert_eq!(sb("Sum", &mixed).unwrap().display(), "6");
    assert_eq!(sb("Count", &mixed).unwrap().display(), "4");
    assert_eq!(sb("Empty", &mixed).unwrap().display(), "1");
    assert_eq!(sb("Filled", &mixed).unwrap().display(), "3");
    assert!(sb("Average", &[s("x")]).unwrap().is_null());
    assert_eq!(sb("Sum", &[]).unwrap().display(), "0");
    assert_eq!(
        sb("Unique", &[s("a"), s("a"), s("b"), Value::Null, s("")])
            .unwrap()
            .display(),
        "2"
    );
    assert_eq!(
        sb(
            "Checked",
            &[Value::Bool(true), Value::Bool(false), Value::Null]
        )
        .unwrap()
        .display(),
        "1"
    );
    assert_eq!(
        sb(
            "Unchecked",
            &[Value::Bool(true), Value::Bool(false), Value::Null]
        )
        .unwrap()
        .display(),
        "1"
    );
    let ds = vec![date("2024-01-05"), date("2024-03-01"), Value::Null];
    assert_eq!(sb("Earliest", &ds).unwrap().display(), "2024-01-05");
    assert_eq!(sb("Latest", &ds).unwrap().display(), "2024-03-01");
    assert_eq!(sb("Range", &ds).unwrap().display(), "56d");
    // names are matched case-insensitively; unknown names are not built-ins
    assert!(sb("sum", &mixed).is_some());
    assert!(sb("Bogus", &mixed).is_none());
}

#[test]
fn query_this_and_backlinks() {
    // a base embedded in Projects/Plan.md: notes that link to `this`
    let base = r#"
filters:
  and:
    - file.hasLink(this)
views:
  - type: table
    name: T
    order: [file.name]
"#;
    let r = run_with(base, None, Some("Projects/Plan.md"), false);
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(
        paths(&r),
        [
            "Projects/Task 01.md",
            "Projects/Task 02.md",
            "Projects/Task 03.md"
        ]
    );
    // backlinks of the current row
    let r = run(
        r#"
filters: file.backlinks.length > 2
views:
  - type: table
    name: T
    order: [file.name, file.backlinks]
"#,
        None,
    );
    assert!(r.error.is_none());
    assert!(paths(&r).contains(&"Projects/Plan.md"));
    assert!(paths(&r).contains(&"People/Alice.md"));
    // owner == this
    let r = run_with(
        r#"
filters: owner == this
views:
  - type: table
    name: T
    order: [file.name]
"#,
        None,
        Some("People/Bob.md"),
        false,
    );
    assert_eq!(
        col(&r, "file.name"),
        ["Task 02.md", "Task 05.md", "Task 08.md", "Task 11.md"]
    );
}

#[test]
fn pushdown_hint_extraction_and_superset_property() {
    let doc = Document::parse(
        r#"
filters:
  and:
    - file.inFolder("Projects/")
    - file.ext == "md"
    - file.hasTag("work", "play")
    - status == "active"
    - 3 <= priority
    - or:
        - file.inFolder("Archive")
        - done
    - not:
        - file.inFolder("Inbox")
    - size > formula.x
views:
  - type: table
    name: T
    filters: due != null
"#,
    )
    .unwrap();
    let store = sample_store();
    let src = MemSource::new(&store);
    let _ = run_view(&doc, None, &src, &clock(), &QueryOptions::default());
    let h = src.last_hint.borrow().clone().unwrap();
    assert_eq!(h.folders, ["Projects"]);
    assert_eq!(h.ext.as_deref(), Some("md"));
    assert_eq!(
        h.tags_any,
        vec![vec!["work".to_string(), "play".to_string()]]
    );
    let props: Vec<(&str, super::query::CompareOp)> = h
        .comparisons
        .iter()
        .map(|c| (c.property.as_str(), c.op))
        .collect();
    use super::query::CompareOp::*;
    assert_eq!(props, [("status", Eq), ("priority", Ge), ("due", Ne)]);
    // narrowing in the source never changes the result (superset + verification)
    for filter in [
        "file.inFolder(\"Projects\")",
        "file.ext == \"md\" && !file.inFolder(\"Projects\")",
        "file.inFolder(\"Projects\") && file.ext == \"md\" && status == \"done\"",
        "file.inFolder(\"People\") || file.inFolder(\"Journal\")",
        "file.ext == \"png\"",
        "file.inFolder(\"Nope\")",
    ] {
        let base = format!(
            "filters: '{}'\nviews:\n  - type: table\n    name: T\n    order: [file.name]\n",
            filter.replace('\'', "''")
        );
        let wide = run_with(&base, None, None, false);
        let narrow = run_with(&base, None, None, true);
        assert!(wide.error.is_none(), "{filter}");
        assert_eq!(paths(&wide), paths(&narrow), "{filter}");
    }
}

#[test]
fn result_serializes_to_plain_json() {
    let r = run(
        r#"
filters: file.inFolder("Journal")
formulas:
  bad: 'nosuch()'
views:
  - type: table
    name: J
    groupBy: weekly
    order: [file.name, stamp, mood, formula.bad]
    summaries:
      mood: Sum
"#,
        None,
    );
    let j = serde_json::to_value(&r).unwrap();
    assert_eq!(j["view"]["name"], "J");
    assert_eq!(j["view"]["type"], "table");
    assert_eq!(j["columns"][1]["displayName"], "stamp");
    assert_eq!(j["rows"][0]["cells"][1]["type"], "date");
    assert_eq!(j["rows"][0]["cells"][1]["hasTime"], true);
    assert_eq!(j["rows"][0]["cells"][2]["value"], 0.0);
    assert_eq!(j["rows"][0]["cells"][2]["display"], "0");
    assert_eq!(j["rows"][0]["cells"][3]["type"], "error");
    assert_eq!(j["rows"][0]["cells"][3]["value"]["kind"], "unknownFunction");
    assert_eq!(j["summaries"][2]["display"], "20");
    assert_eq!(j["groups"][0]["key"]["type"], "boolean");
    assert_eq!(j["totalMatched"], 5);
    assert!(j["error"].is_null());
    // document serializes too
    let doc = Document::parse(FULL_BASE).unwrap();
    let dj = serde_json::to_value(&doc).unwrap();
    assert_eq!(dj["views"][0]["groupBy"]["property"], "status");
    assert_eq!(dj["views"][0]["type"], "table");
    assert_eq!(
        dj["properties"]["formula.days_left"]["displayName"],
        "Days left"
    );
}

// ---------------------------------------------------------------------------
// randomized properties (hand-rolled: no extra dev-dependency)
// ---------------------------------------------------------------------------

fn random_source(rng: &mut Rng, max_len: usize) -> String {
    const ATOMS: &[&str] = &[
        "(",
        ")",
        "[",
        "]",
        ",",
        ".",
        "+",
        "-",
        "*",
        "/",
        "%",
        "!",
        "==",
        "!=",
        "<",
        ">",
        "<=",
        ">=",
        "&&",
        "||",
        "\"",
        "'",
        "\\",
        " ",
        "\n",
        "a",
        "b1",
        "_x",
        "file",
        "note",
        "formula",
        "this",
        "true",
        "false",
        "null",
        "0",
        "12",
        "3.5",
        "1.",
        ".5",
        "é",
        "日",
        "😀",
        "/ab/i",
        "/",
        "=",
        "&",
        "|",
        "$",
        "#",
        "@",
        "{",
        "}",
        ";",
        "?",
        ":",
        "\\u",
        "\\u{110000}",
        "value",
        "index",
        "acc",
        "if(",
        "date(",
        ".format(",
        "\"abc\"",
        "'x'",
    ];
    let len = rng.below(max_len as u64) as usize;
    let mut s = String::new();
    for _ in 0..len {
        if rng.below(10) == 0 {
            s.push(char::from_u32(rng.below(0x3000) as u32).unwrap_or('?'));
        } else {
            s.push_str(rng.pick(ATOMS));
        }
    }
    s
}

#[test]
fn property_parser_never_panics_on_arbitrary_input() {
    let mut rng = Rng(0xDEADBEEF);
    let e = Env::new();
    for _ in 0..20_000 {
        let src = random_source(&mut rng, 24);
        // tokenizer + parser: any outcome is fine, panicking is not
        match parser::parse(&src) {
            Ok(ast) => {
                // and whatever parses must also evaluate without panicking
                let ctx = Mem::rc(&e.store, "Projects/Plan.md");
                let _ = Interp::new(&e.clock, &e.formulas, ctx, None).eval(&ast, &Scope::root());
            }
            Err(err) => {
                assert!(err.pos <= src.len(), "{src:?} -> {err:?}");
                let _ = err.line_col(&src);
            }
        }
    }
    // pathological shapes
    for src in [
        "(".repeat(100_000),
        ")".repeat(100_000),
        "[".repeat(100_000),
        "-".repeat(100_000),
        "!".repeat(100_000) + "x",
        "1+".repeat(100_000) + "1",
        "a".to_string() + &".b".repeat(100_000),
        "a".to_string() + &"[0]".repeat(100_000),
        "f(".repeat(50_000),
        "\"".repeat(100_001),
        "/".repeat(100_001),
        "\u{0}\u{1}\u{2}".repeat(1000),
    ] {
        assert!(
            parser::parse(&src).is_err(),
            "{}",
            &src[..src.len().min(20)]
        );
    }
}

fn random_ast(rng: &mut Rng, depth: u32) -> Expr {
    const IDENTS: &[&str] = &[
        "a", "b", "status", "file", "note", "formula", "this", "value", "x_1",
    ];
    const OPS: &[BinaryOp] = &[
        BinaryOp::Add,
        BinaryOp::Sub,
        BinaryOp::Mul,
        BinaryOp::Div,
        BinaryOp::Mod,
        BinaryOp::Eq,
        BinaryOp::Ne,
        BinaryOp::Lt,
        BinaryOp::Gt,
        BinaryOp::Le,
        BinaryOp::Ge,
        BinaryOp::And,
        BinaryOp::Or,
    ];
    let leaf = depth == 0 || rng.below(4) == 0;
    if leaf {
        return match rng.below(7) {
            0 => Expr::Null,
            1 => Expr::Bool(rng.below(2) == 0),
            2 => Expr::Number(rng.below(1000) as f64 / *rng.pick(&[1.0, 2.0, 4.0, 10.0])),
            3 => {
                let chars = [
                    'a', 'Z', ' ', '"', '\\', '\n', '\t', 'é', '日', '\'', '/', '0',
                ];
                let n = rng.below(5);
                Expr::Str((0..n).map(|_| *rng.pick(&chars)).collect())
            }
            4 => Expr::Regex {
                source: rng
                    .pick(&["ab+", "^x$", "[a/b]", "\\d+", "a|b"])
                    .to_string(),
                flags: rng.pick(&["", "i", "gi"]).to_string(),
            },
            _ => Expr::Ident(rng.pick(IDENTS).to_string()),
        };
    }
    let d = depth - 1;
    match rng.below(7) {
        0 => Expr::List((0..rng.below(4)).map(|_| random_ast(rng, d)).collect()),
        1 => Expr::Member(Box::new(random_ast(rng, d)), rng.pick(IDENTS).to_string()),
        2 => Expr::Index(Box::new(random_ast(rng, d)), Box::new(random_ast(rng, d))),
        3 => Expr::Call(
            Box::new(if rng.below(2) == 0 {
                Expr::Ident(rng.pick(&["if", "date", "max", "nosuch"]).to_string())
            } else {
                Expr::Member(
                    Box::new(random_ast(rng, d)),
                    rng.pick(&["lower", "contains", "map", "format", "join"])
                        .to_string(),
                )
            }),
            (0..rng.below(3)).map(|_| random_ast(rng, d)).collect(),
        ),
        4 => Expr::Unary(
            if rng.below(2) == 0 {
                UnaryOp::Not
            } else {
                UnaryOp::Neg
            },
            Box::new(random_ast(rng, d)),
        ),
        _ => Expr::Binary(
            *rng.pick(OPS),
            Box::new(random_ast(rng, d)),
            Box::new(random_ast(rng, d)),
        ),
    }
}

#[test]
fn property_print_then_parse_round_trips_and_eval_never_panics() {
    let mut rng = Rng(42);
    let e = Env::new();
    for _ in 0..5_000 {
        let ast = random_ast(&mut rng, 5);
        let src = ast.to_source();
        let back = parser::parse(&src).unwrap_or_else(|er| panic!("{src}: {er}"));
        assert_eq!(back, ast, "{src}");
        let ctx = Mem::rc(&e.store, "Projects/Task 01.md");
        let it = Interp::new(&e.clock, &e.formulas, ctx, None);
        let _ = it.eval(&ast, &Scope::root());
    }
}

fn random_value(rng: &mut Rng, depth: u32) -> Value {
    match rng.below(if depth == 0 { 6 } else { 8 }) {
        0 => Value::Null,
        1 => Value::Bool(rng.below(2) == 0),
        2 => Value::Number(rng.range(-50, 50) as f64 / *rng.pick(&[1.0, 2.0, 8.0])),
        3 => {
            let chars = ['a', 'B', 'c', ' ', 'é', '1'];
            Value::str(
                (0..rng.below(4))
                    .map(|_| *rng.pick(&chars))
                    .collect::<String>(),
            )
        }
        4 => Value::date(
            rng.range(-3_000_000_000_000, 4_000_000_000_000),
            rng.below(2) == 0,
        ),
        5 => Value::Duration(DurationValue {
            months: rng.range(-30, 30),
            millis: rng.range(-1_000_000_000, 1_000_000_000),
        }),
        6 => Value::List(
            (0..rng.below(5))
                .map(|_| random_value(rng, depth - 1))
                .collect(),
        ),
        _ => Value::Object(
            (0..rng.below(3))
                .map(|i| (format!("k{i}"), random_value(rng, depth - 1)))
                .collect(),
        ),
    }
}

fn eval_with_vars(e: &Env, src: &str, vars: Vec<(&'static str, Value)>) -> Value {
    let ast = parser::parse(src).expect("parses");
    let ctx = Mem::rc(&e.store, "Projects/Plan.md");
    let it = Interp::new(&e.clock, &e.formulas, ctx, None);
    let root = Scope::root();
    let sc = root.child(vars);
    it.eval(&ast, &sc)
}

#[test]
fn property_algebraic_laws() {
    let mut rng = Rng(7);
    let e = Env::new();
    for _ in 0..3_000 {
        let x = random_value(&mut rng, 3);
        // a == a, and the sort order agrees
        assert!(x.equals(&x), "{x:?}");
        assert_eq!(compare_for_sort(&x, &x), std::cmp::Ordering::Equal, "{x:?}");
        // !!x is truthiness
        assert_eq!(
            eval_with_vars(&e, "!!x", vec![("x", x.clone())]),
            Value::Bool(x.truthy()),
            "{x:?}"
        );
        assert_eq!(
            eval_with_vars(&e, "x.isTruthy()", vec![("x", x.clone())]),
            Value::Bool(x.truthy())
        );
        // x == x through the interpreter, and != is its negation
        assert_eq!(
            eval_with_vars(&e, "x == x", vec![("x", x.clone())]),
            Value::Bool(true)
        );
        assert_eq!(
            eval_with_vars(&e, "x != x", vec![("x", x.clone())]),
            Value::Bool(false)
        );
        // toString never fails
        assert!(matches!(
            eval_with_vars(&e, "x.toString()", vec![("x", x.clone())]),
            Value::String(_)
        ));
        // list laws
        let l = Value::List(
            (0..rng.below(8))
                .map(|_| random_value(&mut rng, 1))
                .collect(),
        );
        let rr = eval_with_vars(&e, "l.reverse().reverse()", vec![("l", l.clone())]);
        assert!(rr.equals(&l), "{l:?}");
        let u1 = eval_with_vars(&e, "l.unique()", vec![("l", l.clone())]);
        let u2 = eval_with_vars(&e, "l.unique().unique()", vec![("l", l.clone())]);
        assert!(u1.equals(&u2), "unique idempotent: {l:?}");
        if let Value::List(items) = &u1 {
            for (i, a) in items.iter().enumerate() {
                for b in &items[i + 1..] {
                    assert!(!a.equals(b), "unique left duplicates in {l:?}");
                }
            }
        }
        let s1 = eval_with_vars(&e, "l.sort()", vec![("l", l.clone())]);
        let s2 = eval_with_vars(&e, "l.sort().sort()", vec![("l", l.clone())]);
        assert!(s1.equals(&s2), "sort idempotent");
        if let Value::List(items) = &s1 {
            assert!(items
                .windows(2)
                .all(|w| compare_for_sort(&w[0], &w[1]).is_le()));
        }
        // slice stays inside the list and is contiguous
        let (a, b) = (rng.range(-10, 10), rng.range(-10, 10));
        let sl = eval_with_vars(
            &e,
            "l.slice(a, b)",
            vec![
                ("l", l.clone()),
                ("a", Value::num(a as f64)),
                ("b", Value::num(b as f64)),
            ],
        );
        if let (Value::List(sub), Value::List(all)) = (&sl, &l) {
            assert!(sub.len() <= all.len());
            if !sub.is_empty() {
                assert!(all
                    .windows(sub.len())
                    .any(|w| w.iter().zip(sub).all(|(p, q)| p.equals(q))));
            }
        } else {
            panic!("slice must return a list: {sl:?}");
        }
        // length matches
        assert_eq!(
            eval_with_vars(&e, "l.length", vec![("l", l.clone())]),
            Value::num(match &l {
                Value::List(v) => v.len() as f64,
                _ => 0.0,
            })
        );
    }
}

#[test]
fn property_date_arithmetic_invariants() {
    let mut rng = Rng(99);
    let e = Env::new();
    let units: &[(&str, i64)] = &[
        ("s", datetime::MS_PER_SECOND),
        ("m", datetime::MS_PER_MINUTE),
        ("h", datetime::MS_PER_HOUR),
        ("d", datetime::MS_PER_DAY),
        ("w", datetime::MS_PER_WEEK),
    ];
    for _ in 0..3_000 {
        let ms = rng.range(-2_000_000_000_000, 4_000_000_000_000);
        let has_time = rng.below(2) == 0;
        let dv = Value::date(ms, has_time);
        let (unit, size) = *rng.pick(units);
        let k = rng.range(-500, 500);
        let dur = format!("{k}{unit}");
        let vars = || vec![("d", dv.clone()), ("s", Value::str(dur.clone()))];
        // (d + "k u") - d is exactly k units
        let diff = eval_with_vars(&e, "(d + s) - d", vars());
        assert_eq!(
            diff,
            Value::Duration(DurationValue::from_millis(k * size)),
            "{dur} on {ms}"
        );
        // adding then subtracting returns the instant
        let back = eval_with_vars(&e, "(d + s) - s", vars());
        assert!(back.equals(&dv), "{dur} on {ms}: {back:?}");
        // the .days field of a one-day shift is 1
        if unit == "d" && k == 1 {
            assert_eq!(
                eval_with_vars(&e, "((d + s) - d).days", vars()),
                Value::num(1.0)
            );
        }
    }
    // the headline case
    assert_eq!(e.disp("((today() + \"1d\") - today()).days"), "1");
    assert_eq!(e.disp("((now() + \"1d\") - now()).hours"), "24");
    // calendar months never produce an impossible day
    for _ in 0..2_000 {
        let ms = rng.range(-2_000_000_000_000, 4_000_000_000_000);
        let moved = datetime::add_months(ms, rng.range(-40, 40)).unwrap();
        let c = datetime::civil_from_ms(moved);
        assert!(c.day >= 1 && c.day <= datetime::days_in_month(c.year, c.month));
        assert_eq!(
            moved.rem_euclid(datetime::MS_PER_DAY),
            ms.rem_euclid(datetime::MS_PER_DAY)
        );
    }
}

#[test]
fn extreme_dates_and_durations_are_errors_not_panics() {
    let e = Env::new();
    for src in [
        "today() + \"99999999999999999999y\"",
        "today() + \"9223372036854775807M\"",
        "today() - \"99999999999999999999d\"",
        "today() + duration(\"99999999999999999999w\") * 99999999",
        "date(\"9999-12-31\") + \"999999999999999999h\"",
        "(date(\"9999-12-31\") + \"1M\")",
        "duration(\"1y\") * 1e300",
        "-duration(\"99999999999999999999d\")",
        "(today() - today()).years",
    ] {
        let v = e.ev(src);
        // an error value or a (clamped) result, but never a panic
        let _ = v.display();
    }
    assert!(is_err(
        &e.ev("today() + \"99999999999999999999y\""),
        ErrorKind::Runtime
    ));
    for ms in [i64::MIN, i64::MAX, 0, -1] {
        let _ = datetime::civil_from_ms(ms);
        let _ = datetime::format_date(ms, "YYYY-MM-DD HH:mm:ss.SSS x X Z W", 840);
        let _ = datetime::relative(ms, i64::MAX);
        let _ = datetime::relative(i64::MIN, ms);
        let _ = datetime::iso_string(ms, true);
    }
}

#[test]
fn deep_evaluation_is_bounded() {
    // a lambda inside a lambda inside ... never overflows the stack
    let mut src = String::from("1");
    for _ in 0..60 {
        src = format!("[1].map({src})");
    }
    let e = Env::new();
    let _ = e.ev(&src);
    let long = format!("{}1", "1 + ".repeat(150));
    assert_eq!(e.disp(&long), "151");
}

#[test]
fn custom_summary_errors_are_cell_errors() {
    let r = run(
        r#"
summaries:
  broken: values.nosuch()
  syn: '1 +'
filters: file.inFolder("Journal")
views:
  - type: table
    name: T
    order: [file.name, mood, stamp]
    summaries:
      file.name: broken
      mood: syn
      stamp: neverDefined
"#,
        None,
    );
    let k = |i: usize| r.summaries[i].as_ref().unwrap().value.clone();
    assert!(is_err(&k(0), ErrorKind::UnknownMethod));
    assert!(is_err(&k(1), ErrorKind::Syntax));
    assert!(is_err(&k(2), ErrorKind::UnknownFormula));
}

#[test]
fn property_calendar_round_trips_and_formatting_is_total() {
    let mut rng = Rng(5);
    for _ in 0..5_000 {
        let ms = rng.range(-60_000_000_000_000, 120_000_000_000_000);
        let c = datetime::civil_from_ms(ms);
        assert_eq!(datetime::ms_from_civil(&c), ms);
        let iso = datetime::iso_string(ms, true);
        let (back, t) = datetime::parse_date(&iso, 0).unwrap_or_else(|| panic!("{iso}"));
        assert!(t);
        assert_eq!(back, ms, "{iso}");
        let fmt = random_source(&mut rng, 8);
        let _ = datetime::format_date(ms, &fmt, rng.range(-720, 840) as i32);
        let _ = datetime::relative(ms, rng.range(-60_000_000_000_000, 120_000_000_000_000));
        let _ = datetime::parse_duration(&random_source(&mut rng, 4));
        let _ = datetime::parse_date(&random_source(&mut rng, 4), 0);
    }
}

#[test]
fn property_documents_never_panic() {
    let mut rng = Rng(1234);
    const FRAGMENTS: &[&str] = &[
        "views:",
        "\n",
        "  - type: table",
        "    name: x",
        "filters:",
        "  and:",
        "    - a == 1",
        "formulas:",
        "  f: 1 +",
        "order: [a, b]",
        "limit: 3",
        "sort:",
        "- {property: a}",
        ":",
        "-",
        "[",
        "]",
        "{",
        "}",
        "&a",
        "*a",
        "'",
        "\"",
        "#",
        "|",
        ">",
        "\t",
        "  ",
        "null",
        "~",
        "groupBy: a",
        "summaries: {a: Sum}",
        "properties:",
        "  a: {displayName: A}",
        "---",
    ];
    for _ in 0..5_000 {
        let n = rng.below(14);
        let mut text = String::new();
        for _ in 0..n {
            text.push_str(rng.pick(FRAGMENTS));
            if rng.below(2) == 0 {
                text.push('\n');
            }
        }
        if let Ok(doc) = Document::parse(&text) {
            let _ = doc.to_yaml();
            let store = sample_store();
            let src = MemSource::new(&store);
            let _ = run_view(&doc, None, &src, &clock(), &QueryOptions::default());
        }
    }
}

#[test]
fn property_clock_is_injected_not_ambient() {
    // two runs with the same clock agree; moving the clock moves today()
    let e1 = Env::new();
    let a = e1.disp("today()");
    assert_eq!(a, Env::new().disp("today()"));
    let mut e2 = Env::new();
    e2.clock = FixedClock::at("2030-12-31T23:59:59");
    assert_eq!(e2.disp("today()"), "2030-12-31");
    assert_eq!(e2.disp("(today() + \"1d\")"), "2031-01-01");
    assert_eq!(e1.clock.now_local_ms(), clock().now_local_ms());
    // random() is deterministic per clock
    assert_eq!(e1.disp("random()"), Env::new().disp("random()"));
}

#[test]
fn column_width_comes_from_column_size_by_canonical_key() {
    let r = run(
        "views:\n  - type: table\n    name: T\n    order: [file.name, note.status, priority]\n    columnSize:\n      file.name: 420\n      status: 120.5\n",
        None,
    );
    let w: Vec<Option<f64>> = r.columns.iter().map(|c| c.width).collect();
    assert_eq!(w, vec![Some(420.0), Some(120.5), None]);
    let j = serde_json::to_value(&r.columns[0]).unwrap();
    assert_eq!(j["width"], 420.0);
}
