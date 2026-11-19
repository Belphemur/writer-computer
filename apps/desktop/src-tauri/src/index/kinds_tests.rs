//! The file-kind registry through the index: listing, extraction, search and the filters.
//! Synthetic vaults in temp dirs, PDFs built in memory (nothing fetched, no real data).

use super::*;
use crate::code_files::Policy;
use crate::features::pdf::fixture_pdf;
use std::fs;
use tempfile::TempDir;

const DRAWING_NOTE: &str =
    include_str!("../../../shared/excalidraw-fixtures/plain-json.excalidraw.md");

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

    fn write(&self, rel: &str, content: impl AsRef<[u8]>) {
        let p = self.vault.path().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn index(&self) -> Index {
        Index::open_for_cli(self.vault.path(), Some(self.data.path())).unwrap()
    }
}

fn drawing_json(text: &str) -> String {
    serde_json::json!({
        "type": "excalidraw", "version": 2, "appState": {}, "files": {},
        "elements": [{"id": "a", "type": "text", "text": text}, {"id": "b", "type": "rectangle"}]
    })
    .to_string()
}

fn fixture() -> V {
    let v = V::new();
    v.write(
        "Notes/Plan.md",
        "# Plan\nBudget review and the harbour walk.\n",
    );
    v.write(
        "Papers/Report.pdf",
        fixture_pdf(
            &["Quarterly zebra report", "Second page marmot"],
            Some("Annual plan"),
        ),
    );
    v.write("Papers/Broken.pdf", b"%PDF-1.4 this is not really a pdf");
    v.write(
        "Papers/credentials.pdf",
        fixture_pdf(&["hidden otter"], None),
    );
    v.write(
        "tools/run.py",
        "def harbourmaster():\n    return 'lantern'\n",
    );
    v.write("tools/secrets.py", "TOKEN = 'quokka'\n");
    v.write(
        "Drawings/Arch.excalidraw",
        drawing_json("lighthouse keeper"),
    );
    v.write("Drawings/Board.excalidraw.md", DRAWING_NOTE);
    v.write("logo.png", [0x89, b'P', b'N', b'G', 0, 1, 2]);
    v.write("tasks.base", "views: []\n");
    v
}

fn paths(page: &SearchPage) -> Vec<&str> {
    page.hits.iter().map(|h| h.path.as_str()).collect()
}

fn search(index: &Index, q: &str) -> SearchPage {
    index.search(q, &SearchOptions::default()).unwrap()
}

fn kind_of(index: &Index, path: &str) -> String {
    index
        .read(|c| {
            Ok(
                c.query_row("SELECT kind FROM files WHERE path = ?1", [path], |r| {
                    r.get(0)
                })?,
            )
        })
        .unwrap()
}

#[test]
fn every_file_is_stored_with_its_kind() {
    let v = fixture();
    let index = v.index();
    index.refresh_blocking().unwrap();
    for (path, kind) in [
        ("Notes/Plan.md", "note"),
        ("Papers/Report.pdf", "pdf"),
        ("tools/run.py", "code"),
        ("Drawings/Arch.excalidraw", "drawing"),
        ("Drawings/Board.excalidraw.md", "drawing"),
        ("logo.png", "image"),
        ("tasks.base", "base"),
        // never listed, so no kind
        ("tools/secrets.py", ""),
    ] {
        assert_eq!(kind_of(&index, path), kind, "{path}");
    }
}

#[test]
fn a_word_only_inside_a_pdf_finds_that_pdf_on_the_right_page() {
    let v = fixture();
    let index = v.index();
    index.refresh_blocking().unwrap();
    let page = search(&index, "zebra");
    assert_eq!(paths(&page), ["Papers/Report.pdf"]);
    let hit = &page.hits[0];
    assert_eq!(hit.kind, "pdf");
    let snippet = &hit.snippets[0];
    assert_eq!((snippet.page, snippet.in_file), (Some(1), false));
    assert!(snippet.text.contains("zebra"));
    let second = search(&index, "marmot");
    assert_eq!(paths(&second), ["Papers/Report.pdf"]);
    assert_eq!(second.hits[0].snippets[0].page, Some(2));
    // the document title is searched like a file name
    assert_eq!(paths(&search(&index, "annual")), ["Papers/Report.pdf"]);
}

