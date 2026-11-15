//! `--copy`: pipe the command output to the platform clipboard tool.

use std::io::Write;
use std::process::{Command, Stdio};

pub trait Clipboard {
    fn copy(&self, text: &str) -> Result<(), String>;
}

pub struct SystemClipboard;

fn pipe_to(program: &str, args: &[&str], text: &str) -> Result<(), std::io::Error> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
    }
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "{program} exited with {status}"
        )))
    }
}

impl Clipboard for SystemClipboard {
    fn copy(&self, text: &str) -> Result<(), String> {
        let candidates: &[(&str, &[&str])] = if cfg!(target_os = "macos") {
            &[("pbcopy", &[])]
        } else if cfg!(windows) {
            &[("clip", &[])]
        } else {
            &[("wl-copy", &[]), ("xclip", &["-selection", "clipboard"])]
        };
        let mut missing = Vec::new();
        for (program, args) in candidates {
            match pipe_to(program, args, text) {
                Ok(()) => return Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => missing.push(*program),
                Err(e) => return Err(format!("--copy failed: {e}")),
            }
        }
        Err(format!(
            "--copy needs a clipboard tool, but {} was not found in PATH",
            missing.join(" or ")
        ))
    }
}
