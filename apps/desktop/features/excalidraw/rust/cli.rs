//! The `writer excalidraw:*` commands (ADR 2026-11-18, point 7): `create`, `add`, `update`
//! and `read` work on the files with the app closed, through the codec and `vault_ops`
//! confinement (the one write path of the CLI); `export` and `preview` ask the running app over
//! the socket (`ipc.rs`). Declared here, tagged with the feature so the CLI's one gate answers "turned
//! off" while `features.excalidraw.enabled` is false.

use super::elements::{self, Gen};
use super::excalidraw_md::{self as md, Format, State};
use crate::cli::args::Args;
use crate::cli::cmd_app;
use crate::cli::registry::{cmd, p, req, CommandSpec, FILE, NO_FLAGS, NO_FORMATS, PATH};
use crate::cli::{CliError, Ctx, Target};
use crate::vault_ops;
use serde_json::{json, Map};

const FEATURE: Option<&str> = Some("excalidraw");
const GROUP: &str = "Excalidraw";

const UPDATE_HELP: &str = "JSON: {\"nodes\":[{\"id\",\"text\"?,\"shape\"?,\"x\"?,\"y\"?,\"w\"?,\"h\"?,\"color\"?}],\"edges\":[[\"from\",\"to\",\"label\"?]],\"remove\":{\"nodes\":[ids],\"edges\":[[\"from\",\"to\"]]}}";

const SPEC_HELP: &str = "JSON: {\"nodes\":[{\"id\",\"text\",\"shape\"?,\"x\"?,\"y\"?,\"color\"?}],\"edges\":[[\"from\",\"to\",\"label\"?]],\"groups\":[{\"nodes\":[ids]}],\"direction\":\"LR|TB\"}";

const FORMAT_HELP: &str = "png or svg (default svg for export, png for preview)";
const SCALE_HELP: &str = "PNG scale, 0.5 to 4 (default 1)";

pub static COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:create",
            GROUP,
            "Create a drawing from a spec of boxes and arrows",
            &[
                req("path", "new drawing, e.g. Diagrams/Arch.excalidraw"),
                p("spec", SPEC_HELP)
            ],
            &[("overwrite", "replace an existing file")],
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
            "Add boxes and arrows to a drawing",
            &[FILE, PATH, req("spec", SPEC_HELP)],
            NO_FLAGS,
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
            "Change, move, re-label or remove boxes and arrows of a drawing",
            &[FILE, PATH, req("spec", UPDATE_HELP)],
            NO_FLAGS,
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
            "Print a drawing as a spec (boxes, arrows, groups)",
            &[FILE, PATH],
            NO_FLAGS,
            NO_FORMATS,
            None,
            reads,
            read
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

fn check(scene: &serde_json::Value, rel: &str) -> Result<(), CliError> {
    elements::validate_scene(scene)
        .map_err(|e| CliError::fail(format!("{rel}: the result is not a valid drawing: {e}")))
}

fn write_back(t: &Target, parsed: &md::Parsed, scene: serde_json::Value) -> Result<(), CliError> {
    check(&scene, &t.rel)?;
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

fn spec_of(args: &Args, required: bool) -> Result<elements::Spec, CliError> {
    match args.get("spec") {
        Some(s) => elements::parse_spec(s).map_err(CliError::Usage),
        None if required => Err(CliError::Usage("spec= is required".into())),
        None => Ok(elements::Spec::default()),
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
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
    if c.abs.exists() && !args.flag("overwrite") {
        return Err(CliError::fail(format!(
            "{} already exists (use the overwrite flag)",
            c.rel
        )));
    }
    if c.abs.is_dir() {
        return Err(CliError::fail(format!("{} is a folder", c.rel)));
    }
    let mut scene = md::empty_scene();
    let added =
        elements::add_to_scene(&mut scene, &spec, &mut Gen::new()).map_err(CliError::fail)?;
    check(&scene, &c.rel)?;
    if let Some(parent) = c.abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    vault_ops::write_text(&c.abs, &md::new_drawing_text(format, &scene))?;
    Ok(format!(
        "Created {} ({}, {})\n",
        c.rel,
        plural(added.nodes, "box", "boxes"),
        plural(added.edges, "arrow", "arrows")
    ))
}

pub fn add(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (t, format) = drawing(ctx, args)?;
    let spec = spec_of(args, true)?;
    let parsed = load(&t, format)?;
    let mut scene = parsed.scene.clone();
    let added =
        elements::add_to_scene(&mut scene, &spec, &mut Gen::new()).map_err(CliError::fail)?;
    write_back(&t, &parsed, scene)?;
    Ok(format!(
        "Added {} and {} to {}\n",
        plural(added.nodes, "box", "boxes"),
        plural(added.edges, "arrow", "arrows"),
        t.rel
    ))
}

pub fn read(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (t, format) = drawing(ctx, args)?;
    let parsed = load(&t, format)?;
    let spec = elements::read_spec(&parsed.scene);
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(&spec).expect("a Value serializes")
    ))
}

pub fn update(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (t, format) = drawing(ctx, args)?;
    let spec = spec_of(args, true)?;
    let parsed = load(&t, format)?;
    let mut scene = parsed.scene.clone();
    let done =
        elements::update_scene(&mut scene, &spec, &mut Gen::new()).map_err(CliError::fail)?;
    write_back(&t, &parsed, scene)?;
    let mut parts = Vec::new();
    for (n, one, many, verb) in [
        (done.nodes, "box", "boxes", "Updated"),
        (done.edges, "arrow", "arrows", "Updated"),
        (done.removed_nodes, "box", "boxes", "removed"),
        (done.removed_edges, "arrow", "arrows", "removed"),
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
