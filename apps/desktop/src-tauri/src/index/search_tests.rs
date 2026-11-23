//! Full-text search tests over synthetic vaults in temp dirs. No real data.

use super::fts::{fts_size_bytes, FtsMaintenance, FTS_MAX_BODY_BYTES};
use super::*;
use std::fs;
use std::time::Instant;
use tempfile::TempDir;

struct V {
    vault: TempDir,
    data: TempDir,
}

impl V {
    fn new() -> V {
        V {
            vault: TempDir::new().unwrap(),
            data: TempDir::new().unwrap(),
        }
    }

    fn write(&self, rel: &str, content: &str) {
        let p = self.vault.path().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn index(&self) -> Index {
        Index::open_for_cli(self.vault.path(), Some(self.data.path())).unwrap()
    }

    fn reindex(&self, index: &Index, rels: &[&str]) {
        index
            .index_paths_blocking(
                rels.iter()
                    .map(|r| self.vault.path().canonicalize().unwrap().join(r))
                    .collect(),
            )
            .unwrap();
    }
}

fn paths(page: &SearchPage) -> Vec<&str> {
    page.hits.iter().map(|h| h.path.as_str()).collect()
}

fn search(index: &Index, q: &str) -> SearchPage {
    index.search(q, &SearchOptions::default()).unwrap()
}

fn fixture() -> V {
    let v = V::new();
    v.write("Journal/Trip.md", "---\ntags: [travel]\nmood: happy\n---\n# Trip\nWe walked along the harbour.\nThe harbour lights were lovely.\n");
    v.write("Notes/Harbour.md", "# Harbour\nShort note.\n");
    v.write(
        "Notes/Misc.md",
        "A long note about many things. ".repeat(30).as_str(),
    );
    v.write(
        "Notes/Misc2.md",
        "Mentions harbour once in passing, among many other unrelated words that dilute it.\n",
    );
    v.write(
        "Projects/Alpha.md",
        "# Alpha plan\nBudget review and roadmap planning.\n#work\n",
    );
    v.write(
        "Projects/Beta.md",
        "Planning the budget; roadmap later. Excluded word: secret.\n",
    );
    v.write("café/résumé.md", "Résumé of a café owner.\n");
    v.write(
        "日本語/ノート.md",
        "私は東京に住んでいます。\n京都も好きです。\n",
    );
    v
}

#[test]
fn fts5_is_compiled_in_and_contentless_delete_works() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let opts: Vec<String> = conn
        .prepare("PRAGMA compile_options")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        opts.iter().any(|o| o == "ENABLE_FTS5"),
        "bundled SQLite lacks FTS5: {opts:?}"
    );
    conn.execute_batch(
        "CREATE VIRTUAL TABLE t USING fts5(a, tokenize='unicode61 remove_diacritics 2', prefix='2 3', \
         content='', contentless_delete=1);
         INSERT INTO t(rowid, a) VALUES (1, 'Café au lait');
         DELETE FROM t WHERE rowid = 1;",
    )
    .unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM t WHERE t MATCH 'cafe'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0);
    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .unwrap();
    let minor: u32 = version.split('.').nth(1).unwrap().parse().unwrap();
    assert!(
        minor >= 43,
        "contentless_delete needs SQLite 3.43+, got {version}"
    );
}

#[test]
fn ranking_prefers_title_and_short_dense_notes() {
    let v = fixture();
    let index = v.index();
    let page = search(&index, "harbour");
    assert_eq!(page.total, 3);
    // Title match first, then the two-mention note, then the diluted one.
    assert_eq!(
        paths(&page),
        vec!["Notes/Harbour.md", "Journal/Trip.md", "Notes/Misc2.md"]
    );
    assert!(page.hits[0].score > page.hits[1].score && page.hits[1].score > page.hits[2].score);
    // Heading weight beats body weight.
    assert_eq!(paths(&search(&index, "plan")), vec!["Projects/Alpha.md"]); // heading word; no stemming
    let page = search(&index, "plan*");
    assert_eq!(paths(&page), vec!["Projects/Alpha.md", "Projects/Beta.md"]);
}

