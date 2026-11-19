//! The `writer excalidraw:*` commands (ADR 2026-11-18, point 7): `create`, `add`, `update`,
//! `read` and `lint` work on the files with the app closed, through the codec and `vault_ops`
//! confinement (the one write path of the CLI); `export` and `preview` ask the running app over
//! the socket (`ipc.rs`). Declared here, tagged with the feature so the CLI's one gate answers "turned
//! off" while `features.excalidraw.enabled` is false.

use super::elements::{self, Gen, SpecError};
use super::excalidraw_md::{self as md, Format, State};
use super::lint;
use crate::cli::args::Args;
use crate::cli::cmd_app;
use crate::cli::registry::{cmd, p, pj, req, reqj, CommandSpec, FILE, NO_FLAGS, NO_FORMATS, PATH};
use crate::cli::{CliError, Ctx, Target};
use crate::vault_ops;
use serde_json::{json, Map};

const FEATURE: Option<&str> = Some("excalidraw");
const GROUP: &str = "Excalidraw";

const UPDATE_HELP: &str = "JSON, or @<vault file>, or - for stdin: {\"nodes\":[{\"id\",\"text\"?,\"x\"?,\"y\"?,\"w\"?,\"h\"?,\"color\"?,\"fill\"?,\"stroke\"?,\"fontSize\"?,\"strokeStyle\"?,\"link\"?}],\"edges\":[[\"from\",\"to\",\"label\"?] or {\"from\",\"to\",\"label\"?,\"style\"?,\"color\"?,\"bidirectional\"?,\"labelAt\"?,\"fromSide\"?,\"toSide\"?,\"route\"?}],\"zones\":[{\"id\",\"label\"?,\"nodes\"?,\"color\"?,\"padding\"?}],\"remove\":{\"nodes\":[ids],\"edges\":[[\"from\",\"to\"]],\"zones\":[ids]}}";

const SPEC_HELP: &str = "JSON, or @<vault file>, or - for stdin: {\"nodes\":[\"id\",\"text\"?,\"shape\"?,\"x\"?,\"y\"?,\"w\"?,\"h\"?,\"color\"?,\"fill\"?,\"stroke\"?,\"fontSize\"?,\"strokeStyle\"?,\"link\"?],\"edges\":[[\"from\",\"to\",\"label\"?] or {\"from\",\"to\",\"label\"?,\"style\"?:\"solid|dashed|dotted\",\"color\"?,\"bidirectional\"?,\"labelAt\"?:0..1,\"fromSide\"?:\"top|right|bottom|left\",\"toSide\"?,\"route\"?:\"straight|elbow\"}],\"zones\":[{\"id\",\"label\",\"nodes\":[ids],\"color\"?,\"padding\"?}],\"legend\":[\"text\"],\"groups\":[{\"nodes\":[ids]}],\"direction\":\"LR|TB\"}";

const CHECK_HELP: &str =
    "validate the whole spec, list every problem and every overflowing text, write nothing";

const FORMAT_HELP: &str = "png or svg (default svg for export, png for preview)";
const SCALE_HELP: &str = "PNG scale, 0.5 to 4 (default 1)";

pub static COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:create",
            GROUP,
            "Create a drawing from a spec of boxes, arrows, zones and a legend",
            &[
                req("path", "new drawing, e.g. Diagrams/Arch.excalidraw"),
                pj("spec", SPEC_HELP)
            ],
            &[
                ("overwrite", "replace an existing file"),
                ("check", CHECK_HELP)
            ],
            NO_FORMATS,
            None,
            writes,
            create
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:add",
            GROUP,
            "Add boxes, arrows, zones and legend lines to a drawing",
            &[FILE, PATH, reqj("spec", SPEC_HELP)],
            &[("check", CHECK_HELP)],
            NO_FORMATS,
            None,
            writes,
            add
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:update",
            GROUP,
            "Change, move, restyle, re-label, re-route or remove boxes, arrows and zones of a drawing",
            &[FILE, PATH, reqj("spec", UPDATE_HELP)],
            &[("check", CHECK_HELP)],
            NO_FORMATS,
            None,
            writes,
            update
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:read",
            GROUP,
            "Print a drawing as the spec create accepts (text), or with its path, title and link targets (json)",
            &[FILE, PATH, p("format", "text | json")],
            NO_FLAGS,
            READ_FORMATS,
            Some("text"),
            reads,
            read
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:lint",
            GROUP,
            "Find label over label, label over box, arrow through a box, text overflow and stray boxes in a zone (read-only)",
            &[FILE, PATH, p("format", "json | text")],
            NO_FLAGS,
            LINT_FORMATS,
            Some("json"),
            reads,
            lint_cmd
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:export",
            GROUP,
            "Write the drawing as an SVG or PNG next to it (needs Writer running)",
            &[FILE, PATH, p("format", FORMAT_HELP), p("scale", SCALE_HELP)],
            NO_FLAGS,
            NO_FORMATS,
            None,
            writes,
            export
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:preview",
            GROUP,
            "Render the drawing to an image outside the vault and print its path (needs Writer running)",
            &[FILE, PATH, p("format", FORMAT_HELP), p("scale", SCALE_HELP)],
            NO_FLAGS,
            NO_FORMATS,
            None,
            writes,
            preview
        )
    },
];

