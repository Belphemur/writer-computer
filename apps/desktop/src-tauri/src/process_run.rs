//! The one bounded process runner: start a prepared [`Command`] through the owning scope's
//! [`Spawner`] (so turning the feature off kills it), optionally feed it text on stdin, read its
//! piped stdout and stderr up to a cap, and wait for it to end, for the timeout, or until the
//! scope stops. `git`, `gh` (`git/transport.rs`) and the fixed `claude` probes and chat-title call
//! (`agent/binary.rs`) all run here; callers only build the command (program, environment, cwd,
//! which pipes). Nothing here names `std::process::Child` or logs anything.

use crate::features::scope::{ScopedChild, Spawner};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Per-stream output cap when the caller names none.
pub const DEFAULT_MAX_OUT: u64 = 4 << 20;

#[derive(Debug)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// The program is not installed.
    Absent,
    Timeout,
    /// The scope stopped (the feature was turned off or the app quits).
    Cancelled,
    Io(String),
}

/// How one run is bounded.
#[derive(Debug, Clone)]
pub struct RunOptions {
    pub timeout: Duration,
    /// Written to stdin, then stdin is closed.
    pub stdin: Option<String>,
    /// At most this many bytes are kept of each of stdout and stderr.
    pub max_out: u64,
}

impl RunOptions {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            stdin: None,
            max_out: DEFAULT_MAX_OUT,
        }
    }

    pub fn stdin(mut self, text: impl Into<String>) -> Self {
        self.stdin = Some(text.into());
        self
    }

    pub fn max_out(mut self, bytes: u64) -> Self {
        self.max_out = bytes;
        self
    }
}

/// Runs `cmd` to its end, to `opts.timeout`, or until the scope stops (the whole process group is
/// killed then). Pipes the caller left as `Stdio::piped()` are drained; the others are ignored.
pub fn run(spawner: &Spawner, mut cmd: Command, opts: &RunOptions) -> Result<Output, RunError> {
    if opts.stdin.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child: ScopedChild = match spawner.process(&mut cmd) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(RunError::Absent),
        Err(_) if spawner.token().is_cancelled() => return Err(RunError::Cancelled),
        Err(e) => return Err(RunError::Io(e.kind().to_string())),
    };
    if let (Some(text), Some(mut si)) = (opts.stdin.clone(), child.take_stdin()) {
        // on a thread: a child that never reads must not outlive the timeout; one that exits
        // early closes the pipe and its exit status tells the story
        let fed = spawner.spawn("run-stdin", move |_| {
            let _ = si.write_all(text.as_bytes());
        });
        if fed.is_err() {
            child.kill();
            return Err(RunError::Cancelled);
        }
    }
    let (tx, rx) = mpsc::channel::<(bool, String)>();
    let cap = opts.max_out;
    let drain = |is_err: bool, mut pipe: Box<dyn Read + Send>| {
        let tx = tx.clone();
        spawner.spawn("run-io", move |_| {
            let mut buf = Vec::new();
            let _ = pipe.by_ref().take(cap).read_to_end(&mut buf);
            let _ = tx.send((is_err, String::from_utf8_lossy(&buf).into_owned()));
        })
    };
    let mut pending = 0;
    if let Some(out) = child.take_stdout() {
        if drain(false, Box::new(out)).is_err() {
            child.kill();
            return Err(RunError::Cancelled);
        }
        pending += 1;
    }
    if let Some(err) = child.take_stderr() {
        if drain(true, Box::new(err)).is_err() {
            child.kill();
            return Err(RunError::Cancelled);
        }
        pending += 1;
    }
    drop(tx);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {}
            Err(e) => return Err(RunError::Io(e.kind().to_string())),
        }
        if spawner.token().is_cancelled() {
            child.kill();
            return Err(RunError::Cancelled);
        }
        if start.elapsed() > opts.timeout {
            child.kill();
            return Err(RunError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if spawner.token().is_cancelled() {
        // the scope stopped and killed the child's group under us
        return Err(RunError::Cancelled);
    }
    let (mut stdout, mut stderr) = (String::new(), String::new());
    for _ in 0..pending {
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok((false, t)) => stdout = t,
            Ok((true, t)) => stderr = t,
            Err(_) => break,
        }
    }
    Ok(Output {
        code: status.code(),
        stdout,
        stderr,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    fn opts(ms: u64) -> RunOptions {
        RunOptions::new(Duration::from_millis(ms))
    }

    #[test]
    fn stdin_text_is_written_then_closed() {
        // `cat` only ends when stdin closes
        let out = run(
            &Spawner::detached(),
            sh("cat"),
            &opts(5000).stdin("hello\nworld"),
        )
        .unwrap();
        assert!(out.ok());
        assert_eq!(out.stdout, "hello\nworld");
    }

    #[test]
    fn output_is_capped_per_stream_and_the_exit_code_kept() {
        let out = run(
            &Spawner::detached(),
            sh("printf aaaaaaaaaa; printf bbbbbbbbbb >&2; exit 3"),
            &opts(5000).max_out(4),
        )
        .unwrap();
        assert_eq!(out.code, Some(3));
        assert_eq!(out.stdout, "aaaa");
        assert_eq!(out.stderr, "bbbb");
    }

    #[test]
    fn a_child_that_outlives_the_timeout_is_killed() {
        let t = Instant::now();
        let r = run(&Spawner::detached(), sh("sleep 30"), &opts(200));
        assert_eq!(r.unwrap_err(), RunError::Timeout);
        assert!(t.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_child_that_never_reads_stdin_does_not_hang_the_run() {
        let big = "x".repeat(1 << 20);
        let r = run(&Spawner::detached(), sh("sleep 30"), &opts(200).stdin(big));
        assert_eq!(r.unwrap_err(), RunError::Timeout);
    }

    #[test]
    fn a_missing_program_is_absent() {
        let r = run(
            &Spawner::detached(),
            Command::new("/nonexistent/writer-test-program"),
            &opts(1000),
        );
        assert_eq!(r.unwrap_err(), RunError::Absent);
    }
}