#[test]
fn code_and_drawings_are_found_by_their_text() {
    let v = fixture();
    let index = v.index();
    index.refresh_blocking().unwrap();
    let code = search(&index, "harbourmaster");
    assert_eq!(paths(&code), ["tools/run.py"]);
    assert_eq!(code.hits[0].kind, "code");
    let s = &code.hits[0].snippets[0];
    assert_eq!((s.line, s.in_file, s.page), (1, true, None));
    assert!(!code.hits[0].stale);

    let plain = search(&index, "lighthouse");
    assert_eq!(paths(&plain), ["Drawings/Arch.excalidraw"]);
    assert_eq!(plain.hits[0].kind, "drawing");
    assert!(!plain.hits[0].snippets[0].in_file && plain.hits[0].snippets[0].page.is_none());

    // a drawing note: found by the text of its elements, and the compressed data is not text
    let note = search(&index, "hello");
    assert!(
        paths(&note).contains(&"Drawings/Board.excalidraw.md"),
        "{:?}",
        paths(&note)
    );
    assert_eq!(
        note.hits
            .iter()
            .find(|h| h.path.ends_with("Board.excalidraw.md"))
            .unwrap()
            .kind,
        "drawing"
    );
}

#[test]
fn kind_and_ext_narrow_the_results_and_the_chips_do_the_same() {
    let v = fixture();
    let index = v.index();
    index.refresh_blocking().unwrap();
    // `harbour` is in a note and, as a prefix, in a code file
    let all = search(&index, "harbour*");
    assert_eq!(all.hits.len(), 2, "{:?}", paths(&all));
    assert_eq!(
        paths(&search(&index, "harbour* kind:code")),
        ["tools/run.py"]
    );
    assert_eq!(
        paths(&search(&index, "harbour* -kind:code")),
        ["Notes/Plan.md"]
    );
    assert_eq!(
        paths(&search(&index, "harbour* kind:code kind:note")).len(),
        2
    );
    assert_eq!(paths(&search(&index, "harbour* ext:py")), ["tools/run.py"]);
    assert_eq!(
        paths(&search(&index, "harbour* -ext:py")),
        ["Notes/Plan.md"]
    );
    assert_eq!(
        paths(&search(&index, "zebra kind:pdf")),
        ["Papers/Report.pdf"]
    );
    assert!(search(&index, "zebra kind:code").hits.is_empty());
    let chip = |kinds: &[&str]| {
        let opts = SearchOptions {
            kinds: kinds.iter().map(|k| k.to_string()).collect(),
            ..SearchOptions::default()
        };
        index.search("harbour*", &opts).unwrap()
    };
    assert_eq!(paths(&chip(&["note"])), ["Notes/Plan.md"]);
    assert_eq!(chip(&["note", "code"]).hits.len(), 2);
    assert!(chip(&["pdf"]).hits.is_empty());
    // an unknown kind is an explicit error that lists the known ones
    for result in [
        index.search("x kind:spreadsheet", &SearchOptions::default()),
        index.search(
            "x",
            &SearchOptions {
                kinds: vec!["spreadsheet".into()],
                ..SearchOptions::default()
            },
        ),
    ] {
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("spreadsheet") && msg.contains("pdf") && msg.contains("drawing"),
            "{msg}"
        );
    }
}