#[test]
fn phrases_prefix_exclusion_or_and_filters() {
    let v = fixture();
    let index = v.index();
    assert_eq!(
        paths(&search(&index, "\"budget review\"")),
        vec!["Projects/Alpha.md"]
    );
    assert!(search(&index, "\"review budget\"").hits.is_empty());
    assert_eq!(search(&index, "budget -review").total, 1);
    assert_eq!(
        paths(&search(&index, "budget -review")),
        vec!["Projects/Beta.md"]
    );
    assert_eq!(search(&index, "roadmap -\"budget review\"").total, 1);
    assert_eq!(search(&index, "secret OR lovely").total, 2);
    assert_eq!(
        paths(&search(&index, "budget tag:work")),
        vec!["Projects/Alpha.md"]
    );
    assert_eq!(
        paths(&search(&index, "budget path:Beta")),
        vec!["Projects/Beta.md"]
    );
    assert_eq!(
        paths(&search(&index, "file:trip harbour")),
        vec!["Journal/Trip.md"]
    );
    let o = SearchOptions {
        folder: Some("Projects".into()),
        ..Default::default()
    };
    assert_eq!(index.search("budget", &o).unwrap().total, 2);
    let o = SearchOptions {
        tags: vec!["#travel".into()],
        ..Default::default()
    };
    assert_eq!(
        paths(&index.search("harbour", &o).unwrap()),
        vec!["Journal/Trip.md"]
    );
    // Frontmatter values are searchable, keys are not.
    assert_eq!(paths(&search(&index, "happy")), vec!["Journal/Trip.md"]);
    assert!(search(&index, "mood").hits.is_empty());
    // Only-negative / punctuation-only queries match nothing and do not fail.
    assert_eq!(search(&index, "-secret").total, 0);
    assert_eq!(search(&index, "!!! ???").total, 0);
    let bad = SearchOptions {
        tags: vec!["###".into()],
        ..Default::default()
    };
    assert!(matches!(
        index.search("budget", &bad),
        Err(IndexError::Invalid(_))
    ));
}

#[test]
fn diacritics_fold_and_cjk_matches_substrings() {
    let v = fixture();
    let index = v.index();
    assert_eq!(paths(&search(&index, "resume")), vec!["café/résumé.md"]);
    assert_eq!(paths(&search(&index, "CAFE")), vec!["café/résumé.md"]);
    // CJK: each ideograph/kana is a token, so words inside a sentence match.
    let page = search(&index, "東京");
    assert_eq!(paths(&page), vec!["日本語/ノート.md"]);
    let s = &page.hits[0].snippets[0];
    assert_eq!(s.line, 1);
    assert_eq!(s.text, "私は東京に住んでいます。");
    let r = s.ranges[0];
    let u16s: Vec<u16> = s.text.encode_utf16().collect();
    assert_eq!(
        String::from_utf16_lossy(&u16s[r[0] as usize..r[1] as usize]),
        "東京"
    );
    assert_eq!(
        s.ranges.len(),
        1,
        "adjacent ideograph tokens merge into one range"
    );
    assert_eq!(search(&index, "京都").total, 1);
    assert_eq!(search(&index, "ノート").total, 1); // by file name too
    assert_eq!(search(&index, "東*").total, 1);
}