const READ_FORMATS: &[&str] = &["text", "json"];
const LINT_FORMATS: &[&str] = &["json", "text"];

/// An existing drawing named by `file=` or `path=`, with its format.
fn drawing(ctx: &Ctx, args: &Args) -> Result<(Target, Format), CliError> {
    let t = ctx.target(args)?;
    let format = md::format_of(&t.rel).ok_or_else(|| {
        CliError::fail(format!(
            "{} is not a drawing (.excalidraw.md or .excalidraw)",
            t.rel
        ))
    })?;
    Ok((t, format))
}

fn load(t: &Target, format: Format) -> Result<md::Parsed, CliError> {
    let text = vault_ops::read_text(&t.abs)?;
    md::parse(&text, format).map_err(|e| CliError::fail(format!("{}: {e}", t.rel)))
}

fn check_scene(scene: &serde_json::Value, rel: &str) -> Result<(), CliError> {
    elements::validate_scene(scene)
        .map_err(|e| CliError::fail(format!("{rel}: the result is not a valid drawing: {e}")))
}

fn write_back(t: &Target, parsed: &md::Parsed, scene: serde_json::Value) -> Result<(), CliError> {
    check_scene(&scene, &t.rel)?;
    let text = md::serialize(
        parsed,
        &State {
            scene,
            embedded: parsed.embedded.clone(),
        },
    )
    .map_err(CliError::fail)?;
    vault_ops::write_text(&t.abs, &text)?;
    Ok(())
}

/// The spec of `spec=`: text that is not JSON is a usage error (exit 2), items that are wrong are
/// a failed validation (exit 1) listing every one.
fn spec_of(args: &Args, required: bool) -> Result<elements::Spec, CliError> {
    match args.get("spec") {
        Some(s) => elements::parse_spec(s).map_err(|e| match e {
            SpecError::Usage(m) => CliError::Usage(m),
            SpecError::Invalid(p) => CliError::fail(elements::problems_message(&p)),
        }),
        None if required => Err(CliError::Usage("spec= is required".into())),
        None => Ok(elements::Spec::default()),
    }
}

/// Every problem of a run in one failure, led by the file it was for.
fn failed(rel: &str, problems: Vec<String>) -> CliError {
    CliError::fail(format!("{rel}: {}", elements::problems_message(&problems)))
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// What `check` prints once the spec is fine: the layout findings of the result, never an error.
fn checked(rel: &str, what: &str, scene: &serde_json::Value) -> String {
    let notes = lint::lint(scene);
    let mut out = format!("OK: {what} in {rel} (nothing written)\n");
    for f in &notes {
        out.push_str(&format!("note: {}\n", f.line()));
    }
    out
}

/// "1 box, 1 arrow" (and ", 2 zones" when there are any).
fn counts(a: &elements::Added) -> String {
    let mut s = format!(
        "{}, {}",
        plural(a.nodes, "box", "boxes"),
        plural(a.edges, "arrow", "arrows")
    );
    if a.zones > 0 {
        s.push_str(&format!(", {}", plural(a.zones, "zone", "zones")));
    }
    s
}

/// The same as a sentence: "1 box and 1 arrow", "1 box, 1 arrow and 1 zone".
fn counts_sentence(a: &elements::Added) -> String {
    let c = counts(a);
    match c.rsplit_once(", ") {
        Some((head, last)) => format!("{head} and {last}"),
        None => c,
    }
}

pub fn create(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let input = args
        .get("path")
        .ok_or_else(|| CliError::Usage("path= is required".into()))?;
    let input = if md::format_of(input).is_some() {
        input.to_string()
    } else {
        format!("{input}.excalidraw")
    };
    let format = md::format_of(&input).expect("the suffix was just ensured");
    let spec = spec_of(args, false)?;
    let c = ctx.confine(&input)?;
    let checking = args.flag("check");
    let mut problems = Vec::new();
    if c.abs.exists() && !args.flag("overwrite") {
        problems.push(format!("{} already exists (use the overwrite flag)", c.rel));
    }
    if c.abs.is_dir() {
        problems.push(format!("{} is a folder", c.rel));
    }
    if !problems.is_empty() && !checking {
        return Err(CliError::fail(problems.remove(0)));
    }
    let mut scene = md::empty_scene();
    let added = match elements::add_to_scene(&mut scene, &spec, &mut Gen::new()) {
        Ok(a) => a,
        Err(p) => {
            problems.extend(p);
            return Err(failed(&c.rel, problems));
        }
    };
    if !problems.is_empty() {
        return Err(failed(&c.rel, problems));
    }
    check_scene(&scene, &c.rel)?;
    if checking {
        return Ok(checked(
            &c.rel,
            &format!("would create {}", counts(&added)),
            &scene,
        ));
    }
    if let Some(parent) = c.abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    vault_ops::write_text(&c.abs, &md::new_drawing_text(format, &scene))?;
    Ok(format!("Created {} ({})\n", c.rel, counts(&added)))
}

pub fn add(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (t, format) = drawing(ctx, args)?;
    let spec = spec_of(args, true)?;
    let parsed = load(&t, format)?;
    let mut scene = parsed.scene.clone();
    let added = elements::add_to_scene(&mut scene, &spec, &mut Gen::new())
        .map_err(|p| failed(&t.rel, p))?;
    if args.flag("check") {
        check_scene(&scene, &t.rel)?;
        return Ok(checked(
            &t.rel,
            &format!("would add {}", counts_sentence(&added)),
            &scene,
        ));
    }
    write_back(&t, &parsed, scene)?;
    Ok(format!("Added {} to {}\n", counts_sentence(&added), t.rel))
}

pub fn read(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let (t, format) = drawing(ctx, args)?;
    let parsed = load(&t, format)?;
    let read = elements::read_spec(&parsed.scene);
    let out = if args.format(spec)? == "json" {
        json!({
            "path": t.rel,
            "title": md::title_of(&t.rel),
            "links": elements::link_targets(&parsed.scene),
            "spec": read,
        })
    } else {
        read
    };
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(&out).expect("a Value serializes")
    ))
}

