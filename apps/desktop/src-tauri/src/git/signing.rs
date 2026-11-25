//! Commit signing (ADR 2026-11-18, the 2026-11-23 notes, superseded in part by the gix ADR of
//! 2026-11-24): when the effective configuration says commits are signed (`commit.gpgSign`, as
//! gix resolves it: system, global, includes, the repository's own), every commit Writer makes is
//! signed by the user's own signer, which Writer runs itself through `transport::Exec` (the
//! scope, the 120 s bound, the stop on feature off, the log line). The options (`gpg.format`,
//! `user.signingkey`, `gpg.program` / `gpg.ssh.program` and their arguments) are resolved by gix
//! in `repo.rs` ([`Signer`] is their neutral shape); the argv is gix-object's own, byte for byte
//! (`signature/sign.rs`), so the commit is the one `Commit::sign` would write. Writer reads no key
//! material; the signer does.
//!
//! Never unsigned: when signing is on and the signer fails, the caller gets [`SignError`] and
//! makes no commit.

use super::transport::{sanitize, Exec, RunError};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The signer may wait for the user (a 1Password approval, a pinentry).
pub const SIGN_TIMEOUT: Duration = Duration::from_secs(120);

/// What the status and Settings > Git say about signing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Signing {
    /// The effective `commit.gpgSign`: Writer signs.
    pub on: bool,
    /// A signing key resolves (`user.signingkey`, or an ssh default key command).
    pub key: bool,
    /// Signed commits among the branch's recent ones.
    pub signed_history: bool,
}

impl Signing {
    /// The repository looks like it signs while the configuration does not say so.
    pub fn suggested(&self) -> bool {
        !self.on && self.signed_history
    }
}

/// The three settings a key resolves from, as `repo.rs` reads them (pure reads: nothing runs).
#[derive(Debug, Clone, Default)]
pub struct KeySettings {
    pub format: Option<String>,
    pub key: Option<String>,
    pub key_command: Option<String>,
}

impl KeySettings {
    /// Whether a key to sign with resolves, without reading it: `user.signingkey`, an ssh default
    /// key command, or OpenPGP's own default (`gpg.format` unset or `openpgp`: the first signature
    /// decides, Writer never runs the signer to find out).
    pub fn resolves(&self) -> bool {
        let openpgp = self
            .format
            .as_deref()
            .is_none_or(|f| f.is_empty() || f == "openpgp");
        let set = |v: &Option<String>| v.as_deref().is_some_and(|v| !v.is_empty());
        openpgp || set(&self.key) || set(&self.key_command)
    }
}

/// Why signing failed: the signer's own words, sanitized (no vault path, no credentials).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignError {
    pub details: String,
}

impl SignError {
    pub(super) fn new(details: impl Into<String>) -> SignError {
        SignError {
            details: details.into(),
        }
    }

    /// A tool's or gix's message with the vault path and credentials taken out.
    pub(super) fn from_text(text: &str, root: &Path) -> SignError {
        SignError::new(sanitize(text, root, &[]))
    }
}

/// The signature format (`gpg.format`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    OpenPgp,
    X509,
    Ssh,
}

/// The key as given to the signer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// A key id, identity or key file path.
    Id(OsString),
    /// An SSH public key written inline (`key::ssh-ed25519 ...`, the `key::` stripped): a private
    /// temporary file for the signer, which finds the private half in the agent (`-U`).
    Literal(Vec<u8>),
}

/// The signer as gix resolved it from the configuration.
#[derive(Debug, Clone)]
pub struct Signer {
    pub format: Format,
    pub program: OsString,
    /// Arguments before the fixed ones.
    pub args: Vec<OsString>,
    pub key: Key,
    /// Environment for the signer only.
    pub env: Vec<(OsString, OsString)>,
}

/// Writes `git config --local commit.gpgsign`: the repository's own config, never the global one.
pub fn set_local(exec: &Exec, root: &Path, on: bool) -> Result<(), SignError> {
    match exec.config_local(root, "commit.gpgsign", if on { "true" } else { "false" }) {
        Ok(out) if out.ok() => Ok(()),
        Ok(out) => Err(SignError::from_text(&out.stderr, root)),
        Err(e) => Err(run_failed(e)),
    }
}

fn run_failed(e: RunError) -> SignError {
    SignError::new(match e {
        RunError::Absent => "the signing program is not installed".into(),
        RunError::Timeout => "the signer did not answer in time".to_string(),
        RunError::Cancelled => "stopped".into(),
        RunError::Io(k) => k,
    })
}

/// The first line `gpg.ssh.defaultKeyCommand` prints: the command is run here, through `Exec`
/// (the scope, `SIGN_TIMEOUT`, the runner's deadline, killed on stop), never by gix. The caller
/// checks it is a key and hands it to gix as `user.signingkey`.
pub fn default_key(exec: &Exec, root: &Path, command: &str) -> Result<String, SignError> {
    let cmd = exec.program("sh", &["-c", command]);
    let out = exec
        .run_named("default key command", cmd, SIGN_TIMEOUT, None)
        .map_err(run_failed)?;
    if !out.ok() {
        return Err(SignError::from_text(&out.stderr, root));
    }
    match out.stdout.lines().next().map(str::trim) {
        Some(line) if !line.is_empty() => Ok(line.to_string()),
        _ => Err(SignError::new("The default key command printed no key")),
    }
}

