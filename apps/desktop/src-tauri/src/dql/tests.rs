//! DQL tests: the parser's shapes, the lowering to Bases documents, and `shared/dql-vectors.json`
//! (each query run on a fixture vault through the real index and the Bases executor).

use super::ast::*;
use super::lower::{lower, Kind};
use super::parser::{parse_expression, parse_query};
use crate::bases::context::FixedClock;
use crate::bases::document::Document;
use crate::bases::query::{BaseQueryResult, QueryOptions};
use crate::index::bases_source::run_base_view;
use crate::index::Index;
use serde_json::Value as Json;
use std::sync::Arc;
use tempfile::TempDir;

struct Vault {
    _vault: TempDir,
    _data: TempDir,
    index: Arc<Index>,
}

fn vectors() -> Json {
    serde_json::from_str(include_str!("../../../shared/dql-vectors.json")).unwrap()
}

fn fixture() -> Vault {
    let v = vectors();
    let root = TempDir::new().unwrap();
    for (rel, text) in v["vault"].as_object().unwrap() {
        let p = root.path().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text.as_str().unwrap()).unwrap();
    }
    let data = TempDir::new().unwrap();
    let index = Arc::new(Index::open_for_cli(root.path(), Some(data.path())).unwrap());
    Vault {
        _vault: root,
        _data: data,
        index,
    }
}

fn clock() -> FixedClock {
    FixedClock::at(vectors()["now"].as_str().unwrap())
}

fn run_doc(vault: &Vault, doc: &Document, this: &str) -> BaseQueryResult {
    let r = run_base_view(&vault.index, doc, None, Some(this), &clock()).unwrap();
    assert!(r.error.is_none(), "{:?}", r.error);
    r
}

fn shown(r: &BaseQueryResult) -> (Vec<String>, Vec<Vec<String>>) {
    (
        r.columns.iter().map(|c| c.display_name.clone()).collect(),
        r.rows
            .iter()
            .map(|row| row.cells.iter().map(|c| c.display.clone()).collect())
            .collect(),
    )
}

