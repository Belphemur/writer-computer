//! The `writer` launcher the agent gets on its PATH (`agent::cli_launcher`, `agent::env`): made
//! in a temp "app data" dir over the real app binary, found first on the composed PATH, and it
//! runs the CLI. Unix only (the launcher is a symlink).
#![cfg(unix)]

use desktop_lib::agent::{cli_launcher, env};
use std::path::Path;
use std::process::Command;

fn app_binary() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_desktop"))
}

#[test]
fn the_launcher_on_the_spawned_path_runs_the_writer_cli() {
    let data = tempfile::tempdir().unwrap();
    let dir = cli_launcher::ensure(&data.path().join("bin"), app_binary()).unwrap();

    let child_env = env::child_env(
        [("PATH".to_string(), "/usr/bin:/bin".to_string())].into_iter(),
        "/usr/bin",
        Some(&dir),
    );
    let path = child_env
        .iter()
        .find(|(k, _)| k == "PATH")
        .unwrap()
        .1
        .clone();
    assert!(path.starts_with(&format!("{}:", dir.display())), "{path}");

    // what the agent's Bash does: resolve `writer` through that PATH, then run it (a temp HOME so
    // the CLI's log files stay out of the real log folder)
    let home = tempfile::tempdir().unwrap();
    let out = Command::new("/bin/sh")
        .arg("-c")
        .arg("command -v writer && writer --version")
        .env_clear()
        .env("PATH", &path)
        .env("HOME", home.path())
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    assert_eq!(
        lines.next().map(Path::new),
        Some(dir.join("writer").as_path())
    );
    assert_eq!(
        lines.next(),
        Some(concat!("writer ", env!("CARGO_PKG_VERSION")))
    );
}