#[test]
fn a_malformed_pdf_is_listed_by_name_and_never_breaks_indexing() {
    let v = fixture();
    let index = v.index();
    let stats = index.refresh_blocking().unwrap();
    assert!(stats.errors.is_empty(), "{:?}", stats.errors);
    assert_eq!(kind_of(&index, "Papers/Broken.pdf"), "pdf");
    let by_name = search(&index, "broken");
    assert_eq!(paths(&by_name), ["Papers/Broken.pdf"]);
    assert!(by_name.hits[0].snippets.is_empty());
    // the files around it are still searchable
    assert_eq!(paths(&search(&index, "zebra")), ["Papers/Report.pdf"]);
}

#[test]
fn a_secret_named_file_is_never_read_for_content() {
    let v = fixture();
    let index = v.index();
    index.refresh_blocking().unwrap();
    // `credentials.pdf` stays listed by name, its text is not indexed; `secrets.py` is not listed
    assert_eq!(
        paths(&search(&index, "credentials")),
        ["Papers/credentials.pdf"]
    );
    assert!(search(&index, "otter").hits.is_empty());
    assert!(search(&index, "quokka").hits.is_empty());
    assert!(search(&index, "secrets").hits.is_empty());
}

#[test]
fn an_unchanged_file_is_not_extracted_again_and_a_changed_one_is() {
    let v = fixture();
    let index = v.index();
    // opening built the index; a second scan finds every file as it was and reads none
    let again = index.refresh_blocking().unwrap();
    assert_eq!(
        (again.added, again.changed, again.touched),
        (0, 0, 0),
        "{again:?}"
    );
    assert!(again.seen > 5 && again.unchanged == again.seen, "{again:?}");
    // a new PDF in place of the old one: the old words go, the new ones come
    std::thread::sleep(std::time::Duration::from_millis(20));
    v.write(
        "Papers/Report.pdf",
        fixture_pdf(&["Replaced narwhal text"], None),
    );
    let third = index.refresh_blocking().unwrap();
    assert_eq!(third.changed, 1, "{third:?}");
    assert!(search(&index, "zebra").hits.is_empty());
    assert_eq!(paths(&search(&index, "narwhal")), ["Papers/Report.pdf"]);
}

#[test]
fn a_feature_switched_off_drops_its_rows_and_on_brings_them_back() {
    let v = fixture();
    let index = v.index();
    index.refresh_blocking().unwrap();
    assert_eq!(
        paths(&search(&index, "lighthouse")),
        ["Drawings/Arch.excalidraw"]
    );

    let off = Policy {
        features_off: ["excalidraw".to_string(), "bases".to_string()].into(),
        ..Policy::default()
    };
    *index.shared.policy_override.lock() = Some(off);
    index.refresh_blocking().unwrap();
    assert!(search(&index, "lighthouse").hits.is_empty());
    assert_eq!(kind_of(&index, "Drawings/Arch.excalidraw"), "");
    // the drawing note falls back to a plain note; the base is no longer listed
    assert_eq!(kind_of(&index, "Drawings/Board.excalidraw.md"), "note");
    assert_eq!(kind_of(&index, "tasks.base"), "");
    // the rest is untouched
    assert_eq!(paths(&search(&index, "zebra")), ["Papers/Report.pdf"]);

    *index.shared.policy_override.lock() = None;
    index.refresh_blocking().unwrap();
    assert_eq!(
        paths(&search(&index, "lighthouse")),
        ["Drawings/Arch.excalidraw"]
    );
    assert_eq!(kind_of(&index, "Drawings/Board.excalidraw.md"), "drawing");
    assert_eq!(kind_of(&index, "tasks.base"), "base");
}

#[test]
fn code_files_and_pdfs_follow_their_own_switches() {
    let v = fixture();
    let index = v.index();
    index.refresh_blocking().unwrap();
    assert!(!search(&index, "harbourmaster").hits.is_empty());
    *index.shared.policy_override.lock() = Some(Policy {
        show_pdfs: false,
        ..Policy::notes_only()
    });
    index.refresh_blocking().unwrap();
    assert!(search(&index, "harbourmaster").hits.is_empty());
    assert!(search(&index, "zebra").hits.is_empty());
    assert!(search(&index, "broken").hits.is_empty());
    assert!(!search(&index, "harbour").hits.is_empty(), "notes stay");
}

