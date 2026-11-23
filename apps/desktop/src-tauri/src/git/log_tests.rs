//! What a git call leaves in the log (ADR 2026-11-23): one line per call on target `git`, git's
//! own stderr on a failure, bounded and redacted, never an argument, never what a helper or `gh
//! auth token` answered. Run through the real log pipeline, so the file is what is grepped.

use super::credential::{self, Lookup};
use super::forge::Forge;
use super::transport::{Exec, RunError};
use crate::features::scope::Spawner;
use std::io::Cursor;
use std::path::Path;
use std::time::Duration;

const TOKEN: &str = "zq8Wk3Lm9Xv2Np5Rt7Yb1Hc4";

fn fake(dir: &Path, binary: &str, script: &str) {
    let path = dir.join(binary);
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// The lines the real pipeline wrote while `f` ran on this thread.
fn logged(f: impl FnOnce()) -> Vec<serde_json::Value> {
    // `log` records (the transport's) reach the pipeline through this bridge
    crate::logging::test_logger();
    let dir = tempfile::tempdir().unwrap();
    let built = crate::logging::build(
        dir.path(),
        "writer",
        tracing::level_filters::LevelFilter::INFO,
    )
    .unwrap();
    tracing::dispatcher::with_default(&built.dispatch, f);
    drop(built); // flushes the writer thread
    let mut lines = Vec::new();
    for entry in std::fs::read_dir(dir.path()).unwrap().flatten() {
        for l in std::fs::read_to_string(entry.path()).unwrap().lines() {
            lines.push(serde_json::from_str(l).unwrap());
        }
    }
    lines
}

fn git_lines(lines: &[serde_json::Value]) -> Vec<&serde_json::Value> {
    lines.iter().filter(|l| l["target"] == "git").collect()
}

#[cfg(unix)]
#[test]
fn a_failed_call_logs_gits_stderr_redacted_and_bounded_and_nothing_else() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // a helper's answer on stdout, a refusal that echoes the URL with the token, then a flood
    fake(
        &bin,
        "git",
        &format!(
            "echo 'username=me'; echo 'password={TOKEN}'\n\
             echo \"fatal: Authentication failed for 'https://me:{TOKEN}@host.test/o/r.git/'\" >&2\n\
             echo 'remote: Invalid credentials, token={TOKEN}' >&2\n\
             i=0; while [ $i -lt 400 ]; do printf '%050d' 0 >&2; i=$((i+1)); done\n\
             exit 128"
        ),
    );
    let exec = Exec::new(Spawner::detached()).with_only_path(vec![bin]);
    let lines = logged(|| {
        let cmd = exec.git(
            tmp.path(),
            None,
            &[
                "fetch",
                "https://me:argvsecret@host.test/o/private-repo.git",
            ],
        );
        let out = exec.run(cmd, Duration::from_secs(20)).unwrap();
        assert_eq!(out.code, Some(128));
    });
    let all = serde_json::to_string(&lines).unwrap();
    assert!(!all.contains(TOKEN), "token in the log: {all}");
    assert!(!all.contains("password="), "stdout in the log: {all}");
    assert!(
        !all.contains("argvsecret") && !all.contains("private-repo"),
        "{all}"
    );
    let git = git_lines(&lines);
    assert_eq!(git.len(), 1, "{all}");
    assert_eq!(git[0]["level"], "ERROR");
    let message = git[0]["fields"]["message"].as_str().unwrap();
    assert!(
        message.starts_with("git fetch failed (exit 128)"),
        "{message}"
    );
    assert!(message.contains("Authentication failed for 'https://host.test/o/r.git/'"));
    // 4 KiB of stderr and the short head, not the flood
    assert!(message.len() < 4096 + 200, "{}", message.len());
    assert!(message.ends_with("…[truncated]"), "{}", message.len());
}

