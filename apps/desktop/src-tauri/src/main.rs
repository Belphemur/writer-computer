// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::process::ExitCode;

/// Multi-call dispatch: a symlink named `writer` in the user's PATH points
/// at the Writer app binary. When invoked through that symlink, argv[0]'s
/// basename is `writer` and we run the CLI. Invoked as `Writer` (the usual
/// case, direct from the bundle), we run the Tauri app.
fn main() -> ExitCode {
    // git runs `Writer git-credential --source <token|gh> get` as a credential helper (feature
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
    Path::new(&arg0)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|name| name.eq_ignore_ascii_case("writer"))
        .unwrap_or(false)
}
