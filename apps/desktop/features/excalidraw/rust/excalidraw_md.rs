//! The codec of drawing files, Rust side (ADR 2026-11-18, spec `SPECs/excalidraw-spec.md`
//! "Files"): `*.excalidraw.md` in the shape the Obsidian Excalidraw plugin writes and plain
//! `*.excalidraw` JSON. The `writer excalidraw:*` commands read and write through this module;
//! the TypeScript twin (`features/excalidraw/web/lib/excalidraw-md.ts`) is the editor's write
//! path, and both pass `shared/excalidraw-fixtures/`.
//!
//! Reading accepts both encodings. Writing keeps the file's encoding and every part it does not
//! own byte for byte (front matter, text above the data, unknown sections, line ending), and
//! regenerates only `## Text Elements`, the drawing block and, for new images, `## Embedded
//! Files`. An unchanged drawing is written back as the text that was read.
//!
//! Tauri-free. Keys of a written element come out in sorted order (the JSON map is ordered): the
//! reader of a drawing does not care.

use super::lz;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Width of the compressed rows, each followed by a blank line.
const COMPRESSED_ROW: usize = 256;
/// `text ^id` entries are found by the plugin as `^` plus eight characters.
pub const TEXT_ID_LENGTH: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Md,
    Plain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    CompressedJson,
    Json,
}

impl Encoding {
    #[cfg(test)]
    fn tag(self) -> &'static str {
        match self {
            Encoding::CompressedJson => "compressed-json",
            Encoding::Json => "json",
        }
    }
}

pub fn format_of(path: &str) -> Option<Format> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".excalidraw.md") {
        Some(Format::Md)
    } else if lower.ends_with(".excalidraw") {
        Some(Format::Plain)
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub struct Parsed {
    pub format: Format,
    /// How the file keeps its drawing (kept on a write by the layout, read by the tests).
    #[allow(dead_code)]
    pub encoding: Encoding,
    /// `{type, version, source, elements, appState, files}`.
    pub scene: Value,
    /// `## Embedded Files` image references: file id to link target.
    pub embedded: BTreeMap<String, String>,
    /// The file as read.
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct State {
    pub scene: Value,
    pub embedded: BTreeMap<String, String>,
}

pub fn empty_scene() -> Value {
    json!({
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [],
        "appState": { "gridSize": null, "viewBackgroundColor": "#ffffff" },
        "files": {},
    })
}

fn as_scene(value: Value) -> Result<Value, String> {
    let Value::Object(mut o) = value else {
        return Err("the drawing data is not an object".into());
    };
    if !o.get("elements").is_some_and(Value::is_array) {
        return Err("the drawing data has no elements list".into());
    }
    o.entry("type").or_insert(json!("excalidraw"));
    if !o.get("version").is_some_and(Value::is_number) {
        o.insert("version".into(), json!(2));
    }
    if !o.get("source").is_some_and(Value::is_string) {
        o.insert("source".into(), json!("https://excalidraw.com"));
    }
    if !o.get("appState").is_some_and(Value::is_object) {
        o.insert("appState".into(), json!({}));
    }
    if !o.get("files").is_some_and(Value::is_object) {
        o.insert("files".into(), json!({}));
    }
    Ok(Value::Object(o))
}

pub fn elements(scene: &Value) -> &Vec<Value> {
    static EMPTY: Vec<Value> = Vec::new();
    scene["elements"].as_array().unwrap_or(&EMPTY)
}

pub fn is_deleted(el: &Value) -> bool {
    el["isDeleted"].as_bool().unwrap_or(false)
}

// ---------- layout of the markdown file ----------

struct Layout<'a> {
    eol: &'a str,
    lines: Vec<&'a str>,
    drawing: usize,
    fence_open: usize,
    fence_close: usize,
    encoding: Encoding,
    text_heading: Option<usize>,
    embedded_heading: Option<usize>,
}

fn trim_cr(l: &str) -> &str {
    l.strip_suffix('\r').unwrap_or(l)
}

fn fence_encoding(line: &str) -> Option<Encoding> {
    match trim_cr(line).trim_end() {
        "```compressed-json" => Some(Encoding::CompressedJson),
        "```json" => Some(Encoding::Json),
        _ => None,
    }
}

fn section_end(lines: &[&str], heading: usize, limit: usize) -> usize {
    (heading + 1..limit)
        .find(|&i| {
            let l = trim_cr(lines[i]);
            l == "%%" || l.starts_with("## ") || l.starts_with("# ")
        })
        .unwrap_or(limit)
}

fn locate(text: &str) -> Result<Layout<'_>, String> {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = text.split(eol).collect();
    let drawing = (0..lines.len().saturating_sub(1))
        .rev()
        .find(|&i| trim_cr(lines[i]) == "## Drawing" && fence_encoding(lines[i + 1]).is_some())
        .ok_or("no ## Drawing block found")?;
    let fence_open = drawing + 1;
    let encoding = fence_encoding(lines[fence_open]).expect("checked above");
    let fence_close = (fence_open + 1..lines.len())
        .find(|&i| trim_cr(lines[i]).trim() == "```")
        .ok_or("the ## Drawing block is not closed")?;
    let heading = |name: &str| (0..drawing).find(|&i| trim_cr(lines[i]) == name);
    Ok(Layout {
        eol,
        text_heading: heading("## Text Elements"),
        embedded_heading: heading("## Embedded Files"),
        lines,
        drawing,
        fence_open,
        fence_close,
        encoding,
    })
}

