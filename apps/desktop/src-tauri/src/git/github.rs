//! The GitHub CLI as a forge: signed in when `gh auth status` succeeds, the token is `gh auth
//! token --hostname <host>` read at use, the repository is `gh repo create <name> --private` on
//! `gh`'s default host.

use super::forge::Forge;
use super::transport::{Exec, QUICK_TIMEOUT};

pub static FORGE: Forge = Forge {
    id: "gh",
    binary: "gh",
    version: &["--version"],
    site: "GitHub",
    label: "GitHub CLI",
    login: "gh auth login",
    install_url: "https://cli.github.com",
    expires: false,
    signed_in,
    token,
    accepts: |host, _| github_host(host),
    owner,
    default_host: Some("github.com"),
    create: |_, name| {
        ["repo", "create", name, "--private"]
            .map(String::from)
            .to_vec()
    },
};

fn signed_in(exec: &Exec) -> Option<Vec<String>> {
    match exec.run(exec.tool("gh", &["auth", "status"]), QUICK_TIMEOUT) {
        Ok(o) if o.ok() => Some(Vec::new()),
        _ => None,
    }
}

/// The token `gh` holds for `host`; never stored by Writer.
fn token(exec: &Exec, host: &str) -> Option<String> {
    let out = exec
        .run(
            exec.tool("gh", &["auth", "token", "--hostname", host]),
            QUICK_TIMEOUT,
        )
        .ok()?;
    let token = out.stdout.trim();
    (out.ok() && !token.is_empty()).then(|| token.to_string())
}

/// `gh`'s token is for GitHub's hosts only.
fn github_host(host: &str) -> bool {
    host == "github.com" || host.ends_with(".github.com") || host.ends_with(".ghe.com")
}

/// The login of the account `gh` is signed in as.
fn owner(exec: &Exec, host: Option<&str>) -> Option<String> {
    let mut args = vec!["api", "user", "--jq", ".login"];
    if let Some(host) = host {
        args.extend(["--hostname", host]);
    }
    let out = exec
        .run(exec.tool("gh", &args), QUICK_TIMEOUT)
        .ok()
        .filter(|o| o.ok())?;
    let login = out.stdout.trim();
    (!login.is_empty() && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .then(|| login.to_string())
}