#[test]
fn snippets_have_disk_line_numbers_and_utf16_ranges() {
    let v = fixture();
    let index = v.index();
    let page = search(&index, "harbour");
    let trip = page
        .hits
        .iter()
        .find(|h| h.path == "Journal/Trip.md")
        .unwrap();
    // Frontmatter occupies lines 1-4; the matches are on disk lines 6 and 7.
    assert_eq!(
        trip.snippets.iter().map(|s| s.line).collect::<Vec<_>>(),
        vec![6, 7]
    );
    assert_eq!(trip.snippets[0].text, "We walked along the harbour.");
    assert_eq!(trip.snippets[0].ranges, vec![[20, 27]]);
    assert!(!trip.stale);
    // Long lines are windowed around the first match with ellipses.
    v.write(
        "Notes/Long.md",
        &format!("{} needle {}\n", "x ".repeat(200), "y ".repeat(200)),
    );
    let index = v.index();
    let o = SearchOptions {
        snippet_len: Some(40),
        ..Default::default()
    };
    let page = index.search("needle", &o).unwrap();
    let s = &page.hits[0].snippets[0];
    assert!(s.text.starts_with('…') && s.text.ends_with('…'));
    let u16s: Vec<u16> = s.text.encode_utf16().collect();
    let r = s.ranges[0];
    assert_eq!(
        String::from_utf16_lossy(&u16s[r[0] as usize..r[1] as usize]),
        "needle"
    );
    // Emoji before the match: ranges stay UTF-16 correct.
    v.write("Notes/Emoji.md", "😀😀 smile here\n");
    let index = v.index();
    let s = &search(&index, "smile").hits[0].snippets[0];
    assert_eq!(s.ranges, vec![[5, 10]]);
    // max_snippets = 0 reads no files.
    let o = SearchOptions {
        max_snippets: Some(0),
        ..Default::default()
    };
    assert!(index.search("smile", &o).unwrap().hits[0]
        .snippets
        .is_empty());
}

#[test]
fn stays_in_sync_on_edit_rename_and_delete() {
    let v = fixture();
    let index = v.index();
    assert_eq!(search(&index, "zebra").total, 0);
    v.write("Notes/Misc2.md", "now about zebra only\n");
    v.reindex(&index, &["Notes/Misc2.md"]);
    assert_eq!(paths(&search(&index, "zebra")), vec!["Notes/Misc2.md"]);
    assert!(!paths(&search(&index, "harbour")).contains(&"Notes/Misc2.md"));
    // Rename: the old path leaves the index, the new one enters it.
    fs::rename(
        v.vault.path().join("Notes/Misc2.md"),
        v.vault.path().join("Notes/Renamed.md"),
    )
    .unwrap();
    v.reindex(&index, &["Notes/Misc2.md", "Notes/Renamed.md"]);
    assert_eq!(paths(&search(&index, "zebra")), vec!["Notes/Renamed.md"]);
    assert_eq!(paths(&search(&index, "renamed")), vec!["Notes/Renamed.md"]);
    // Delete a note and a whole folder.
    fs::remove_file(v.vault.path().join("Notes/Renamed.md")).unwrap();
    v.reindex(&index, &["Notes/Renamed.md"]);
    assert_eq!(search(&index, "zebra").total, 0);
    fs::remove_dir_all(v.vault.path().join("Projects")).unwrap();
    v.reindex(&index, &["Projects"]);
    assert_eq!(search(&index, "roadmap").total, 0);
    // A new file may reuse a deleted row id: it must not inherit old text.
    v.write("New.md", "fresh content\n");
    v.reindex(&index, &["New.md"]);
    assert_eq!(search(&index, "roadmap").total, 0);
    assert_eq!(paths(&search(&index, "fresh")), vec!["New.md"]);
    // A warm refresh with deletions made behind the index's back.
    fs::remove_file(v.vault.path().join("New.md")).unwrap();
    index.refresh_blocking().unwrap();
    assert_eq!(search(&index, "fresh").total, 0);
    index
        .fts_maintenance(FtsMaintenance::IntegrityCheck)
        .unwrap();
}

#[test]
fn stale_hits_are_flagged_not_trusted() {
    let v = fixture();
    let index = v.index();
    v.write(
        "Notes/Harbour.md",
        "# Harbour\nedited behind the index's back: harbour\n",
    );
    let page = search(&index, "harbour");
    let h = page
        .hits
        .iter()
        .find(|h| h.path == "Notes/Harbour.md")
        .unwrap();
    assert!(h.stale);
    // Line numbers still come from the current disk text.
    assert_eq!(
        h.snippets.iter().map(|s| s.line).collect::<Vec<_>>(),
        vec![1, 2]
    );
    fs::remove_file(v.vault.path().join("Notes/Harbour.md")).unwrap();
    let page = search(&index, "harbour");
    let h = page
        .hits
        .iter()
        .find(|h| h.path == "Notes/Harbour.md")
        .unwrap();
    assert!(h.stale && h.snippets.is_empty());
}