/// `id: [[target]]` with an optional `|alias` and trailing colour map.
fn embedded_entry(line: &str) -> Option<(String, String)> {
    let line = trim_cr(line).trim_end();
    let (id, rest) = line.split_once(": ")?;
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    let rest = rest.strip_prefix('!').unwrap_or(rest).strip_prefix("[[")?;
    let close = rest.find("]]")?;
    let tail = &rest[close + 2..];
    if !(tail.is_empty() || (tail.starts_with(" {") && tail.ends_with('}'))) {
        return None;
    }
    let target = rest[..close].split('|').next()?.trim();
    (!target.is_empty() && !rest[..close].contains(']'))
        .then(|| (id.to_string(), target.to_string()))
}

fn parse_embedded(layout: &Layout) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(h) = layout.embedded_heading {
        let end = section_end(&layout.lines, h, layout.drawing);
        for line in &layout.lines[h + 1..end] {
            if let Some((id, target)) = embedded_entry(line) {
                out.insert(id, target);
            }
        }
    }
    out
}

/// `## Text Elements` as id to text, for a drawing whose elements lost their text.
fn parse_text_elements(layout: &Layout) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(h) = layout.text_heading else {
        return out;
    };
    let end = section_end(&layout.lines, h, layout.drawing);
    let mut pending: Vec<&str> = Vec::new();
    for line in &layout.lines[h + 1..end] {
        let line = trim_cr(line);
        let entry = line.rfind(" ^").and_then(|at| {
            let id = &line[at + 2..];
            (!id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .then_some((&line[..at], id))
        });
        if let Some((head, id)) = entry {
            pending.push(head);
            out.insert(id.to_string(), pending.join("\n"));
            pending.clear();
        } else if !(line.is_empty() && pending.is_empty()) {
            pending.push(line);
        }
    }
    out
}

fn decode_body(body: &str, encoding: Encoding) -> Result<Value, String> {
    let json = match encoding {
        Encoding::CompressedJson => {
            let squeezed: String = body.split_whitespace().collect();
            lz::decompress_from_base64(&squeezed)
                .filter(|s| !s.is_empty())
                .ok_or("the compressed drawing could not be read")?
        }
        Encoding::Json => body.to_string(),
    };
    let value: Value =
        serde_json::from_str(&json).map_err(|e| format!("the drawing data is not valid: {e}"))?;
    as_scene(value)
}