#[test]
fn one_ranked_list_mixes_kinds_by_the_same_weights() {
    let v = V::new();
    v.write(
        "Notes/Misc.md",
        "Passing mention of the walrus among other words.\n",
    );
    v.write("Papers/walrus.pdf", fixture_pdf(&["unrelated text"], None));
    v.write("tools/walrus.py", "x = 1\n");
    let index = v.index();
    index.refresh_blocking().unwrap();
    let page = search(&index, "walrus");
    assert_eq!(page.hits.len(), 3, "{:?}", paths(&page));
    // a file named for the word outranks a passing mention in a body, whatever the kind
    assert_eq!(page.hits.last().unwrap().path, "Notes/Misc.md");
    let kinds: Vec<&str> = page.hits.iter().map(|h| h.kind.as_str()).collect();
    assert!(kinds.contains(&"pdf") && kinds.contains(&"code") && kinds.contains(&"note"));
}

#[test]
fn names_only_kinds_are_found_by_name_through_the_fuzzy_pass() {
    let v = fixture();
    let index = v.index();
    index.refresh_blocking().unwrap();
    let opts = SearchOptions {
        fuzzy: true,
        ..SearchOptions::default()
    };
    let page = index.search("logo", &opts).unwrap();
    let hit = page
        .hits
        .iter()
        .find(|h| h.path == "logo.png")
        .expect("the image is found");
    assert_eq!((hit.kind.as_str(), hit.fuzzy), ("image", true));
    let base = index.search("tasks", &opts).unwrap();
    assert!(base
        .hits
        .iter()
        .any(|h| h.path == "tasks.base" && h.kind == "base"));
}

#[test]
fn stored_text_goes_with_its_file() {
    let v = fixture();
    let index = v.index();
    index.refresh_blocking().unwrap();
    let count = |index: &Index| -> i64 {
        index
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM file_text", [], |r| r.get(0))?))
            .unwrap()
    };
    // the PDF and the two drawings keep their text; code reads the file (no second copy), notes too
    assert_eq!(count(&index), 3);
    fs::remove_file(v.vault.path().join("Papers/Report.pdf")).unwrap();
    index.refresh_blocking().unwrap();
    assert_eq!(count(&index), 2);
}

#[test]
fn the_search_kinds_list_comes_from_the_registry_under_the_policy() {
    let ids = |p: &Policy| -> Vec<&'static str> { kinds::listed(p).iter().map(|k| k.id).collect() };
    let all = ids(&Policy::default());
    for k in ["note", "image", "base", "code", "drawing", "pdf"] {
        assert!(all.contains(&k), "{k}");
    }
    let off = Policy {
        features_off: ["excalidraw".to_string()].into(),
        show_images: false,
        ..Policy::default()
    };
    let some = ids(&off);
    assert!(!some.contains(&"drawing") && !some.contains(&"image") && some.contains(&"pdf"));
}

#[test]
fn a_feature_off_only_skips_its_kinds_content_and_on_reads_it_again() {
    let v = fixture();
    let index = v.index();
    index.refresh_blocking().unwrap();
    let stored = |index: &Index| -> i64 {
        index
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM file_text", [], |r| r.get(0))?))
            .unwrap()
    };
    assert_eq!(paths(&search(&index, "zebra")), ["Papers/Report.pdf"]);
    let with_pdf = stored(&index);

    // the pdf feature off: the PDF stays listed (files.show-pdfs), its text goes from FTS and file_text
    *index.shared.policy_override.lock() = Some(Policy {
        features_off: ["pdf".to_string()].into(),
        ..Policy::default()
    });
    index.refresh_blocking().unwrap();
    assert!(search(&index, "zebra").hits.is_empty());
    assert!(search(&index, "marmot").hits.is_empty());
    assert_eq!(kind_of(&index, "Papers/Report.pdf"), "pdf");
    assert_eq!(stored(&index), with_pdf - 1);
    // the other kinds keep their content
    assert_eq!(
        paths(&search(&index, "lighthouse")),
        ["Drawings/Arch.excalidraw"]
    );
    assert!(!search(&index, "harbourmaster").hits.is_empty());

    // back on: the text is extracted again
    *index.shared.policy_override.lock() = None;
    index.refresh_blocking().unwrap();
    assert_eq!(paths(&search(&index, "zebra")), ["Papers/Report.pdf"]);
    assert_eq!(search(&index, "marmot").hits[0].snippets[0].page, Some(2));
    assert_eq!(stored(&index), with_pdf);
}