#[test]
fn case_sensitive_is_a_post_filter_on_text() {
    let v = fixture();
    v.write(
        "Notes/Case.md",
        "Rust and rust and RUST\nonly lower rust here\n",
    );
    let index = v.index();
    let o = |case| SearchOptions {
        case_sensitive: case,
        ..Default::default()
    };
    let loose = index.search("rust", &o(false)).unwrap();
    assert_eq!(loose.total, 1);
    let exact = index.search("Rust", &o(true)).unwrap();
    assert_eq!(exact.total, 1);
    let lines: Vec<_> = exact.hits[0].snippets.iter().map(|s| s.line).collect();
    assert_eq!(lines, vec![1]);
    assert_eq!(exact.hits[0].snippets[0].ranges.len(), 1);
    assert_eq!(index.search("rUsT", &o(true)).unwrap().total, 0);
    assert_eq!(index.search("Rus*", &o(true)).unwrap().total, 1);
    assert!(!exact.truncated);
}

#[test]
fn oversized_bodies_are_skipped_but_names_still_match() {
    let v = V::new();
    v.write(
        "Big.md",
        &format!(
            "# Big heading\n{}\nneedleinbody\n",
            "filler words here\n".repeat(FTS_MAX_BODY_BYTES / 18 + 10)
        ),
    );
    v.write("Small.md", "needleinbody\n");
    let index = v.index();
    assert_eq!(
        index.status().unwrap().last_scan.unwrap().fts_body_skipped,
        1
    );
    assert_eq!(paths(&search(&index, "needleinbody")), vec!["Small.md"]);
    assert_eq!(paths(&search(&index, "big")), vec!["Big.md"]);
    assert_eq!(paths(&search(&index, "heading")), vec!["Big.md"]);
    // No lines are produced for it either.
    let page = search(&index, "big");
    assert!(page.hits[0].snippets.is_empty());
}

#[test]
fn arbitrary_input_never_errors() {
    let v = fixture();
    let index = v.index();
    let alphabet: Vec<char> = "ab \"'*-:()^~NEAROTD.,;\\%_\0\u{1}\u{2}東京é😀\n\t{}[]#/"
        .chars()
        .collect();
    let mut seed = 0x9E3779B97F4A7C15u64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for _ in 0..1500 {
        let len = (next() % 40) as usize;
        let q: String = (0..len)
            .map(|_| alphabet[(next() % alphabet.len() as u64) as usize])
            .collect();
        for case in [false, true] {
            let o = SearchOptions {
                case_sensitive: case,
                ..Default::default()
            };
            if let Err(e) = index.search(&q, &o) {
                panic!("query {q:?} failed: {e}");
            }
        }
    }
    for q in [
        "NEAR(a b)",
        "a AND OR NOT",
        "\"",
        "\"\"",
        "*",
        "a*b*",
        "-",
        "- -",
        "col:x",
        "title: harbour",
        "^harbour",
        "{harbour}",
        "harbour NOT lovely",
    ] {
        index
            .search(q, &SearchOptions::default())
            .unwrap_or_else(|e| panic!("{q:?}: {e}"));
    }
}

#[test]
fn schema_bump_rebuilds_and_populates_fts() {
    let v = fixture();
    {
        let index = v.index();
        assert_eq!(search(&index, "harbour").total, 3);
        index.close();
    }
    // Downgrade the stored schema version, as an older build would have left it.
    let db = index_db_path(v.data.path(), &v.vault.path().canonicalize().unwrap());
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute(
            "UPDATE meta SET value = '1' WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
        conn.execute_batch("DROP TABLE notes_fts").unwrap();
    }
    let index = v.index();
    let st = index.status().unwrap();
    assert!(st.rebuilt_reason.unwrap().contains("schema version"));
    assert_eq!(search(&index, "harbour").total, 3);
}