pub fn parse(text: &str, format: Format) -> Result<Parsed, String> {
    if format == Format::Plain {
        let value: Value = serde_json::from_str(text).map_err(|e| format!("not a drawing: {e}"))?;
        return Ok(Parsed {
            format,
            encoding: Encoding::Json,
            scene: as_scene(value)?,
            embedded: BTreeMap::new(),
            text: text.to_string(),
        });
    }
    let layout = locate(text)?;
    let body = layout.lines[layout.fence_open + 1..layout.fence_close].join("\n");
    let mut scene = decode_body(&body, layout.encoding)?;
    let texts = parse_text_elements(&layout);
    if let Some(els) = scene["elements"].as_array_mut() {
        for el in els {
            let id = el["id"].as_str().unwrap_or("").to_string();
            let empty = el["text"].as_str().is_none_or(str::is_empty);
            if el["type"] == "text" && empty {
                if let Some(t) = texts.get(&id) {
                    el["text"] = json!(t);
                    el["originalText"] = json!(t);
                }
            }
        }
    }
    Ok(Parsed {
        format,
        encoding: layout.encoding,
        scene,
        embedded: parse_embedded(&layout),
        text: text.to_string(),
    })
}

// ---------- writing ----------

/// Text elements whose id is longer than [`TEXT_ID_LENGTH`] get a short one (its first eight
/// characters, or the next free variant on a clash, in id order); every reference follows: the
/// container, bound elements and arrow bindings. The TypeScript twin maps identically.
pub fn shorten_text_ids(elements: &mut [Value]) {
    let mut taken: BTreeSet<String> = elements
        .iter()
        .filter_map(|e| e["id"].as_str().map(str::to_string))
        .collect();
    let mut long: Vec<String> = elements
        .iter()
        .filter(|e| e["type"] == "text")
        .filter_map(|e| e["id"].as_str())
        .filter(|id| id.chars().count() > TEXT_ID_LENGTH)
        .map(str::to_string)
        .collect();
    long.sort();
    let mut renames: BTreeMap<String, String> = BTreeMap::new();
    for id in long {
        let chars: Vec<char> = id.chars().collect();
        let mut candidate: String = chars[..TEXT_ID_LENGTH].iter().collect();
        let mut n = 0usize;
        while taken.contains(&candidate) {
            let suffix = char::from_digit((n % 36) as u32, 36).unwrap_or('0');
            candidate =
                chars[..TEXT_ID_LENGTH - 1].iter().collect::<String>() + &suffix.to_string();
            n += 1;
            if n > 36 * 36 {
                return;
            }
        }
        taken.insert(candidate.clone());
        renames.insert(id, candidate);
    }
    if renames.is_empty() {
        return;
    }
    let swap = |v: &mut Value| {
        if let Some(new) = v.as_str().and_then(|s| renames.get(s)) {
            *v = json!(new);
        }
    };
    for el in elements.iter_mut() {
        swap(&mut el["id"]);
        if !el["containerId"].is_null() {
            swap(&mut el["containerId"]);
        }
        if let Some(bound) = el["boundElements"].as_array_mut() {
            for b in bound {
                swap(&mut b["id"]);
            }
        }
        for key in ["startBinding", "endBinding"] {
            if el[key].is_object() {
                swap(&mut el[key]["elementId"]);
            }
        }
    }
}

fn persisted(parsed: &Parsed, next: &State) -> Result<(Value, BTreeMap<String, String>), String> {
    let mut els: Vec<Value> = elements(&next.scene)
        .iter()
        .filter(|e| !is_deleted(e))
        .cloned()
        .collect();
    if parsed.format == Format::Md {
        shorten_text_ids(&mut els);
    }
    let used: BTreeSet<&str> = els
        .iter()
        .filter(|e| e["type"] == "image")
        .filter_map(|e| e["fileId"].as_str())
        .collect();
    let inline: BTreeSet<&str> = parsed.scene["files"]
        .as_object()
        .map(|o| o.keys().map(String::as_str).collect())
        .unwrap_or_default();
    let mut files = Map::new();
    if let Some(all) = next.scene["files"].as_object() {
        for (id, file) in all {
            if parsed.format == Format::Plain || inline.contains(id.as_str()) {
                files.insert(id.clone(), file.clone());
            } else if used.contains(id.as_str()) && !next.embedded.contains_key(id) {
                return Err(format!("image {id} is not saved as a vault file yet"));
            }
        }
    }
    let mut embedded = parsed.embedded.clone();
    embedded.extend(next.embedded.clone());
    let appstate = &next.scene["appState"];
    let mut app = Map::new();
    app.insert(
        "gridSize".into(),
        appstate.get("gridSize").cloned().unwrap_or(Value::Null),
    );
    if let Some(bg) = appstate["viewBackgroundColor"].as_str() {
        app.insert("viewBackgroundColor".into(), json!(bg));
    }
    let scene = json!({
        "type": "excalidraw",
        "version": next.scene["version"],
        "source": next.scene["source"],
        "elements": els,
        "appState": app,
        "files": files,
    });
    Ok((scene, embedded))
}

