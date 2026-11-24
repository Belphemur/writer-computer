//! The sessions of a backend that Writer still owes a delete: the one of a deleted chat when the
//! backend had no server running (or its feature was off), a helper session that was cut short.
//! Kept per backend and vault in a small file of the app data folder (`<app data>/<backend>/`,
//! never in the vault), as a list of session ids and nothing else, and handed back the next time
//! the backend's server for that vault is up. Ids only: no title, no path, no note text. Core
//! owns it, so a chat deleted while its backend's feature is off is remembered too.

use std::path::PathBuf;

/// A stable name for a vault: FNV-1a of its path, in hex. Never the path itself (it may name the
/// user), and the same vault is the same name between runs.
pub fn vault_id(root: &std::path::Path) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in root.to_string_lossy().bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// A backend id as a folder name: lowercase letters, digits and dashes, nothing else (the id comes
/// from a chat note, which anyone can edit: it must never walk out of the app data folder).
fn is_backend_folder(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A session id as a backend hands it out: letters, digits, `_` and `-`, of a sane length.
fn is_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Remembers, without any live feature, that `session` of `backend` is to be deleted when a server
/// of that backend for the vault at `root` next starts. Only for a backend `known` to the
/// registry and named as a plain folder, and a session id of the usual shape: anything else is
/// refused (a warning without the value, nothing written). Returns whether it was kept.
pub fn record(
    app_data: &std::path::Path,
    known: &[String],
    backend: &str,
    root: &std::path::Path,
    session: &str,
) -> bool {
    if !is_backend_folder(backend) || !known.iter().any(|k| k == backend) || !is_session_id(session)
    {
        log::warn!(target: "agent", "agent: a deleted chat's session was not kept (unknown backend or id)");
        return false;
    }
    PendingDeletes::new(app_data.join(backend)).add(&vault_id(root), session);
    true
}

/// More than this are never kept (a vault that never runs a server again must not grow a file).
const MAX: usize = 200;

pub struct PendingDeletes {
    dir: PathBuf,
    /// One writer at a time: adds come from the UI's delete and from the title thread.
    lock: parking_lot::Mutex<()>,
}

impl PendingDeletes {
    /// The files of one backend live in `dir` (`<app data>/<backend id>`).
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            lock: parking_lot::Mutex::new(()),
        }
    }

    fn name(vault: &str) -> String {
        format!("pending-delete-{vault}.json")
    }

    fn read(&self, vault: &str) -> Vec<String> {
        std::fs::read(self.dir.join(Self::name(vault)))
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
            .unwrap_or_default()
    }

    fn write(&self, vault: &str, ids: &[String]) {
        let name = Self::name(vault);
        if ids.is_empty() {
            let _ = std::fs::remove_file(self.dir.join(name));
            return;
        }
        let ok = std::fs::create_dir_all(&self.dir).is_ok()
            && serde_json::to_vec(ids).is_ok_and(|bytes| {
                crate::plugins::write_atomic_private(&self.dir, &name, &bytes, 0o600).is_ok()
            });
        if !ok {
            log::warn!(target: "agent", "agent: a session to delete later could not be kept");
        }
    }

    /// Remembers that `session` is still to be deleted (once).
    pub fn add(&self, vault: &str, session: &str) {
        let _one = self.lock.lock();
        let mut ids = self.read(vault);
        if ids.iter().any(|i| i == session) {
            return;
        }
        ids.push(session.to_string());
        if ids.len() > MAX {
            ids.remove(0);
        }
        self.write(vault, &ids);
    }

    /// Everything owed for the vault; the file is gone after it (a failed delete adds its id again).
    pub fn take(&self, vault: &str) -> Vec<String> {
        let _one = self.lock.lock();
        let ids = self.read(vault);
        self.write(vault, &[]);
        ids
    }

    #[cfg(test)]
    pub fn peek(&self, vault: &str) -> Vec<String> {
        self.read(vault)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_kept_once_per_vault_and_taken_once() {
        let dir = tempfile::tempdir().unwrap();
        let p = PendingDeletes::new(dir.path().join("backend"));
        p.add("v1", "ses_a");
        p.add("v1", "ses_a");
        p.add("v1", "ses_b");
        p.add("v2", "ses_c");
        assert_eq!(p.peek("v1"), ["ses_a", "ses_b"]);
        assert_eq!(p.take("v1"), ["ses_a", "ses_b"]);
        assert!(p.take("v1").is_empty());
        assert_eq!(p.take("v2"), ["ses_c"]);
    }

    #[test]
    fn the_list_is_capped_and_holds_nothing_but_ids() {
        let dir = tempfile::tempdir().unwrap();
        let p = PendingDeletes::new(dir.path().to_path_buf());
        for i in 0..(MAX + 5) {
            p.add("v", &format!("ses_{i}"));
        }
        let ids = p.take("v");
        assert_eq!(ids.len(), MAX);
        assert_eq!(ids.last().unwrap(), &format!("ses_{}", MAX + 4));
    }

    #[test]
    fn only_a_known_plain_backend_and_a_plain_session_id_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let root = std::path::Path::new("/vault");
        let known = ["fake-x".to_string(), "../evil".to_string()];
        // a known backend, a plain session id
        assert!(record(&data, &known, "fake-x", root, "ses_abc-1"));
        // a traversal id never walks out, even if a registry were to list it
        assert!(!record(&data, &known, "../evil", root, "ses_a"));
        assert!(!record(&data, &known, "../../x", root, "ses_a"));
        assert!(!record(&data, &known, "a/b", root, "ses_a"));
        assert!(!record(&data, &known, "", root, "ses_a"));
        // a backend the registry does not know
        assert!(!record(&data, &known, "other", root, "ses_a"));
        // a session id that is not an id
        assert!(!record(&data, &known, "fake-x", root, "../ses"));
        assert!(!record(&data, &known, "fake-x", root, ""));
        // only the one folder exists, and nothing was written beside the data folder
        let names = |p: &std::path::Path| {
            let mut v: Vec<_> = std::fs::read_dir(p)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            v.sort();
            v
        };
        assert_eq!(names(&data), ["fake-x"]);
        assert_eq!(names(dir.path()), ["data"]);
        assert_eq!(names(&data.join("fake-x")).len(), 1);
    }
}
