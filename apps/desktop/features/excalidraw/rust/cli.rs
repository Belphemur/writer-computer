//! The `writer excalidraw:*` commands (ADR 2026-11-18, point 7): `create`, `add`, `connect` and
//! `read` work on the files with the app closed, through the codec and `vault_ops` confinement
//! (the one write path of the CLI); `export` asks the running app over the socket
//! (`ipc::export`). Declared here, tagged with the feature so the CLI's one gate answers "turned
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

const SPEC_HELP: &str = "JSON: {\"nodes\":[{\"id\",\"text\",\"shape\"?,\"x\"?,\"y\"?,\"color\"?}],\"edges\":[[\"from\",\"to\",\"label\"?]],\"groups\":[{\"nodes\":[ids]}],\"direction\":\"LR|TB\"}";

pub static COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:create",
            GROUP,
            "Create a drawing from a spec of boxes and arrows",
            &[
                req("path", "new drawing, e.g. Diagrams/Arch.excalidraw.md"),
                p("spec", SPEC_HELP)
            ],
            &[("overwrite", "replace an existing file")],
            NO_FORMATS,
            None,
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
            add
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:connect",
            GROUP,
            "Draw an arrow between two boxes of a drawing",
            &[
                FILE,
                PATH,
                req("from", "box id"),
                req("to", "box id"),
                p("label", "text on the arrow")
            ],
            NO_FLAGS,
            NO_FORMATS,
            None,
            connect
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
            read
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "excalidraw:export",
            GROUP,
            "Write the drawing as an SVG next to it (needs Writer running)",
            &[FILE, PATH],
            NO_FLAGS,
            NO_FORMATS,
            None,
            export
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
        format!("{input}.excalidraw.md")
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

pub fn connect(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (t, format) = drawing(ctx, args)?;
    let from = args
        .get("from")
        .ok_or_else(|| CliError::Usage("from= is required".into()))?;
    let to = args
        .get("to")
        .ok_or_else(|| CliError::Usage("to= is required".into()))?;
    let parsed = load(&t, format)?;
    let mut scene = parsed.scene.clone();
    elements::connect(&mut scene, from, to, args.get("label"), &mut Gen::new())
        .map_err(CliError::fail)?;
    write_back(&t, &parsed, scene)?;
    Ok(format!("Connected {from} -> {to} in {}\n", t.rel))
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

pub fn export(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (t, _) = drawing(ctx, args)?;
    let mut call = Map::new();
    call.insert("path".into(), json!(t.rel));
    let v = cmd_app::call_app(ctx, "excalidraw:export", Some(ctx.root()?), call)?;
    v["path"]
        .as_str()
        .map(|p| format!("{p}\n"))
        .ok_or_else(|| CliError::fail("Writer did not say where it wrote the SVG"))
}