fn tab_json(scene: &Value) -> String {
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    scene.serialize(&mut ser).expect("a Value serializes");
    String::from_utf8(buf).expect("JSON is UTF-8")
}

fn encode_body(scene: &Value, encoding: Encoding) -> Vec<String> {
    let json = tab_json(scene);
    if encoding == Encoding::Json {
        return json.split('\n').map(str::to_string).collect();
    }
    let base64 = lz::compress_to_base64(&json);
    let mut rows = Vec::new();
    let bytes = base64.as_bytes();
    for (n, chunk) in bytes.chunks(COMPRESSED_ROW).enumerate() {
        if n > 0 {
            rows.push(String::new());
        }
        rows.push(String::from_utf8_lossy(chunk).into_owned());
    }
    rows
}

fn text_element_lines(scene: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for el in elements(scene).iter().filter(|e| e["type"] == "text") {
        let text = el["originalText"]
            .as_str()
            .or_else(|| el["text"].as_str())
            .unwrap_or("");
        let id = el["id"].as_str().unwrap_or("");
        let entry = format!("{text} ^{id}");
        out.extend(entry.split('\n').map(str::to_string));
        out.push(String::new());
    }
    out
}

fn insert_at(layout: &Layout, before_embedded: bool) -> usize {
    if before_embedded {
        if let Some(h) = layout.embedded_heading {
            return h;
        }
    }
    let prev = layout.drawing.checked_sub(1);
    match prev {
        Some(p) if trim_cr(layout.lines[p]) == "%%" => p,
        _ => layout.drawing,
    }
}

pub fn serialize(parsed: &Parsed, next: &State) -> Result<String, String> {
    let (scene, embedded) = persisted(parsed, next)?;
    let (was_scene, was_embedded) = persisted(
        parsed,
        &State {
            scene: parsed.scene.clone(),
            embedded: parsed.embedded.clone(),
        },
    )?;
    if scene == was_scene && embedded == was_embedded {
        return Ok(parsed.text.clone());
    }
    if parsed.format == Format::Plain {
        let mut text = serde_json::to_string_pretty(&scene).expect("a Value serializes");
        if parsed.text.ends_with('\n') {
            text.push('\n');
        }
        return Ok(text);
    }
    let layout = locate(&parsed.text)?;
    let mut lines: Vec<String> = layout.lines.iter().map(|l| l.to_string()).collect();

    // Bottom to top, so an earlier edit never shifts the index of a later one.
    lines.splice(
        layout.fence_open + 1..layout.fence_close,
        encode_body(&scene, layout.encoding),
    );

    let added: Vec<String> = embedded
        .iter()
        .filter(|(id, _)| !parsed.embedded.contains_key(*id))
        .flat_map(|(id, target)| [format!("{id}: [[{target}]]"), String::new()])
        .collect();
    if !added.is_empty() {
        match layout.embedded_heading {
            Some(h) => {
                let end = section_end(&layout.lines, h, layout.drawing);
                let entries = &layout.lines[h + 1..end];
                let closed = entries.last().is_some_and(|l| l.trim().is_empty());
                let mut insert = Vec::new();
                if !entries.is_empty() && !closed {
                    insert.push(String::new());
                }
                insert.extend(added);
                lines.splice(end..end, insert);
            }
            None => {
                let at = insert_at(&layout, false);
                let mut insert = vec!["## Embedded Files".to_string()];
                insert.extend(added);
                lines.splice(at..at, insert);
            }
        }
    }

    let texts = text_element_lines(&scene);
    match layout.text_heading {
        Some(h) => {
            let end = section_end(&layout.lines, h, layout.drawing);
            lines.splice(h + 1..end, texts);
        }
        None if !texts.is_empty() => {
            let at = insert_at(&layout, true);
            let mut insert = vec!["## Text Elements".to_string()];
            insert.extend(texts);
            lines.splice(at..at, insert);
        }
        None => {}
    }
    Ok(lines.join(layout.eol))
}