fn drawing_with_links(links: &[&str]) -> serde_json::Value {
    let els: Vec<_> = links
        .iter()
        .enumerate()
        .map(|(i, l)| {
            serde_json::json!({
                "id": format!("box{i:05}"), "type": "rectangle", "isDeleted": false, "link": l
            })
        })
        .collect();
    serde_json::json!({"type": "excalidraw", "version": 2, "appState": {}, "files": {}, "elements": els})
}

/// A drawing note whose data is plain JSON, with `section` as the text of `## Element Links`.
fn drawing_note(scene: &serde_json::Value, section: &str) -> String {
    format!(
        "---\n\nexcalidraw-plugin: parsed\n\n---\n# Excalidraw Data\n\n## Text Elements\n{section}%%\n## Drawing\n```json\n{scene}\n```\n%%\n"
    )
}

#[test]
fn the_links_on_a_drawings_elements_are_links_of_the_drawing() {
    let v = V::new();
    v.write("Notes/Plan.md", "# Plan\n");
    v.write(
        "D/Plain.excalidraw",
        drawing_with_links(&["[[Plan]]", "[[Missing Note]]", ""]).to_string(),
    );
    // a drawing note without the plugin's section, and one with it: counted once each
    v.write(
        "D/Bare.excalidraw.md",
        drawing_note(&drawing_with_links(&["[[Plan|the plan]]"]), ""),
    );
    v.write(
        "D/Listed.excalidraw.md",
        drawing_note(
            &drawing_with_links(&["[[Plan]]"]),
            "## Element Links\nbox00000: [[Plan]]\n\n",
        ),
    );
    let index = v.index();
    index.refresh_blocking().unwrap();
    let sources = |index: &Index| -> Vec<String> {
        index
            .backlinks("Notes/Plan.md")
            .unwrap()
            .into_iter()
            .map(|b| b.source)
            .collect()
    };
    assert_eq!(
        sources(&index),
        [
            "D/Bare.excalidraw.md",
            "D/Listed.excalidraw.md",
            "D/Plain.excalidraw"
        ]
    );
    let unresolved = index.unresolved().unwrap();
    assert!(
        unresolved
            .iter()
            .any(|u| u.target == "Missing Note"
                && u.sources.contains(&"D/Plain.excalidraw".to_string())),
        "{unresolved:?}"
    );
    // outgoing links of the plain drawing, in order, and nothing for the empty link
    let out: Vec<String> = index
        .links("D/Plain.excalidraw")
        .unwrap()
        .into_iter()
        .map(|l| l.raw)
        .collect();
    assert_eq!(out, ["Plan", "Missing Note"]);

    // an edit that drops the link drops the edge; a new one adds it
    v.write(
        "D/Plain.excalidraw",
        drawing_with_links(&["[[Other]]"]).to_string(),
    );
    v.write("Notes/Other.md", "# Other\n");
    index.refresh_blocking().unwrap();
    assert_eq!(
        sources(&index),
        ["D/Bare.excalidraw.md", "D/Listed.excalidraw.md"]
    );
    let other: Vec<String> = index
        .backlinks("Notes/Other.md")
        .unwrap()
        .into_iter()
        .map(|b| b.source)
        .collect();
    assert_eq!(other, ["D/Plain.excalidraw"]);
}