#[test]
fn maintenance_commands_run() {
    let v = fixture();
    let index = v.index();
    index
        .fts_maintenance(FtsMaintenance::IntegrityCheck)
        .unwrap();
    index.fts_maintenance(FtsMaintenance::Optimize).unwrap();
    index
        .fts_maintenance(FtsMaintenance::IntegrityCheck)
        .unwrap();
    assert_eq!(search(&index, "harbour").total, 3);
    assert!(index.read(fts_size_bytes).unwrap() > 0);
}

/// Perf smoke: 3000 synthetic notes of about 3 KB. Prints cold-build time with
/// and without the full-text rows, the database size impact and query latency.
/// Asserts are generous; run with `--nocapture` to see the numbers.
#[test]
fn perf_smoke_cold_build_and_query_latency() {
    const N: usize = 3000;
    let words: Vec<String> = (0..2000)
        .map(|i| {
            format!(
                "w{:x}{}",
                i * 7919 % 4093,
                ["a", "ing", "tion", "er"][i % 4]
            )
        })
        .collect();
    let w = |i: usize| words[i].clone();
    let make = |dir: &std::path::Path| {
        let mut seed = 12345u64;
        let mut next = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        for i in 0..N {
            let mut body = format!(
                "---\ntags: [t{}]\nstatus: s{}\n---\n# Note {i}\n",
                i % 17,
                i % 5
            );
            while body.len() < 3000 {
                for _ in 0..12 {
                    body.push_str(&words[next() % words.len()]);
                    body.push(' ');
                }
                body.push('\n');
            }
            body.push_str(&format!("uniquemarker{i}\n"));
            let p = dir.join(format!("d{}/n{i}.md", i % 30));
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        }
    };
    let measure = |fts: bool| {
        let v = V::new();
        make(v.vault.path());
        let index = Index::open(OpenParams {
            root: v.vault.path().to_path_buf(),
            app_data_dir: v.data.path().to_path_buf(),
            cancel: Arc::new(AtomicBool::new(false)),
            on_change: None,
        })
        .unwrap();
        index
            .shared
            .fts_disabled
            .store(!fts, std::sync::atomic::Ordering::Relaxed);
        let t = Instant::now();
        index.refresh_blocking().unwrap();
        let built = t.elapsed();
        // Fold the WAL into the main file so the size is comparable.
        index
            .read(|c| Ok(c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?))
            .ok();
        let size = fs::metadata(index.db_path()).unwrap().len();
        let fts_size = index.read(fts_size_bytes).unwrap();
        (v, index, built, size, fts_size)
    };
    let (_v0, _i0, base_t, base_size, _) = measure(false);
    let (_v1, index, fts_t, fts_total, fts_bytes) = measure(true);
    let t = Instant::now();
    index.fts_maintenance(FtsMaintenance::Optimize).unwrap();
    let optimize_t = t.elapsed();
    let fts_bytes_optimized = index.read(fts_size_bytes).unwrap();
    let mut lat = Vec::new();
    let (w1, w2, w5) = (w(1), w(2), w(5));
    let queries = [
        w1.clone(),
        format!("{w1} {w2}"),
        format!("\"{w1} {w2}\""),
        "uniquemarker1234".to_string(),
        format!("{}*", &w1[..3]),
        format!("{w1} -{w2}"),
        format!("tag:t3 {w5}"),
    ];
    for q in &queries {
        let t = Instant::now();
        let page = index.search(q, &SearchOptions::default()).unwrap();
        lat.push((q.as_str(), t.elapsed(), page.total));
    }
    println!("perf: {N} notes ~3KB");
    println!(
        "perf: cold build without FTS rows {base_t:?}, with FTS {fts_t:?}, optimize {optimize_t:?}"
    );
    println!(
        "perf: db size without FTS {} KB, with FTS {} KB (fts tables {} KB, {} KB after optimize)",
        base_size / 1024,
        fts_total / 1024,
        fts_bytes / 1024,
        fts_bytes_optimized / 1024
    );
    for (q, d, n) in &lat {
        println!("perf: query {q:?}: {d:?} ({n} hits)");
    }
    assert!(fts_t.as_secs() < 60 && base_t.as_secs() < 60);
    assert!(lat.iter().all(|(_, d, _)| d.as_millis() < 1500), "{lat:?}");
    assert_eq!(
        index
            .search("uniquemarker1234", &SearchOptions::default())
            .unwrap()
            .total,
        1
    );
}