/// A private (0600) file in the temporary directory, removed with it.
struct Scratch(PathBuf);

impl Scratch {
    fn with(bytes: &[u8]) -> Result<Scratch, SignError> {
        let path = std::env::temp_dir().join(format!(".writer-sign-{}", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let file = options.open(&path);
        let scratch = Scratch(path);
        let wrote = file.and_then(|mut f| f.write_all(bytes));
        wrote
            .map(|()| scratch)
            .map_err(|_| SignError::new("could not write a temporary signing file"))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The signer's command: its program, its own arguments and environment, then the fixed ones.
fn command(exec: &Exec, signer: &Signer, fixed: &[&std::ffi::OsStr]) -> std::process::Command {
    let mut cmd = exec.program_os(&signer.program);
    cmd.args(&signer.args).args(fixed);
    cmd.envs(signer.env.iter().map(|(k, v)| (k, v)));
    cmd
}

/// Runs the signer. The log line is the program's name and nothing else: the arguments hold the
/// key id.
fn run(
    exec: &Exec,
    signer: &Signer,
    cmd: std::process::Command,
    stdin: Option<Vec<u8>>,
) -> Result<super::transport::Output, RunError> {
    let name = Path::new(&signer.program)
        .file_name()
        .map_or_else(|| "signer".into(), |n| n.to_string_lossy().into_owned());
    exec.run_named(&name, cmd, SIGN_TIMEOUT, stdin)
}

/// A signature as git embeds it: the signer's CRLF line ends folded to LF.
fn fold_crlf(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    for (i, b) in input.iter().enumerate() {
        if !(*b == b'\r' && input.get(i + 1) == Some(&b'\n')) {
            out.push(*b);
        }
    }
    out
}

/// The armored signature of `payload` (a commit without its signature header), made by running
/// the signer with gix-object's argv:
/// - OpenPGP and X.509: `<program> [args] --status-fd=2 -bsau <key>`, the payload on stdin, the
///   signature on stdout, `[GNUPG:] SIG_CREATED ` on stderr;
/// - SSH: `<program> [args] -Y sign -n git -f <key file> [-U] <payload file>`, the signature in
///   `<payload file>.sig`.
///
/// Fails closed: a signer that fails, does not report a signature, times out (`SIGN_TIMEOUT`, the
/// runner's deadline) or is stopped gives an error, never an empty signature.
pub fn sign(
    exec: &Exec,
    root: &Path,
    signer: &Signer,
    payload: &[u8],
) -> Result<Vec<u8>, SignError> {
    let key_missing = matches!(&signer.key, Key::Id(k) if k.is_empty());
    if key_missing {
        return Err(SignError::new("A signing key is required"));
    }
    match signer.format {
        Format::OpenPgp | Format::X509 => sign_gpg(exec, root, signer, payload),
        Format::Ssh => sign_ssh(exec, root, signer, payload),
    }
}

fn sign_gpg(
    exec: &Exec,
    root: &Path,
    signer: &Signer,
    payload: &[u8],
) -> Result<Vec<u8>, SignError> {
    let Key::Id(key) = &signer.key else {
        return Err(SignError::new("An inline key needs an ssh signer"));
    };
    let cmd = command(
        exec,
        signer,
        &["--status-fd=2".as_ref(), "-bsau".as_ref(), key.as_os_str()],
    );
    let out = run(exec, signer, cmd, Some(payload.to_vec())).map_err(run_failed)?;
    if !out.ok() {
        return Err(SignError::from_text(
            &format!("{}\n{}", out.stderr, out.stdout),
            root,
        ));
    }
    if !out
        .stderr
        .lines()
        .any(|l| l.starts_with("[GNUPG:] SIG_CREATED "))
    {
        return Err(SignError::new(
            "The OpenPGP/X.509 signer did not report SIG_CREATED",
        ));
    }
    Ok(fold_crlf(out.stdout.as_bytes()))
}

fn sign_ssh(
    exec: &Exec,
    root: &Path,
    signer: &Signer,
    payload: &[u8],
) -> Result<Vec<u8>, SignError> {
    let literal;
    let key_file: &Path = match &signer.key {
        Key::Id(path) => Path::new(path),
        Key::Literal(bytes) => {
            literal = Scratch::with(bytes)?;
            &literal.0
        }
    };
    let payload_file = Scratch::with(payload)?;
    let mut signature_path = payload_file.0.as_os_str().to_owned();
    signature_path.push(".sig");
    // removed whatever happens next
    let signature = Scratch(PathBuf::from(signature_path));
    let mut fixed: Vec<&std::ffi::OsStr> = vec![
        "-Y".as_ref(),
        "sign".as_ref(),
        "-n".as_ref(),
        "git".as_ref(),
        "-f".as_ref(),
        key_file.as_os_str(),
    ];
    if matches!(signer.key, Key::Literal(_)) {
        fixed.push("-U".as_ref());
    }
    fixed.push(payload_file.0.as_os_str());
    let out = run(exec, signer, command(exec, signer, &fixed), None).map_err(run_failed)?;
    if !out.ok() {
        return Err(SignError::from_text(
            &format!("{}\n{}", out.stderr, out.stdout),
            root,
        ));
    }
    let bytes = std::fs::read(&signature.0)
        .map_err(|_| SignError::new("The SSH signer produced no signature"))?;
    Ok(fold_crlf(&bytes))
}
