//! `excalidraw:export` and `excalidraw:preview` over the CLI-to-app socket (ADR 2026-11-18,
//! points 6 and 7; the socket is the ADR `2026-11-18-let-the-writer-cli-talk-to-the-running-app-
//! over-a-local-authenticated-socket`). Both ask the window to draw the drawing with Excalidraw's
//! own export (the one web handler, `web/render.ts`, topic `excalidraw:render`) and differ only in
//! where the image goes: `export` writes `<name>.svg` or `<name>.png` beside the drawing in the
//! vault, `preview` writes a PNG (or SVG) to the OS temp folder, outside the vault, for an agent to
//! look at. The socket carries 64 KiB at most, so the window hands the image to this half (not to
//! the CLI) and the CLI is answered with one path only: vault-relative for `export`, absolute for
//! `preview`. Never logged.

use super::previews;
use crate::ipc::{boxed, BoxFuture, Call, IpcCommand, IpcError, VaultRule};
use crate::vault_ops;
use base64::Engine;
use serde_json::{json, Value};
use std::time::{Duration, SystemTime};

/// Rendering a large drawing off-screen can take a while.
const RENDER_TIMEOUT: Duration = Duration::from_secs(20);
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
pub const MIN_SCALE: f64 = 0.5;
pub const MAX_SCALE: f64 = 4.0;

const fn command(name: &'static str, run: crate::ipc::registry::Handler) -> IpcCommand {
    IpcCommand {
        name,
        vault: VaultRule::MustBeOpen,
        timeout: RENDER_TIMEOUT,
        feature: Some("excalidraw"),
        run,
    }
}

pub static COMMANDS: &[IpcCommand] = &[
    command("excalidraw:export", export_handler),
    command("excalidraw:preview", preview_handler),
];

fn export_handler(call: Call) -> BoxFuture<'static, Result<Value, IpcError>> {
    // `export` was an SVG before it could be a PNG: that stays its default
    boxed(async move { render(call, Destination::Vault, Format::Svg).await })
}

fn preview_handler(call: Call) -> BoxFuture<'static, Result<Value, IpcError>> {
    boxed(async move { render(call, Destination::Temp(std::env::temp_dir()), Format::Png).await })
}

enum Destination {
    /// Beside the drawing; the answer is the vault-relative path.
    Vault,
    /// Under this directory's `writer-previews/`; the answer is the absolute path.
    Temp(std::path::PathBuf),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Png,
    Svg,
}

impl Format {
    fn parse(call: &Call, default: Format) -> Result<Format, IpcError> {
        match call.args.get("format").map(Value::as_str) {
            None => Ok(default),
            Some(Some("png")) => Ok(Format::Png),
            Some(Some("svg")) => Ok(Format::Svg),
            _ => Err(IpcError::invalid_args("format is png or svg")),
        }
    }

    fn ext(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Svg => "svg",
        }
    }
}

/// The scale of a PNG: a number in [`MIN_SCALE`, `MAX_SCALE`] (default 1).
fn scale_of(call: &Call, format: Format) -> Result<f64, IpcError> {
    let Some(v) = call.args.get("scale") else {
        return Ok(1.0);
    };
    if format == Format::Svg {
        return Err(IpcError::invalid_args("scale applies to png"));
    }
    v.as_f64()
        .filter(|s| (MIN_SCALE..=MAX_SCALE).contains(s))
        .ok_or_else(|| {
            IpcError::invalid_args(format!("scale is a number from {MIN_SCALE} to {MAX_SCALE}"))
        })
}

/// `Dir/Arch.excalidraw.md` and `Dir/Arch.excalidraw` both give the stem `Dir/Arch`.
fn stem_of(rel: &str) -> &str {
    let lower = rel.to_ascii_lowercase();
    let cut = [".excalidraw.md", ".excalidraw"]
        .iter()
        .find(|s| lower.ends_with(*s))
        .map_or(0, |s| s.len());
    &rel[..rel.len() - cut]
}

async fn render(call: Call, to: Destination, default: Format) -> Result<Value, IpcError> {
    call.only_args(&["path", "format", "scale"])?;
    let format = Format::parse(&call, default)?;
    let scale = scale_of(&call, format)?;
    let file = call.confine_existing("path", true).await?;
    if super::excalidraw_md::format_of(&file.rel).is_none() {
        return Err(IpcError::invalid_args(format!(
            "{} is not a drawing",
            file.rel
        )));
    }
    let root = call.vault()?.root.clone();
    let answer = call
        .host
        .ask_window(
            &root,
            "excalidraw:render",
            json!({ "path": file.abs.to_string_lossy(), "format": format.ext(), "scale": scale }),
        )
        .await?;
    let bytes = image_of(&answer, format)?;
    let stem = stem_of(&file.rel).to_string();
    let beside = format!("{}.{}", stem_of(&file.abs.to_string_lossy()), format.ext());
    let rel = tokio::task::spawn_blocking(move || -> Result<String, IpcError> {
        match to {
            Destination::Vault => {
                vault_ops::write_bytes(std::path::Path::new(&beside), &bytes)?;
                Ok(format!("{stem}.{}", format.ext()))
            }
            Destination::Temp(base) => {
                let name = stem.rsplit('/').next().unwrap_or("drawing");
                previews::save(&base, name, format.ext(), &bytes, SystemTime::now())
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|_| {
                        IpcError::new(
                            crate::ipc::ErrorCode::Internal,
                            "could not write the preview",
                        )
                    })
            }
        }
    })
    .await
    .map_err(|_| IpcError::new(crate::ipc::ErrorCode::Internal, "the write did not finish"))??;
    Ok(json!({ "path": rel }))
}

/// The image bytes from the window's answer `{ format, data }`: base64 for a PNG, markup for an
/// SVG. Anything that is not what it says it is, is an error rather than a file.
fn image_of(answer: &Value, format: Format) -> Result<Vec<u8>, IpcError> {
    let bad = || {
        IpcError::new(
            crate::ipc::ErrorCode::Internal,
            "the window did not answer with the image",
        )
    };
    let data = answer.get("data").and_then(Value::as_str).ok_or_else(bad)?;
    match format {
        Format::Png => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| bad())?;
            bytes
                .starts_with(PNG_MAGIC)
                .then_some(bytes)
                .ok_or_else(bad)
        }
        Format::Svg => data
            .trim_start()
            .starts_with("<svg")
            .then(|| data.as_bytes().to_vec())
            .ok_or_else(bad),
    }
}