pub fn lint_cmd(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let (t, format) = drawing(ctx, args)?;
    let parsed = load(&t, format)?;
    let findings = lint::lint(&parsed.scene);
    if args.format(spec)? == "text" {
        if findings.is_empty() {
            return Ok(format!("{}: clean\n", t.rel));
        }
        return Ok(findings.iter().map(|f| format!("{}\n", f.line())).collect());
    }
    let out = json!({
        "path": t.rel,
        "clean": findings.is_empty(),
        "findings": findings.iter().map(lint::Finding::json).collect::<Vec<_>>(),
    });
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(&out).expect("a Value serializes")
    ))
}

pub fn update(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (t, format) = drawing(ctx, args)?;
    let spec = spec_of(args, true)?;
    let parsed = load(&t, format)?;
    let mut scene = parsed.scene.clone();
    let done = elements::update_scene(&mut scene, &spec, &mut Gen::new())
        .map_err(|p| failed(&t.rel, p))?;
    let mut parts = Vec::new();
    for (n, one, many, verb) in [
        (done.nodes, "box", "boxes", "Updated"),
        (done.edges, "arrow", "arrows", "Updated"),
        (done.zones, "zone", "zones", "Updated"),
        (done.removed_nodes, "box", "boxes", "removed"),
        (done.removed_edges, "arrow", "arrows", "removed"),
        (done.removed_zones, "zone", "zones", "removed"),
    ] {
        if n > 0 {
            parts.push(format!("{verb} {}", plural(n, one, many)));
        }
    }
    if parts.is_empty() {
        parts.push("Nothing to change".into());
    }
    let said = parts.join(", ");
    let mut chars = said.chars();
    let said = chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect::<String>())
        .unwrap_or_default();
    if args.flag("check") {
        check_scene(&scene, &t.rel)?;
        return Ok(checked(&t.rel, &said.to_lowercase(), &scene));
    }
    write_back(&t, &parsed, scene)?;
    Ok(format!("{said} in {}\n", t.rel))
}

/// Ask the running app to draw the drawing as `format` and print the path it answers with.
fn render(ctx: &Ctx, args: &Args, command: &str) -> Result<String, CliError> {
    let (t, _) = drawing(ctx, args)?;
    let mut call = Map::new();
    call.insert("path".into(), json!(t.rel));
    if let Some(f) = args.get("format") {
        if !matches!(f, "png" | "svg") {
            return Err(CliError::Usage("format= is png or svg".into()));
        }
        call.insert("format".into(), json!(f));
    }
    if let Some(s) = args.get("scale") {
        let n: f64 = s
            .parse()
            .map_err(|_| CliError::Usage("scale= is a number from 0.5 to 4".into()))?;
        call.insert("scale".into(), json!(n));
    }
    let v = cmd_app::call_app(ctx, command, Some(ctx.root()?), call)?;
    v["path"]
        .as_str()
        .map(|p| format!("{p}\n"))
        .ok_or_else(|| CliError::fail("Writer did not say where it wrote the image"))
}

pub fn export(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    render(ctx, args, "excalidraw:export")
}

pub fn preview(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    render(ctx, args, "excalidraw:preview")
}
