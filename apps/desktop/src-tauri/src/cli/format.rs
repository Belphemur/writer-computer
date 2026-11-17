//! One formatter set over a table value (`json`, `csv`, `tsv`, `md`) shared by
//! every command that lists rows; commands build a [`Table`], never strings.

use serde_json::Value as Json;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Table {
    pub cols: Vec<String>,
    pub rows: Vec<Vec<Json>>,
}

impl Table {
    pub fn new(cols: &[&str]) -> Table {
        Table {
            cols: cols.iter().map(|c| c.to_string()).collect(),
            rows: Vec::new(),
        }
    }
    pub fn push(&mut self, row: Vec<Json>) {
        self.rows.push(row);
    }
}

/// Plain text of a cell: strings raw, null empty, lists joined with `, `.
pub fn cell_text(v: &Json) -> String {
    match v {
        Json::Null => String::new(),
        Json::String(s) => s.clone(),
        Json::Array(a) => a.iter().map(cell_text).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

pub fn json_pretty(v: &Json) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| "null".into())
}

/// Pretty JSON object with keys in the given order (serde_json's own map
/// sorts keys), `indent` spaces of base indentation.
pub fn pretty_object(entries: &[(String, Json)], indent: usize) -> String {
    if entries.is_empty() {
        return "{}".to_string();
    }
    let pad = " ".repeat(indent + 2);
    let body: Vec<String> = entries
        .iter()
        .map(|(k, v)| {
            let value = json_pretty(v).replace('\n', &format!("\n{pad}"));
            format!(
                "{pad}{}: {value}",
                serde_json::to_string(k).unwrap_or_else(|_| "\"\"".into())
            )
        })
        .collect();
    format!("{{\n{}\n{}}}", body.join(",\n"), " ".repeat(indent))
}

/// Rows as a JSON array of objects, columns in table order.
pub fn table_json(t: &Table) -> String {
    if t.rows.is_empty() {
        return "[]".to_string();
    }
    let rows: Vec<String> = t
        .rows
        .iter()
        .map(|r| {
            let entries: Vec<(String, Json)> =
                t.cols.iter().cloned().zip(r.iter().cloned()).collect();
            format!("  {}", pretty_object(&entries, 2))
        })
        .collect();
    format!("[\n{}\n]", rows.join(",\n"))
}

fn tsv_cell(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\t', "\\t")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', "<br>")
}

fn lines(rows: impl Iterator<Item = String>) -> String {
    let mut out = String::new();
    for r in rows {
        out.push_str(&r);
        out.push('\n');
    }
    out
}

/// Render `t`. `header` adds the column names to csv/tsv (the json and md
/// forms always carry them).
pub fn render(t: &Table, format: &str, header: bool) -> Result<String, String> {
    let texts = |r: &Vec<Json>| r.iter().map(cell_text).collect::<Vec<_>>();
    Ok(match format {
        "json" => format!("{}\n", table_json(t)),
        "tsv" => {
            let head = header.then(|| {
                t.cols
                    .iter()
                    .map(|c| tsv_cell(c))
                    .collect::<Vec<_>>()
                    .join("\t")
            });
            lines(head.into_iter().chain(t.rows.iter().map(|r| {
                texts(r)
                    .iter()
                    .map(|c| tsv_cell(c))
                    .collect::<Vec<_>>()
                    .join("\t")
            })))
        }
        "csv" => {
            let head = header.then(|| {
                t.cols
                    .iter()
                    .map(|c| csv_cell(c))
                    .collect::<Vec<_>>()
                    .join(",")
            });
            lines(head.into_iter().chain(t.rows.iter().map(|r| {
                texts(r)
                    .iter()
                    .map(|c| csv_cell(c))
                    .collect::<Vec<_>>()
                    .join(",")
            })))
        }
        "text" => {
            // Columns padded to their widest cell, two spaces apart; the last one is not padded.
            let mut grid: Vec<Vec<String>> = Vec::new();
            if header {
                grid.push(t.cols.clone());
            }
            grid.extend(t.rows.iter().map(texts));
            let ncols = t.cols.len();
            let widths: Vec<usize> = (0..ncols)
                .map(|c| {
                    grid.iter()
                        .map(|r| r.get(c).map_or(0, |s| s.chars().count()))
                        .max()
                        .unwrap_or(0)
                })
                .collect();
            lines(grid.iter().map(|r| {
                let cells: Vec<String> = r
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        if i + 1 == ncols {
                            c.clone()
                        } else {
                            format!("{c:<w$}", w = widths[i])
                        }
                    })
                    .collect();
                cells.join("  ").trim_end().to_string()
            }))
        }
        "md" => {
            let mut out = format!(
                "| {} |\n| {} |\n",
                t.cols
                    .iter()
                    .map(|c| md_cell(c))
                    .collect::<Vec<_>>()
                    .join(" | "),
                t.cols.iter().map(|_| "---").collect::<Vec<_>>().join(" | ")
            );
            for r in &t.rows {
                out.push_str(&format!(
                    "| {} |\n",
                    texts(r)
                        .iter()
                        .map(|c| md_cell(c))
                        .collect::<Vec<_>>()
                        .join(" | ")
                ));
            }
            out
        }
        other => return Err(format!("unsupported table format {other}")),
    })
}

/// One item per line.
pub fn list_lines<I: IntoIterator<Item = String>>(items: I) -> String {
    lines(items.into_iter())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Table {
        let mut t = Table::new(&["name", "n"]);
        t.push(vec![json!("a,b"), json!(1)]);
        t.push(vec![json!("x\"y|z"), json!(null)]);
        t.push(vec![json!(["p", "q"]), json!(2.5)]);
        t
    }

    #[test]
    fn csv_tsv_md_json() {
        let t = sample();
        assert_eq!(
            render(&t, "csv", true).unwrap(),
            "name,n\n\"a,b\",1\n\"x\"\"y|z\",\n\"p, q\",2.5\n"
        );
        assert_eq!(
            render(&t, "tsv", false).unwrap(),
            "a,b\t1\nx\"y|z\t\np, q\t2.5\n"
        );
        assert_eq!(
            render(&t, "md", true).unwrap(),
            "| name | n |\n| --- | --- |\n| a,b | 1 |\n| x\"y\\|z |  |\n| p, q | 2.5 |\n"
        );
        let text = render(&t, "json", true).unwrap();
        let j: Json = serde_json::from_str(&text).unwrap();
        assert_eq!(j[0], json!({"name": "a,b", "n": 1}));
        // column order is table order, not alphabetical
        let mut o = Table::new(&["z", "a"]);
        o.push(vec![json!(1), json!([1, 2])]);
        assert_eq!(
            render(&o, "json", true).unwrap(),
            "[\n  {\n    \"z\": 1,\n    \"a\": [\n      1,\n      2\n    ]\n  }\n]\n"
        );
        assert_eq!(
            render(&t, "text", false).unwrap(),
            "a,b    1\nx\"y|z\np, q   2.5\n"
        );
        assert!(render(&t, "yaml", true).is_err());
    }
}
