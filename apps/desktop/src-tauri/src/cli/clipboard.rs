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
        Err(missing_tools_message(&missing))
    }
}

/// The `--copy` error when no clipboard tool is on PATH. On Linux it names both tools and which
/// session each serves, so the fix is one package install (`wl-clipboard` or `xclip`).
fn missing_tools_message(missing: &[&str]) -> String {
    let tools = missing.join(" or ");
    if missing.contains(&"wl-copy") {
        format!(
            "--copy needs a clipboard tool, but {tools} was not found in PATH: install wl-clipboard (wl-copy, Wayland) or xclip (X11)"
        )
    } else {
        format!("--copy needs a clipboard tool, but {tools} was not found in PATH")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_error_names_both_tools_and_their_packages() {
        let message = missing_tools_message(&["wl-copy", "xclip"]);
        assert!(message.contains("wl-copy or xclip"));
        assert!(message.contains("wl-clipboard"));
        assert!(message.contains("Wayland") && message.contains("X11"));
    }

    #[test]
    fn other_platforms_keep_the_plain_error() {
        let message = missing_tools_message(&["pbcopy"]);
        assert_eq!(
            message,
            "--copy needs a clipboard tool, but pbcopy was not found in PATH"
        );
    }
}
