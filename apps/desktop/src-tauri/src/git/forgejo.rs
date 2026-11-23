//! The Forgejo CLI (`fj`) as a forge (ADR 2026-11-18, note of 2026-11-23). It has no command that
//! prints a token, so the credential helper reads `fj`'s own saved login at the moment of use,
//! for the one host git asks about:
//!
//! - **Hosts** are `fj auth list` (one host per line on stdout, no network): the CLI's own
//!   interface rather than its file, so a change of the file's shape cannot empty the page.
//! - **The token** is read from the saved login (`keys.json`). Only that host's `type`, `token`
//!   and `expires_at` are read; every other key and host is skipped unread, the token is never
//!   stored, logged or put in argv, and Writer never writes `fj`'s files. An unknown shape is no
//!   token.
//! - **Expiry**: an OAuth login carries `expires_at`; `fj` refreshes it itself, on any command
//!   that talks to the host, and saves the file. When the token is past `expires_at`, Writer runs
//!   one such command (`fj -H <host> whoami`, bounded, through [`Exec`]) and reads again; still
//!   expired is no token, and the sync says "Sign in again: fj auth login". Writer never refreshes
//!   a token itself.
//!
//! The file's path and shape come from forgejo-contrib/forgejo-cli 0.7.0 (`src/keys.rs`, MIT OR
//! Apache-2.0): `hosts` maps a host (`name[:port]`) to `{"type":"Application","token"}` or
//! `{"type":"OAuth","token","refresh_token","expires_at"}`, in the data directory of the
//! project `forgejo-cli/forgejo-cli`.

use super::forge::Forge;
use super::transport::{Exec, QUICK_TIMEOUT};
use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde::Deserialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub static FORGE: Forge = Forge {
    id: "fj",
    binary: "fj",
    version: &["version"],
    site: "Forgejo",
    label: "Forgejo CLI",
    login: "fj auth login",
    install_url: "https://codeberg.org/forgejo-contrib/forgejo-cli",
    expires: true,
    signed_in,
    token,
    accepts: |host, bound| bound.is_some_and(|b| b.eq_ignore_ascii_case(host)),
    create,
    owner,
    default_host: None,
    value_options: &["-H", "--host"],
};

fn create(host: Option<&str>, name: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(host) = host {
        args.extend(["-H".into(), host.into()]);
    }
    args.extend(["repo", "create", name, "--private"].map(String::from));
    args
}

/// The login of the account on `host`: `fj -H <host> whoami` says "... <name>@<host>" (the words
/// are localized, the `name@host` is not). It also makes `fj` refresh an expired login.
fn owner(exec: &Exec, host: Option<&str>) -> Option<String> {
    let host = host.filter(|h| is_host(h))?;
    let out = exec
        .run(
            exec.tool(FORGE.binary, &["-H", host, "whoami"]),
            QUICK_TIMEOUT,
        )
        .ok()
        .filter(|o| o.ok())?;
    owner_in(&out.stdout, host)
}

/// The `name` of the `name@host` word of `whoami`'s output (Fluent wraps arguments in bidi marks).
pub fn owner_in(stdout: &str, host: &str) -> Option<String> {
    let clean: String = stdout
        .chars()
        .filter(|c| !('\u{2066}'..='\u{2069}').contains(c))
        .collect();
    clean.split_whitespace().find_map(|word| {
        let (name, at) = word.rsplit_once('@')?;
        let valid = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        (valid && at.trim_end_matches(['.', ',']).eq_ignore_ascii_case(host))
            .then(|| name.to_string())
    })
}

// ---- hosts ---------------------------------------------------------------------------------------

fn signed_in(exec: &Exec) -> Option<Vec<String>> {
    let out = exec
        .run(exec.tool(FORGE.binary, &["auth", "list"]), QUICK_TIMEOUT)
        .ok()?;
    let hosts = if out.ok() {
        hosts_in(&out.stdout)
    } else {
        Vec::new()
    };
    (!hosts.is_empty()).then_some(hosts)
}

