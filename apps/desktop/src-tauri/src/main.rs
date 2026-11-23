// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::process::ExitCode;

/// Multi-call dispatch: a symlink named `writer` in the user's PATH points
/// at the Writer app binary. When invoked through that symlink, argv[0]'s
/// basename is `writer` and we run the CLI. Invoked as `Writer` (the usual
/// case, direct from the bundle), we run the Tauri app.
fn main() -> ExitCode {
    // git runs `Writer git-credential --source <token|gh|fj> get` as a credential helper (feature
    // `git`, spec "Credentials"): answer on stdout and exit, before anything else starts
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some(desktop_lib::git::transport::CREDENTIAL_ARG) {
        return ExitCode::from(desktop_lib::git::credential::run_process(&args[1..]));
    }
    if is_cli_invocation() {
        let argv: Vec<_> = std::env::args_os().collect();
        let cwd = std::env::current_dir().unwrap_or_else(|_| Path::new(".").into());
        desktop_lib::logging::init_cli();
        let code =
            desktop_lib::writer_cli::run(argv, &cwd, &desktop_lib::writer_cli::SystemLauncher);
        desktop_lib::logging::shutdown();
        return code;
    }
    desktop_lib::run();
    ExitCode::SUCCESS
}

fn is_cli_invocation() -> bool {
    let Some(arg0) = std::env::args_os().next() else {
        return false;
    };
    is_cli_name(&arg0)
        || appimage_started_as_writer(
            std::env::var_os("APPIMAGE").is_some(),
            std::env::var_os("ARGV0"),
        )
}

/// `writer` as the program's base name, extension ignored.
fn is_cli_name(arg: &std::ffi::OsStr) -> bool {
    Path::new(arg)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|name| name.eq_ignore_ascii_case("writer"))
        .unwrap_or(false)
}

/// Inside an AppImage the running binary is `usr/bin/<app>` in the mount, so a `writer` link to
/// the AppImage file reaches us only through `ARGV0`, which the AppImage runtime sets to the name
/// it was started as. Only the exact name counts, so an AppImage file renamed `writer.AppImage`
/// still opens the app.
fn appimage_started_as_writer(in_appimage: bool, argv0: Option<std::ffi::OsString>) -> bool {
    in_appimage && argv0.is_some_and(|a| Path::new(&a).file_name().is_some_and(|n| n == "writer"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_by_base_name_is_the_cli() {
        assert!(is_cli_name("/usr/bin/writer".as_ref()));
        assert!(is_cli_name("writer".as_ref()));
        assert!(!is_cli_name("/usr/bin/writer-desktop".as_ref()));
    }

    #[test]
    fn appimage_is_the_cli_only_when_started_as_exactly_writer() {
        let argv0 = |s: &str| Some(std::ffi::OsString::from(s));
        assert!(appimage_started_as_writer(true, argv0("writer")));
        assert!(appimage_started_as_writer(
            true,
            argv0("/home/u/.local/bin/writer")
        ));
        assert!(!appimage_started_as_writer(
            true,
            argv0("./writer.AppImage")
        ));
        assert!(!appimage_started_as_writer(
            true,
            argv0("Writer_0.9.0_amd64.AppImage")
        ));
        assert!(!appimage_started_as_writer(false, argv0("writer")));
        assert!(!appimage_started_as_writer(true, None));
    }
}