/// Links, backlinks and the search "title" come from the file name: a note's
/// frontmatter `title` and first heading are text to search, never a name.
#[test]
fn file_name_not_title_drives_links_and_the_title_column() {
    let v = V::new();
    v.write(
        "notes/plain-name.md",
        "---\ntitle: Fancy Display Title\n---\n# Quasar Heading\nbody\n",
    );
    v.write("other/Fancy Display Title.md", "# Something Else\n");
    v.write(
        "src.md",
        "[[plain-name]] [[Fancy Display Title]] [[Quasar Heading]] [[PLAIN-NAME#Quasar Heading|x]]\n",
    );
    let index = v.index();
    let link = |raw: &str| {
        index
            .links("src.md")
            .unwrap()
            .into_iter()
            .find(|l| l.raw == raw)
            .unwrap()
            .target
    };
    assert_eq!(link("plain-name").as_deref(), Some("notes/plain-name.md"));
    // `title:` of plain-name.md is ignored: the name goes to the file called that
    assert_eq!(
        link("Fancy Display Title").as_deref(),
        Some("other/Fancy Display Title.md")
    );
    assert_eq!(link("Quasar Heading"), None);
    assert_eq!(link("PLAIN-NAME").as_deref(), Some("notes/plain-name.md"));
    assert_eq!(index.backlinks("notes/plain-name.md").unwrap().len(), 2);
    assert!(index
        .unresolved()
        .unwrap()
        .iter()
        .any(|u| u.target == "Quasar Heading"));
    // the hit's title is the file stem, whatever the frontmatter or heading says
    let page = search(&index, "plain-name");
    assert_eq!(page.hits[0].path, "notes/plain-name.md");
    assert_eq!(page.hits[0].title, "plain-name");
    // frontmatter title and H1 stay searchable as text
    assert!(paths(&search(&index, "Quasar")).contains(&"notes/plain-name.md"));
    assert!(paths(&search(&index, "Fancy")).contains(&"notes/plain-name.md"));
}

#[test]
fn file_name_match_outranks_heading_and_body_matches() {
    let v = V::new();
    v.write("a/Comet.md", "nothing relevant\n");
    v.write("b/other.md", "# Comet\nComet comet comet comet\n");
    // a property value (not the `title` override, which ranks like a name) stays a weak match
    v.write("c/third.md", "---\nstatus: Comet\n---\nComet\n");
    let index = v.index();
    assert_eq!(search(&index, "comet").hits[0].path, "a/Comet.md");
}

const NOW_MS: i64 = 1_800_000_000_000;
const DAY_MS: i64 = 86_400_000;

fn ranked(index: &Index, q: &str, opened: &[(&str, i64)]) -> SearchPage {
    let mut opts = SearchOptions {
        recency: true,
        fuzzy: true,
        now_ms: NOW_MS,
        ..Default::default()
    };
    opts.opened = opened.iter().map(|(p, t)| (p.to_string(), *t)).collect();
    index.search(q, &opts).unwrap()
}

fn set_mtime(v: &V, rel: &str, ms: i64) {
    let f = fs::OpenOptions::new()
        .write(true)
        .open(v.vault.path().join(rel))
        .unwrap();
    f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64))
        .unwrap();
}