/// A host `fj auth list` prints: letters, digits and `.-_:`, starting with a letter or digit (never
/// an option), so it is safe as an argument and as a credential request's `host=`. A host with a
/// path (a forge under a sub-path) is skipped.
fn is_host(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_alphanumeric())
        && s.len() <= 255
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
}

/// The hosts in `fj auth list`'s output, once each, in order.
pub fn hosts_in(stdout: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for line in stdout.lines().map(str::trim).filter(|l| is_host(l)) {
        if !hosts.iter().any(|h| h.eq_ignore_ascii_case(line)) && hosts.len() < 32 {
            hosts.push(line.to_string());
        }
    }
    hosts
}

// ---- the saved login -----------------------------------------------------------------------------

/// `keys.json` in `fj`'s data directory (`directories::ProjectDirs::from("", "forgejo-cli",
/// "forgejo-cli")`), computed the way that crate does, from `var` (the environment).
pub fn login_file(var: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let absolute = |name: &str| var(name).map(PathBuf::from).filter(|p| p.is_absolute());
    let dir = if cfg!(target_os = "macos") {
        absolute("HOME")?.join("Library/Application Support/forgejo-cli.forgejo-cli")
    } else if cfg!(windows) {
        absolute("APPDATA")?.join(r"forgejo-cli\forgejo-cli\data")
    } else {
        absolute("XDG_DATA_HOME")
            .or_else(|| absolute("HOME").map(|h| h.join(".local/share")))?
            .join("forgejo-cli")
    };
    Some(dir.join("keys.json"))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Saved {
    /// A usable token.
    Token(Secret),
    /// An OAuth login past its `expires_at`, or one whose expiry cannot be read.
    Expired,
    /// No login for the host, or a shape Writer does not know.
    None,
}

/// A token; `Debug` shows nothing, so a stray `{:?}` cannot log it.
#[derive(PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// What Writer reads of one host's login. No `Debug`.
#[derive(Deserialize)]
struct Entry {
    #[serde(rename = "type")]
    kind: String,
    token: String,
    #[serde(default)]
    expires_at: Option<serde_json::Value>,
}

/// `keys.json` is read with visitors that deserialise the one wanted host and skip the rest.
struct File<'a>(&'a str);
struct Hosts<'a>(&'a str);

impl<'de> Visitor<'de> for File<'_> {
    type Value = Option<Entry>;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("fj's saved login")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut found = None;
        while let Some(key) = map.next_key::<String>()? {
            if key == "hosts" {
                found = map.next_value_seed(Hosts(self.0))?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(found)
    }
}

impl<'de> DeserializeSeed<'de> for Hosts<'_> {
    type Value = Option<Entry>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Hosts<'_> {
    type Value = Option<Entry>;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the hosts of fj's saved login")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut found = None;
        while let Some(key) = map.next_key::<String>()? {
            if key.eq_ignore_ascii_case(self.0) {
                found = Some(map.next_value::<Entry>()?);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(found)
    }
}

/// The login file is a few lines; anything bigger is not it.
const MAX_FILE: u64 = 1 << 20;

/// The login of `host` in the file at `path`, judged at `now` (unix seconds).
pub fn saved(path: &Path, host: &str, now: i64) -> Saved {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(path) else {
        return Saved::None;
    };
    let mut bytes = Vec::new();
    if file.take(MAX_FILE).read_to_end(&mut bytes).is_err() {
        return Saved::None;
    }
    let mut de = serde_json::Deserializer::from_slice(&bytes);
    let Ok(Some(entry)) = de.deserialize_map(File(host)) else {
        return Saved::None;
    };
    // a token that is empty or holds a control character would break git's line protocol
    let usable = !entry.token.is_empty() && !entry.token.chars().any(char::is_control);
    match entry.kind.as_str() {
        "Application" if usable => Saved::Token(Secret(entry.token)),
        "OAuth" if usable => match entry.expires_at.as_ref().and_then(unix_seconds) {
            Some(at) if now < at => Saved::Token(Secret(entry.token)),
            _ => Saved::Expired,
        },
        _ => Saved::None,
    }
}