fn strings(v: &Json) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn every_vector_query_returns_its_rows_on_the_fixture_vault() {
    let vault = fixture();
    let v = vectors();
    for q in v["queries"].as_array().unwrap() {
        let name = q["name"].as_str().unwrap();
        let lowered = lower(q["dql"].as_str().unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let this = q["this"].as_str().or(v["this"].as_str()).unwrap();
        let result = run_doc(&vault, &lowered.live_document(), this);
        let (columns, rows) = shown(&result);
        assert_eq!(columns, strings(&q["columns"]), "{name}: columns");
        let want: Vec<Vec<String>> = q["rows"].as_array().unwrap().iter().map(strings).collect();
        assert_eq!(rows, want, "{name}: rows");
        if let Some(kind) = q["kind"].as_str() {
            assert_eq!(
                serde_json::to_value(lowered.kind).unwrap(),
                Json::String(kind.into()),
                "{name}"
            );
        }
    }
}

#[test]
fn a_query_with_a_bases_form_runs_the_same_as_its_plain_base() {
    let vault = fixture();
    let v = vectors();
    let mut checked = 0;
    for q in v["queries"].as_array().unwrap() {
        let name = q["name"].as_str().unwrap();
        let lowered = lower(q["dql"].as_str().unwrap()).unwrap();
        let mut got: Vec<&str> = lowered.unmapped.iter().map(|u| u.clause.as_str()).collect();
        got.sort_unstable();
        let mut want: Vec<String> = q.get("unmapped").map(strings).unwrap_or_default();
        want.sort_unstable();
        assert_eq!(got, want, "{name}: unmapped {:?}", lowered.unmapped);
        assert_eq!(lowered.base_text().is_ok(), want.is_empty(), "{name}");
        if !q["same_as_base"].as_bool().unwrap_or(false) {
            continue;
        }
        let text = lowered.base_text().unwrap();
        assert!(!text.contains("dialect"), "{name}: {text}");
        let doc = Document::parse(&text).unwrap_or_else(|e| panic!("{name}: {e}\n{text}"));
        let this = q["this"].as_str().or(v["this"].as_str()).unwrap();
        let plain = run_doc(&vault, &doc, this);
        let live = run_doc(&vault, &lowered.live_document(), this);
        assert_eq!(shown(&plain), shown(&live), "{name}: base vs live");
        checked += 1;
    }
    assert!(checked >= 15, "{checked}");
}

#[test]
fn errors_name_the_line_and_column() {
    for e in vectors()["errors"].as_array().unwrap() {
        let dql = e["dql"].as_str().unwrap();
        let err = lower(dql).expect_err(dql);
        assert!(
            err.message.contains(e["contains"].as_str().unwrap()),
            "{dql}: {err}"
        );
        assert_eq!(
            (err.line as u64, err.col as u64),
            (e["line"].as_u64().unwrap(), e["col"].as_u64().unwrap()),
            "{dql}: {err}"
        );
    }
}

// ---------------------------------------------------------------------------
// Parser shapes
// ---------------------------------------------------------------------------

#[test]
fn clauses_parse_in_any_order_and_keywords_are_case_insensitive() {
    let q = parse_query(
        "table a, b as B from #x where a sort a desc limit 3 flatten c as d group by e",
    )
    .unwrap();
    let kinds: Vec<&str> = q.clauses.iter().map(Clause::keyword).collect();
    assert_eq!(kinds, ["WHERE", "SORT", "LIMIT", "FLATTEN", "GROUP BY"]);
    let Header::Table { fields, without_id } = q.header else {
        panic!()
    };
    assert!(!without_id);
    assert_eq!(fields[1].name, "B");
    assert!(fields[1].explicit);
    assert_eq!(fields[0].name, "a");
}

#[test]
fn an_unnamed_column_is_titled_with_its_own_text() {
    let q = parse_query("TABLE length(rows) * 2,\n  file.name\nFROM \"x\"").unwrap();
    let Header::Table { fields, .. } = q.header else {
        panic!()
    };
    assert_eq!(fields[0].name, "length(rows) * 2");
    assert_eq!(fields[1].name, "file.name");
}

#[test]
fn boolean_operators_share_one_left_associative_level_like_dataview() {
    let e = parse_expression("a or b and c").unwrap();
    let Expr::Bin(BinOp::And, l, _) = e else {
        panic!("{e:?}")
    };
    assert!(matches!(*l, Expr::Bin(BinOp::Or, ..)));
    // word boundaries: `order` is a field, not `or der`
    assert!(matches!(
        parse_expression("order").unwrap(),
        Expr::Var { .. }
    ));
}

#[test]
fn identifiers_may_contain_hyphens_and_dates_and_durations_are_literals() {
    assert!(
        matches!(parse_expression("due-date").unwrap(), Expr::Var { name, .. } if name == "due-date")
    );
    assert!(
        matches!(parse_expression("date(2024-01-15)").unwrap(), Expr::Date(d) if d == "2024-01-15")
    );
    assert!(matches!(
        parse_expression("date(today)").unwrap(),
        Expr::Shorthand(Shorthand::Today)
    ));
    assert!(
        matches!(parse_expression("dur(1 day, 2 hours)").unwrap(), Expr::Duration(d) if d == "1 days 2 hours")
    );
    // `date(x)` with a field is an ordinary call
    assert!(matches!(
        parse_expression("date(file.ctime)").unwrap(),
        Expr::Call { .. }
    ));
    assert!(
        matches!(parse_expression("[[Note|alias]]").unwrap(), Expr::Link { path, display } if path == "Note" && display.as_deref() == Some("alias"))
    );
}

#[test]
fn lambdas_objects_lists_and_postfixes_parse() {
    assert!(matches!(
        parse_expression("map(rows, (r) => r.file.name)").unwrap(),
        Expr::Call { .. }
    ));
    assert!(
        matches!(parse_expression("{ a: 1, \"b c\": [1, 2] }").unwrap(), Expr::Object(f) if f.len() == 2)
    );
    assert!(matches!(
        parse_expression("x[0].y").unwrap(),
        Expr::Field(..)
    ));
    assert!(parse_expression("a +").is_err());
    assert!(parse_expression("(a").is_err());
}

#[test]
fn deep_nesting_is_an_error_not_a_crash() {
    let deep = format!("{}1{}", "(".repeat(5_000), ")".repeat(5_000));
    assert!(parse_expression(&deep).is_err());
    let deep = format!("TABLE {}", "[".repeat(5_000));
    assert!(parse_query(&deep).is_err());
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

fn base_of(dql: &str) -> String {
    lower(dql).unwrap().live_text()
}

/// Every expression a document holds (filters and formulas), as source text.
fn expressions(text: &str) -> String {
    use crate::bases::document::Filter;
    fn leaves(f: &Filter, out: &mut Vec<String>) {
        match f {
            Filter::Expr(s) => out.push(s.clone()),
            Filter::And(v) | Filter::Or(v) | Filter::Not(v) => {
                v.iter().for_each(|x| leaves(x, out))
            }
        }
    }
    let doc = Document::parse(text).unwrap();
    let mut out = Vec::new();
    if let Some(f) = &doc.filters {
        leaves(f, &mut out);
    }
    out.extend(doc.formulas.iter().map(|(_, e)| e.clone()));
    out.join("\n")
}

#[test]
fn a_table_lowers_to_filters_formulas_a_sort_and_a_view() {
    let l = lower(r#"TABLE status AS S, length(tags) FROM "Projects" WHERE priority > 1 SORT priority DESC LIMIT 5"#)
        .unwrap();
    assert_eq!(l.kind, Kind::Table);
    assert!(l.unmapped.is_empty());
    let text = l.base_text().unwrap();
    let exprs = expressions(&text);
    assert!(exprs.contains("file.ext == \"md\""), "{exprs}");
    assert!(exprs.contains("file.inFolder(\"Projects\")"), "{exprs}");
    assert!(exprs.contains("priority > 1"), "{exprs}");
    assert!(exprs.contains("tags.length"), "{exprs}");
    assert!(text.contains("limit: 5"), "{text}");
    assert!(text.contains("DESC"), "{text}");
    assert!(!text.contains("dialect"));
    // the live document is the same plus the dialect key
    assert!(
        l.live_text().contains("dialect: dql\n"),
        "{}",
        l.live_text()
    );
}

#[test]
fn clauses_with_no_bases_form_are_named() {
    let l = lower(r#"TABLE x FROM "a" FLATTEN tags AS t GROUP BY t SORT key"#).unwrap();
    let clauses: Vec<&str> = l.unmapped.iter().map(|u| u.clause.as_str()).collect();
    assert_eq!(clauses, ["FLATTEN", "GROUP BY", "SORT"]);
    assert!(l.base_text().is_err());
    let l = lower("LIST WHERE regextest(\"a\", file.name)").unwrap();
    assert_eq!(l.unmapped[0].clause, "WHERE");
    assert!(l.unmapped[0].reason.contains("regextest"));
    assert_eq!((l.unmapped[0].line, l.unmapped[0].col), (1, 6));
    let l = lower("TABLE file.tags").unwrap();
    assert_eq!(l.unmapped[0].clause, "TABLE");
}

#[test]
fn flatten_where_and_group_go_to_the_extension_keys() {
    let text = base_of(
        r#"TABLE x FROM "a" WHERE a FLATTEN tags AS t WHERE t GROUP BY b AS g WHERE key SORT key DESC LIMIT 2"#,
    );
    assert!(text.contains("flatten:"), "{text}");
    assert!(text.contains("dqlGroup:"), "{text}");
    assert!(text.contains("as: g"), "{text}");
    let doc = Document::parse(&text).unwrap();
    assert_eq!(doc.views[0].limit, Some(2));
}

#[test]
fn a_task_query_lowers_to_task_rows_with_the_task_properties() {
    let l =
        lower(r#"TASK FROM "Projects" WHERE !completed AND due < date(today) SORT due"#).unwrap();
    assert_eq!(l.kind, Kind::Task);
    let text = l.base_text().unwrap_or_else(|u| panic!("{u:?}"));
    let exprs = expressions(&text);
    assert!(text.contains("rows: tasks"), "{text}");
    assert!(exprs.contains("task.status == \"DONE\""), "{exprs}");
    assert!(exprs.contains("task.due < today()"), "{exprs}");
    assert!(text.contains("property: task.due"), "{text}");
    // tasks are shown under their file, as Dataview does
    assert!(text.contains("groupBy:"), "{text}");
    // a grouped task query keeps its own group
    let text = base_of("TASK GROUP BY file.folder");
    assert!(text.contains("property: file.folder"), "{text}");
    assert!(!text.contains("dqlGroup"), "{text}");
    // a field a task row has no equivalent of is named
    let e = lower("TASK WHERE parent").unwrap_err();
    assert!(e.message.contains("parent"), "{e}");
    assert!(lower("TASK GROUP BY file.folder SORT key").is_err());
}

#[test]
fn date_shorthands_and_durations_lower_to_bases_dates() {
    let text = base_of(
        r#"LIST WHERE file.mtime >= date(today) - dur(7 days) AND file.ctime < date(tomorrow)"#,
    );
    let exprs = expressions(&text);
    assert!(exprs.contains("today() - duration(\"7 days\")"), "{exprs}");
    assert!(exprs.contains("today() + \"1 day\""), "{exprs}");
    let l = lower("LIST WHERE file.mtime >= date(eom)").unwrap();
    assert!(l.unmapped[0].reason.contains("end of the month"));
}

#[test]
fn a_limit_before_another_clause_is_refused() {
    assert!(lower("LIST LIMIT 3 WHERE a").is_err());
    assert!(lower("LIST WHERE a LIMIT 3 LIMIT 2").is_ok());
    assert!(lower("LIST LIMIT priority").is_err());
}

// ---------------------------------------------------------------------------
// The dialect stays out of Bases results
// ---------------------------------------------------------------------------

#[test]
fn the_dialect_never_changes_bases_results() {
    // the same document, with and without `dialect: dql`, differs only where DQL semantics
    // are asked for; without the key every Bases rule stands
    let vault = fixture();
    let base = "filters:\n  and:\n    - 'file.ext == \"md\"'\nviews:\n  - type: table\n    name: T\n    order: [file.name, file.tags, priority, Owner]\n    sort:\n      - property: file.name\n        direction: ASC\n";
    let plain = run_doc(&vault, &Document::parse(base).unwrap(), "Home.md");
    let again = run_doc(
        &vault,
        &Document::parse(&format!("{base}extra_unknown_key: 1\n")).unwrap(),
        "Home.md",
    );
    assert_eq!(shown(&plain), shown(&again));
    let (cols, rows) = shown(&plain);
    assert_eq!(cols, ["file.name", "file.tags", "priority", "Owner"]);
    // Bases: file.name has the extension, file.tags no `#`, an inline field is no property
    let alpha = rows.iter().find(|r| r[0] == "Alpha.md").unwrap();
    assert_eq!(alpha[1], "alpha, urgent, work");
    assert_eq!(alpha[3], "");
    // the same document under the dialect: inline fields appear
    let dql = Document::parse(&format!("dialect: dql\n{base}")).unwrap();
    let live = run_doc(&vault, &dql, "Home.md");
    let alpha_live = shown(&live)
        .1
        .into_iter()
        .find(|r| r[0] == "Alpha.md")
        .unwrap();
    assert_eq!(alpha_live[3], "Ann Lee");
    assert_eq!(alpha_live[1], "#alpha, #urgent, #work");
    // and a Bases function the dialect adds is unknown without it
    let probe = "formulas:\n  f: 'upper(\"a\")'\nviews:\n  - type: table\n    name: T\n    order: [formula.f]\n    limit: 1\n";
    let r = run_doc(&vault, &Document::parse(probe).unwrap(), "Home.md");
    assert!(matches!(
        r.rows[0].cells[0].value,
        crate::bases::value::Value::Error(_)
    ));
    let r = run_doc(
        &vault,
        &Document::parse(&format!("dialect: dql\n{probe}")).unwrap(),
        "Home.md",
    );
    assert_eq!(r.rows[0].cells[0].display, "A");
    let _ = QueryOptions::default();
}

// ---------------------------------------------------------------------------
// TASK execution needs the Tasks feature's rows
// ---------------------------------------------------------------------------

#[test]
fn a_task_query_returns_the_task_rows_the_fixture_expects() {
    let vault = fixture();
    let l = lower(r#"TASK FROM "Projects" WHERE !completed"#).unwrap();
    let r = run_doc(&vault, &l.live_document(), "Home.md");
    let texts: Vec<String> = r
        .rows
        .iter()
        .map(|row| row.cells[0].display.clone())
        .collect();
    assert_eq!(texts, ["write plan"]);
}