#[cfg(unix)]
#[test]
fn a_call_that_works_logs_its_name_and_duration_never_its_output_or_arguments() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    fake(&bin, "gh", &format!("echo {TOKEN}"));
    fake(&bin, "git", "echo ok");
    let exec = Exec::new(Spawner::detached()).with_only_path(vec![bin]);
    let lines = logged(|| {
        for cmd in [
            exec.tool("gh", &["auth", "token", "--hostname", "host.test"]),
            exec.git(tmp.path(), None, &["remote", "get-url", "origin"]),
            exec.git_lfs(
                tmp.path(),
                None,
                Some("https://host.test/o/private-repo.git/info/lfs"),
                &["push", "origin", "refs/heads/main"],
            ),
        ] {
            assert!(exec.run(cmd, Duration::from_secs(20)).unwrap().ok());
        }
        // a program that is not there is told in a word
        let missing = exec.tool("fj", &["version"]);
        assert_eq!(
            exec.run(missing, Duration::from_secs(5)).unwrap_err(),
            RunError::Absent
        );
    });
    let all = serde_json::to_string(&lines).unwrap();
    assert!(!all.contains(TOKEN) && !all.contains("private-repo") && !all.contains("host.test"));
    let messages: Vec<String> = git_lines(&lines)
        .iter()
        .map(|l| l["fields"]["message"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(messages.len(), 4, "{messages:?}");
    assert!(messages[0].starts_with("gh auth ok in "), "{messages:?}");
    assert!(messages[1].starts_with("git remote ok in "));
    assert!(messages[2].starts_with("git lfs push ok in "));
    assert_eq!(messages[3], "fj version: program not found");
    assert!(git_lines(&lines).iter().all(|l| l["level"] == "INFO"));
}

/// The helper git runs for HTTPS gets the request on stdin and answers on stdout: neither is a log
/// line, whatever the source.
#[test]
fn the_credential_helper_flow_logs_neither_its_request_nor_its_answer() {
    let lines = logged(|| {
        let token = || Some(TOKEN.to_string());
        let cli = |_: &Forge, _: &str| Some(TOKEN.to_string());
        let mut out = Vec::new();
        let args: Vec<String> = ["--source", "token", "--host", "github.com", "get"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let code = credential::run(
            &args,
            Cursor::new(b"protocol=https\nhost=github.com\nusername=me\n\n".to_vec()),
            &mut out,
            &Lookup {
                token: &token,
                cli: &cli,
            },
        );
        assert_eq!(code, 0);
        assert!(String::from_utf8(out).unwrap().contains(TOKEN));
    });
    let all = serde_json::to_string(&lines).unwrap();
    assert!(!all.contains(TOKEN) && !all.contains("password="), "{all}");
    assert!(git_lines(&lines).is_empty(), "{all}");
}

/// A token that straddles the 4 KiB cut is redacted before the cut, never half shown.
#[cfg(unix)]
#[test]
fn a_token_straddling_the_cut_is_redacted_whole() {
    let gh = format!("ghp_{}", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6");
    assert_eq!(gh.len(), 40);
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // the token starts 12 bytes before the cut of the stderr (4096): cut first, its first 8 body
    // characters would be left, too few for a pattern to know them
    let before = "x".repeat(4083);
    fake(
        &bin,
        "git",
        &format!("printf '%s %s tail' '{before}' '{gh}' >&2\nexit 1"),
    );
    let exec = Exec::new(Spawner::detached()).with_only_path(vec![bin]);
    let lines = logged(|| {
        let out = exec
            .run(
                exec.git(tmp.path(), None, &["fetch"]),
                Duration::from_secs(20),
            )
            .unwrap();
        assert_eq!(out.code, Some(1));
    });
    let all = serde_json::to_string(&lines).unwrap();
    let body = &gh[4..];
    for i in 0..=body.len() - 8 {
        assert!(
            !all.contains(&body[i..i + 8]),
            "run {} of the token in the log",
            &body[i..i + 8]
        );
    }
    assert!(all.contains("[truncated]"));
}

#[test]
fn a_call_is_named_by_program_and_subcommand_never_an_options_value() {
    use super::transport::describe;
    use std::process::Command;
    let named = |program: &str, args: &[&str]| {
        let mut c = Command::new(program);
        c.args(args);
        describe(&c)
    };
    assert_eq!(named("fj", &["-H", "nas", "whoami"]), "fj whoami");
    assert_eq!(
        named("gh", &["auth", "token", "--hostname", "host.test"]),
        "gh auth"
    );
    assert_eq!(
        named("gh", &["--hostname", "secret.host", "repo", "create"]),
        "gh repo"
    );
    assert_eq!(
        named(
            "git",
            &["-c", "a=b", "-c", "c=d", "lfs", "push", "origin", "x"]
        ),
        "git lfs push"
    );
    assert_eq!(
        named("git", &["-C", "/vault/private", "fetch"]),
        "git fetch"
    );
}

/// git's tracing variables never reach a child: they would put request headers on stderr, which a
/// failed call logs.
#[cfg(unix)]
#[test]
fn git_trace_variables_are_not_passed_to_a_call() {
    std::env::set_var("GIT_TRACE", "/dev/null");
    std::env::set_var("GIT_CURL_VERBOSE", "1");
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    fake(
        &bin,
        "git",
        "echo \"trace=[$GIT_TRACE] verbose=[$GIT_CURL_VERBOSE]\" >&2\nexit 1",
    );
    let exec = Exec::new(Spawner::detached()).with_only_path(vec![bin]);
    let lines = logged(|| {
        exec.run(
            exec.git(tmp.path(), None, &["fetch"]),
            Duration::from_secs(20),
        )
        .unwrap();
    });
    std::env::remove_var("GIT_TRACE");
    std::env::remove_var("GIT_CURL_VERBOSE");
    let all = serde_json::to_string(&lines).unwrap();
    assert!(all.contains("trace=[] verbose=[]"), "{all}");
}

#[cfg(unix)]
#[test]
fn a_signed_commit_logs_its_call_and_never_the_message_or_the_signature() {
    use super::signing_tests::{commit_user, sign_with, signer, Through};
    use super::sync::tests::{have_git, World};
    if !have_git() {
        return;
    }
    let w = World::new();
    let d = w.device("A");
    d.write("Plan.md", "1\n");
    d.setup();
    sign_with(&d, &signer(&w.home, true));
    let _through = Through::of(&d);
    d.write("Plan.md", "2\n");
    let lines = logged(|| {
        commit_user(&d).unwrap().unwrap();
    });
    let all = serde_json::to_string(&lines).unwrap();
    let git = git_lines(&lines);
    assert!(
        git.iter().any(|l| l["fields"]["message"]
            .as_str()
            .is_some_and(|m| m.starts_with("git commit-tree ok in "))),
        "{all}"
    );
    for secret in [
        "user(edit)",
        "Writer-Device",
        "BEGIN SSH SIGNATURE",
        "ZmFrZQ",
    ] {
        assert!(!all.contains(secret), "{secret}: {all}");
    }
}