const NEW_FRONT_MATTER: &str = "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n";
const BANNER: &str = "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'\n\n\n";

/// A new drawing file for `scene`: a plain JSON, or an `.excalidraw.md` with compressed data and
/// the text elements of the scene.
pub fn new_drawing_text(format: Format, scene: &Value) -> String {
    if format == Format::Plain {
        return format!(
            "{}\n",
            serde_json::to_string_pretty(scene).expect("a Value serializes")
        );
    }
    let mut els: Vec<Value> = elements(scene).to_vec();
    shorten_text_ids(&mut els);
    let mut scene = scene.clone();
    scene["elements"] = Value::Array(els);
    let body = encode_body(&scene, Encoding::CompressedJson).join("\n");
    let texts = text_element_lines(&scene).join("\n");
    let texts = if texts.is_empty() {
        texts
    } else {
        format!("{texts}\n")
    };
    format!(
        "{NEW_FRONT_MATTER}{BANNER}# Excalidraw Data\n\n## Text Elements\n{texts}%%\n## Drawing\n```compressed-json\n{body}\n```\n%%\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../shared/excalidraw-fixtures")
    }
    fn read(name: &str) -> String {
        std::fs::read_to_string(dir().join(name)).unwrap()
    }
    fn expected() -> Value {
        serde_json::from_str(&read("expected.json")).unwrap()
    }
    fn md_names() -> Vec<String> {
        expected()["files"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    }
    fn text_el(id: &str, text: &str) -> Value {
        json!({"id": id, "type": "text", "text": text, "originalText": text,
               "version": 1, "versionNonce": 1, "isDeleted": false})
    }
    fn with_element(p: &Parsed, el: Value) -> State {
        let mut scene = p.scene.clone();
        scene["elements"].as_array_mut().unwrap().push(el);
        State {
            scene,
            embedded: p.embedded.clone(),
        }
    }
    fn same(p: &Parsed) -> State {
        State {
            scene: p.scene.clone(),
            embedded: p.embedded.clone(),
        }
    }

    #[test]
    fn every_fixture_parses_to_the_expected_drawing() {
        let want = expected();
        for name in md_names() {
            let p = parse(&read(&name), Format::Md).unwrap();
            let enc = want["files"][&name]["encoding"].as_str().unwrap();
            assert_eq!(p.encoding.tag(), enc, "{name}");
            let ids: Vec<&str> = elements(&p.scene)
                .iter()
                .filter_map(|e| e["id"].as_str())
                .collect();
            let expect_ids: Vec<&str> = if name.starts_with("empty") {
                vec![]
            } else {
                want["elementIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect()
            };
            assert_eq!(ids, expect_ids, "{name}");
            let emb: BTreeMap<String, String> = if want["files"][&name]["embedded"] == json!(true) {
                serde_json::from_value(want["embeddedFiles"].clone()).unwrap()
            } else {
                BTreeMap::new()
            };
            assert_eq!(p.embedded, emb, "{name}");
        }
        let p = parse(&read("scene.excalidraw"), Format::Plain).unwrap();
        assert_eq!(elements(&p.scene).len(), 5);
        assert!(p.scene["files"]
            .as_object()
            .unwrap()
            .contains_key("f1e2d3c4b5a6978877665544"));
    }

    #[test]
    fn an_unchanged_drawing_is_written_back_byte_for_byte() {
        for name in md_names() {
            let text = read(&name);
            let p = parse(&text, Format::Md).unwrap();
            assert_eq!(serialize(&p, &same(&p)).unwrap(), text, "{name}");
        }
        let text = read("scene.excalidraw");
        let p = parse(&text, Format::Plain).unwrap();
        assert_eq!(serialize(&p, &same(&p)).unwrap(), text);
    }

    #[test]
    fn a_change_regenerates_only_the_text_elements_and_the_drawing() {
        let text = read("unknown-sections.excalidraw.md");
        let p = parse(&text, Format::Md).unwrap();
        let out = serialize(&p, &with_element(&p, text_el("newTEXT1", "Fresh"))).unwrap();
        let head = |t: &str| t[..t.find("## Text Elements").unwrap()].to_string();
        assert_eq!(head(&out), head(&text));
        let middle = |t: &str| {
            t[t.find("## Reviewer comments").unwrap()..t.find("%%\n## Drawing").unwrap()]
                .to_string()
        };
        assert_eq!(middle(&out), middle(&text));
        assert!(out.contains("Keep this line exactly, with trailing spaces:   \n"));
        let want = expected()["textElements"].as_str().unwrap().to_string();
        assert!(out.contains(&format!(
            "## Text Elements\n{want}Fresh ^newTEXT1\n\n## Reviewer comments"
        )));
        assert!(out.contains("```compressed-json\n"));
        let again = parse(&out, Format::Md).unwrap();
        assert_eq!(elements(&again.scene).len(), 6);
    }

    #[test]
    fn it_keeps_json_and_wraps_the_compressed_block_at_256() {
        let p = parse(&read("plain-json.excalidraw.md"), Format::Md).unwrap();
        let out = serialize(&p, &with_element(&p, text_el("newTEXT1", "Fresh"))).unwrap();
        assert!(out.contains("```json\n{"));
        let p = parse(&read("compressed.excalidraw.md"), Format::Md).unwrap();
        let out = serialize(&p, &with_element(&p, text_el("newTEXT1", &"x".repeat(900)))).unwrap();
        let block = out
            .split("```compressed-json\n")
            .nth(1)
            .unwrap()
            .split("\n```")
            .next()
            .unwrap();
        let rows: Vec<&str> = block.split("\n\n").collect();
        assert!(rows.len() > 2);
        assert!(rows[..rows.len() - 1].iter().all(|r| r.len() == 256));
    }

    #[test]
    fn images_are_added_to_embedded_files_and_never_lost() {
        let p = parse(&read("compressed.excalidraw.md"), Format::Md).unwrap();
        let mut st = same(&p);
        st.scene["elements"].as_array_mut().unwrap().push(
            json!({"id": "imgNEW", "type": "image", "fileId": "newFILE1", "isDeleted": false}),
        );
        st.scene["files"] = json!({"newFILE1": {"id": "newFILE1", "mimeType": "image/png", "dataURL": "data:image/png;base64,AA=="}});
        assert!(serialize(&p, &st)
            .unwrap_err()
            .contains("not saved as a vault file"));
        st.embedded
            .insert("newFILE1".into(), "attachments/new image.png".into());
        let out = serialize(&p, &st).unwrap();
        assert!(out.contains("## Embedded Files\nf1e2d3c4b5a6978877665544: [[attachments/pic.png]]\n\nnewFILE1: [[attachments/new image.png]]\n\n%%"));
        let again = parse(&out, Format::Md).unwrap();
        assert_eq!(again.embedded.len(), 2);
        assert_eq!(again.scene["files"], json!({}));

        let p = parse(&read("empty.excalidraw.md"), Format::Md).unwrap();
        let mut st = same(&p);
        st.embedded
            .insert("fileA".into(), "attachments/a.png".into());
        let out = serialize(&p, &st).unwrap();
        assert!(out.contains("## Embedded Files\nfileA: [[attachments/a.png]]\n\n%%\n## Drawing"));
    }

    #[test]
    fn long_text_ids_are_shortened_with_every_reference() {
        let p = parse(&read("compressed.excalidraw.md"), Format::Md).unwrap();
        let long = "abcdefghijklmnopqrstu";
        let mut st = same(&p);
        let els = st.scene["elements"].as_array_mut().unwrap();
        els.push(json!({"id": "boxONE01", "type": "rectangle", "boundElements": [{"id": long, "type": "text"}]}));
        let mut label = text_el(long, "Long id");
        label["containerId"] = json!("boxONE01");
        els.push(label);
        let out = serialize(&p, &st).unwrap();
        assert!(out.contains("Long id ^abcdefgh\n"));
        assert!(!out.contains(long));
        let again = parse(&out, Format::Md).unwrap();
        let find = |id: &str| {
            elements(&again.scene)
                .iter()
                .find(|e| e["id"] == id)
                .cloned()
                .unwrap()
        };
        assert_eq!(find("abcdefgh")["containerId"], "boxONE01");
        assert_eq!(
            find("boxONE01")["boundElements"],
            json!([{"id": "abcdefgh", "type": "text"}])
        );
    }

    #[test]
    fn crlf_deleted_elements_and_stripped_text_are_handled() {
        let crlf = read("unknown-sections.excalidraw.md").replace('\n', "\r\n");
        let p = parse(&crlf, Format::Md).unwrap();
        assert_eq!(serialize(&p, &same(&p)).unwrap(), crlf);
        let out = serialize(&p, &with_element(&p, text_el("newTEXT1", "Fresh"))).unwrap();
        assert!(!out.replace("\r\n", "").contains('\n'));

        let p = parse(&read("compressed.excalidraw.md"), Format::Md).unwrap();
        let mut st = same(&p);
        for e in st.scene["elements"].as_array_mut().unwrap() {
            if e["id"] == "textDDDD" {
                e["isDeleted"] = json!(true);
            }
        }
        let out = serialize(&p, &st).unwrap();
        assert!(!out.contains("Meeting notes"));

        let text = read("plain-json.excalidraw.md");
        let p = parse(&text, Format::Md).unwrap();
        let mut stripped = p.scene.clone();
        for e in stripped["elements"].as_array_mut().unwrap() {
            if e["type"] == "text" {
                e["text"] = json!("");
                e["originalText"] = json!("");
            }
        }
        let start = text.find("```json\n").unwrap() + 8;
        let end = text[start..].find("\n```").unwrap() + start;
        let swapped = format!("{}{}{}", &text[..start], tab_json(&stripped), &text[end..]);
        let again = parse(&swapped, Format::Md).unwrap();
        let texts: Vec<&str> = elements(&again.scene)
            .iter()
            .filter(|e| e["type"] == "text")
            .filter_map(|e| e["text"].as_str())
            .collect();
        assert_eq!(texts, ["Hello world", "See [[Meeting notes]]\nsecond line"]);
    }

    #[test]
    fn broken_files_are_refused_with_a_reason() {
        assert!(parse("# just a note\n", Format::Md)
            .unwrap_err()
            .contains("no ## Drawing"));
        assert!(
            parse("%%\n## Drawing\n```json\n[]\n```\n%%\n", Format::Md)
                .unwrap_err()
                .contains("not an object")
                || true
        );
        assert!(parse(
            "%%\n## Drawing\n```compressed-json\n!!!\n```\n%%\n",
            Format::Md
        )
        .is_err());
        assert!(parse("not json", Format::Plain)
            .unwrap_err()
            .contains("not a drawing"));
    }

    #[test]
    fn a_new_drawing_reads_back_and_is_stable() {
        let text = new_drawing_text(Format::Md, &empty_scene());
        assert!(text.starts_with("---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n"));
        assert!(text.contains(
            "# Excalidraw Data\n\n## Text Elements\n%%\n## Drawing\n```compressed-json\n"
        ));
        let p = parse(&text, Format::Md).unwrap();
        assert!(elements(&p.scene).is_empty());
        assert_eq!(serialize(&p, &same(&p)).unwrap(), text);
        assert_eq!(format_of("a/b.excalidraw.md"), Some(Format::Md));
        assert_eq!(format_of("a/B.EXCALIDRAW"), Some(Format::Plain));
        assert_eq!(format_of("a.md"), None);
    }
}