/// `expires_at` as unix seconds. `fj` serialises a `time::OffsetDateTime`: by default the tuple
/// (year, ordinal, hour, minute, second, nanosecond, offset hours, minutes, seconds), with the
/// crate's `serde-human-readable` feature a string like `2026-11-23 10:00:00.0 +00:00:00`; both
/// are read, anything else is `None`.
pub fn unix_seconds(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::Array(a) if a.len() == 9 => {
            let n: Vec<i64> = a
                .iter()
                .map(serde_json::Value::as_i64)
                .collect::<Option<_>>()?;
            let days = days_from_civil(n[0], 1, 1)? + within(n[1], 1, 366)? - 1;
            seconds(days, n[2], n[3], n[4], n[6], n[7], n[8])
        }
        serde_json::Value::String(s) => parse_text(s),
        _ => None,
    }
}

/// `v` when it is in `lo..=hi`: every field is bounded before any arithmetic, so no input can
/// overflow (a value out of range is an expiry nobody can read, hence expired).
fn within(v: i64, lo: i64, hi: i64) -> Option<i64> {
    (lo..=hi).contains(&v).then_some(v)
}

/// The instant of `days` since the epoch plus a clock time, less the zone's offset (the sign is the
/// zone's: the same on its hours, minutes and seconds).
fn seconds(days: i64, h: i64, m: i64, s: i64, oh: i64, om: i64, os: i64) -> Option<i64> {
    let at = days * 86_400 + within(h, 0, 23)? * 3600 + within(m, 0, 59)? * 60 + within(s, 0, 60)?;
    let offset = within(oh, -26, 26)? * 3600 + within(om, -59, 59)? * 60 + within(os, -59, 59)?;
    Some(at - offset)
}

/// `YYYY-MM-DD`, `T` or a space, `HH:MM:SS[.frac]`, then `Z` or `±HH:MM[:SS]` (or nothing: UTC).
fn parse_text(s: &str) -> Option<i64> {
    let (date, rest) = s.trim().split_once(['T', ' '])?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let rest = rest.trim();
    let split = rest.find(['Z', '+', '-', ' ']).unwrap_or(rest.len());
    let (clock, zone) = rest.split_at(split);
    let mut t = clock.split(':');
    let hh: i64 = t.next()?.parse().ok()?;
    let mm: i64 = t.next()?.parse().ok()?;
    let ss: i64 = t.next()?.split('.').next()?.parse().ok()?;
    let zone = zone.trim();
    let (oh, om, os) = match zone.chars().next() {
        None | Some('Z') => (0, 0, 0),
        Some(sign @ ('+' | '-')) => {
            let mut z = zone[1..].split(':').map(|p| p.parse::<i64>().ok());
            let hours = z.next()??;
            let minutes = z.next().flatten().unwrap_or(0);
            let seconds = z.next().flatten().unwrap_or(0);
            let k = if sign == '-' { -1 } else { 1 };
            // bounded first: `k *` on an `i64::MIN`-sized value must not overflow
            (
                within(hours, 0, 26)? * k,
                within(minutes, 0, 59)? * k,
                within(seconds, 0, 59)? * k,
            )
        }
        _ => return None,
    };
    seconds(days_from_civil(y, m, day)?, hh, mm, ss, oh, om, os)
}

/// Days since 1970-01-01 of a proleptic Gregorian date in 1970..=9999 (Howard Hinnant's
/// algorithm); a year out of that range is no date for a login that expires.
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    within(y, 1970, 9999)?;
    within(m, 1, 12)?;
    within(d, 1, 31)?;
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// The token `fj` holds for `host`, read now; an expired one is refreshed by `fj` itself once.
fn token(exec: &Exec, host: &str) -> Option<String> {
    if !is_host(host) {
        return None;
    }
    let path = login_file(&|name| exec.var(name))?;
    match saved(&path, host, now()) {
        Saved::Token(t) => Some(t.0),
        Saved::None => None,
        Saved::Expired => {
            // any `fj` command that talks to the host refreshes an expired login and saves it
            let _ = exec.run(
                exec.tool(FORGE.binary, &["-H", host, "whoami"]),
                QUICK_TIMEOUT,
            );
            match saved(&path, host, now()) {
                Saved::Token(t) => Some(t.0),
                _ => None,
            }
        }
    }
}