#[test]
fn recency_breaks_ties_between_equally_relevant_notes() {
    let v = V::new();
    // Identical text: bm25 ties, so only recency can order them.
    for n in ["a", "b", "c"] {
        v.write(
            &format!("{n}.md"),
            "# Quarterly review\nThe quarterly numbers.\n",
        );
        set_mtime(&v, &format!("{n}.md"), NOW_MS - 400 * DAY_MS);
    }
    set_mtime(&v, "b.md", NOW_MS - DAY_MS);
    let index = v.index();
    // No recency: path order.
    assert_eq!(
        paths(&search(&index, "quarterly")),
        ["a.md", "b.md", "c.md"]
    );
    // Modified recently wins.
    assert_eq!(
        paths(&ranked(&index, "quarterly", &[])),
        ["b.md", "a.md", "c.md"]
    );
    // Opened just now beats modified yesterday.
    let page = ranked(&index, "quarterly", &[("c.md", NOW_MS - 1000)]);
    assert_eq!(paths(&page)[0], "c.md");
    assert_eq!(page.total, 3);
}

#[test]
fn recency_does_not_beat_a_much_better_text_match() {
    let v = V::new();
    v.write("Dense.md", "# Harbour\nHarbour harbour harbour.\n");
    v.write(
        "Weak.md",
        &format!("{} harbour once.\n", "filler words ".repeat(200)),
    );
    set_mtime(&v, "Dense.md", NOW_MS - 400 * DAY_MS);
    set_mtime(&v, "Weak.md", NOW_MS);
    let index = v.index();
    let page = ranked(&index, "harbour", &[("Weak.md", NOW_MS)]);
    assert_eq!(paths(&page)[0], "Dense.md");
}

#[test]
fn fuzzy_fallback_finds_typos_in_names_headings_and_tags() {
    let v = fixture();
    v.write("People/François Lamarre.md", "Met at the conference.\n");
    v.write("Ideas/x.md", "# Sailing regatta plans\nText.\n#boating\n");
    let index = v.index();
    // Exact search finds nothing for the misspelling...
    assert!(search(&index, "francios lamare").hits.is_empty());
    // ...the fuzzy fallback finds the person, flagged as fuzzy.
    let page = ranked(&index, "francios lamare", &[]);
    assert_eq!(paths(&page), ["People/François Lamarre.md"]);
    assert!(page.hits[0].fuzzy && page.hits[0].snippets.is_empty());
    assert_eq!(page.total, 1);
    // Heading typo.
    assert_eq!(paths(&ranked(&index, "regata", &[])), ["Ideas/x.md"]);
    // Plenty of exact matches: no fuzzy extras.
    let page = ranked(&index, "harbour", &[]);
    assert!(page.hits.iter().all(|h| !h.fuzzy));
    // Off by default.
    assert!(index
        .search(
            "francios lamare",
            &SearchOptions {
                recency: true,
                ..Default::default()
            }
        )
        .unwrap()
        .hits
        .is_empty());
}

/// Fuzzy fallback and recency re-rank latency on 10k synthetic notes. Run with
/// `cargo test --release perf_fuzzy_10k -- --ignored --nocapture`.
#[test]
#[ignore]
fn perf_fuzzy_10k() {
    let v = V::new();
    for i in 0..10_000 {
        v.write(
            &format!(
                "area-{}/Note {} {}.md",
                i % 20,
                i,
                ["alpha", "budget", "retro", "Francois Lamarre"][i % 4]
            ),
            &format!(
                "# Heading {i} planning\nbody text {i} harbour\n#tag{}\n",
                i % 50
            ),
        );
    }
    let index = v.index();
    for (q, label) in [
        ("francios lamare", "fuzzy fallback"),
        ("harbour", "recency re-rank"),
        ("planing", "heading typo"),
    ] {
        let t = Instant::now();
        let page = ranked(&index, q, &[]);
        println!(
            "PERF {label} {q:?}: {:?} ({} hits)",
            t.elapsed(),
            page.total
        );
    }
}

#[test]
fn title_override_is_searchable_ranked_like_a_name_and_reported() {
    let v = V::new();
    v.write(
        "notes/plain-name.md",
        "---\ntitle: Zephyrine Quartz\n---\n# Heading Only\nbody text\n",
    );
    v.write("other/mention.md", "zephyrine appears once in the body\n");
    v.write("other/plain.md", "no override here\n");
    let index = v.index();
    // the override word appears nowhere else in that note, yet it is found
    let page = search(&index, "Zephyrine");
    assert_eq!(page.hits[0].path, "notes/plain-name.md");
    assert_eq!(page.hits[0].title, "plain-name");
    assert_eq!(
        page.hits[0].title_override.as_deref(),
        Some("Zephyrine Quartz")
    );
    // it outranks a body-only mention
    assert_eq!(paths(&page), ["notes/plain-name.md", "other/mention.md"]);
    // a note without an override carries none, and headings are never an override
    let page = search(&index, "plain");
    let plain = page
        .hits
        .iter()
        .find(|h| h.path == "other/plain.md")
        .unwrap();
    assert_eq!(plain.title_override, None);
    let page = search(&index, "Heading");
    assert_eq!(
        page.hits[0].title_override.as_deref(),
        Some("Zephyrine Quartz")
    ); // same note, via its H1
    assert_eq!(page.hits[0].path, "notes/plain-name.md");
}

#[test]
fn fuzzy_fallback_matches_the_title_override_too() {
    let v = V::new();
    v.write("a/x.md", "---\ntitle: Quarterly Planning\n---\nnothing\n");
    let index = v.index();
    let mut opts = SearchOptions {
        fuzzy: true,
        ..Default::default()
    };
    opts.recency = false;
    let page = index.search("Quarterley Planing", &opts).unwrap();
    assert!(page.hits.iter().any(|h| h.path == "a/x.md" && h.fuzzy));
    let hit = page.hits.iter().find(|h| h.path == "a/x.md").unwrap();
    assert_eq!(hit.title_override.as_deref(), Some("Quarterly Planning"));
}

#[test]
fn fuzzy_fallback_lists_base_files_by_stem_and_by_full_name() {
    let v = V::new();
    v.write("Bases/tasks.base", "views: []\n");
    v.write("notes/other.md", "nothing\n");
    let index = v.index();
    for q in ["tasks", "tasks.base", "taks.base"] {
        let page = ranked(&index, q, &[]);
        assert_eq!(paths(&page), ["Bases/tasks.base"], "query {q}");
        assert!(page.hits[0].fuzzy && page.hits[0].snippets.is_empty());
    }
}

#[test]
fn base_files_are_listed_by_name_even_when_many_notes_match_the_text() {
    // A `.base` has no full-text row, so it can only surface through its name. A query that
    // many notes mention (>= FUZZY_FEW) must still list it, ahead of the body matches.
    let v = V::new();
    v.write("Bases/Projects/tasks.base", "views: []\n");
    for i in 0..8 {
        v.write(
            &format!("notes/n{i}.md"),
            "open tasks and the base plan for the week\n",
        );
    }
    let index = v.index();
    for q in ["tasks", "tasks.base"] {
        let page = ranked(&index, q, &[]);
        let base = page
            .hits
            .iter()
            .position(|h| h.path == "Bases/Projects/tasks.base")
            .unwrap_or_else(|| panic!("query {q}: base missing from {:?}", paths(&page)));
        assert_eq!(base, 0, "query {q}: a name match leads the body matches");
        assert!(page.hits[base].fuzzy && page.hits[base].snippets.is_empty());
        if q == "tasks" {
            assert!(page.hits.len() > 8, "the body matches still follow");
        }
    }
    // not for a query the name does not match, and not when fuzzy is off
    assert!(!paths(&ranked(&index, "plan", &[])).contains(&"Bases/Projects/tasks.base"));
    let plain = index.search("tasks", &SearchOptions::default()).unwrap();
    assert!(!paths(&plain).contains(&"Bases/Projects/tasks.base"));
}
