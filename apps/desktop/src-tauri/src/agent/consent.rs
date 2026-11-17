//! The first-spawn consent of the agent pane (spec 6.4): the plugin host's dialog and
//! `ConsentStore`, under the pseudo plugin id `writer-agent`, remembered per vault in the same
//! `plugins_proc_consent.json`. "Always allow in this vault" is the store's wildcard for that id;
//! revoking vault trust clears it with every other consent of the vault (`plugins_set_trust`).
//!
//! This answers "may Writer start `claude` here?". What the agent may DO is the CLI's permission
//! system, surfaced as the permission card, and a remembered spawn consent never implies it.

use crate::plugin_consent::{ConsentStore, ANY_PROGRAM};
use crate::plugin_proc::{Consent, ConsentRequest, Decision};
use std::path::{Path, PathBuf};

/// Pseudo plugin id under which the pane's spawn consent is stored.
pub const AGENT_PLUGIN_ID: &str = "writer-agent";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Remembered, or the user said run once / always.
    Allowed,
    Denied,
    /// Trust or vault changed while the dialog was open.
    Changed,
}

/// Ask unless the vault already remembers "always". `display_args` is what the dialog shows
/// (the runner redacts the system-prompt value so a note's text never lands in a dialog).
#[allow(clippy::too_many_arguments)]
pub fn gate(
    store: &ConsentStore,
    consent: &dyn Consent,
    root: &Path,
    program: &Path,
    display_args: &[String],
    cwd: &Path,
    env_keys: &[String],
    still_ok: &dyn Fn() -> bool,
) -> Gate {
    if !store.is_allowed(root, AGENT_PLUGIN_ID, program) {
        let ask = ConsentRequest {
            plugin_id: AGENT_PLUGIN_ID.to_string(),
            vault: root.to_path_buf(),
            program: program.to_path_buf(),
            args: display_args.to_vec(),
            cwd: cwd.to_path_buf(),
            env_keys: env_keys.to_vec(),
            inherit_env: false,
        };
        match consent.ask(&ask) {
            Decision::Deny => return Gate::Denied,
            Decision::Once => {}
            Decision::Always => {
                if !still_ok() {
                    return Gate::Changed;
                }
                if let Err(e) = store.allow_plugin(root, AGENT_PLUGIN_ID) {
                    log::warn!("agent consent not remembered: {e}");
                }
            }
        }
    }
    if still_ok() {
        Gate::Allowed
    } else {
        Gate::Changed
    }
}

/// Answer used once the gate passed, so `ProcManager::spawn_with_consent` does not ask again
/// (it asks whenever the store does not hold the program, which a "Run once" never writes).
pub struct Preconsented;

impl Consent for Preconsented {
    fn ask(&self, _req: &ConsentRequest) -> Decision {
        Decision::Once
    }
}

/// The program a one-shot helper call (title regeneration) may run for a chat that has no live
/// session, `None` when the user never consented. Two ways to have consented, both the pane's own
/// spawn consent and never a new dialog: a chat of this window was started and allowed
/// (`window_consented`, "Run once" included), or the vault remembers "Always allow" for the
/// program `find` locates (`find` runs only when needed: it may start a login shell).
pub fn helper_program(
    window_consented: Option<PathBuf>,
    store: &ConsentStore,
    root: &Path,
    find: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    window_consented.or_else(|| find().filter(|p| store.is_allowed(root, AGENT_PLUGIN_ID, p)))
}

/// Forget the vault's "always allow" for the pane (Settings > Agent "Revoke").
pub fn revoke(store: &ConsentStore, root: &Path) -> Result<(), String> {
    store.revoke(root, AGENT_PLUGIN_ID, ANY_PROGRAM)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixed(Decision, AtomicUsize);
    impl Consent for Fixed {
        fn ask(&self, req: &ConsentRequest) -> Decision {
            self.1.fetch_add(1, Ordering::SeqCst);
            let m = req.message();
            assert!(m.contains("agent pane"), "agent wording: {m}");
            assert!(!m.contains("plugin"), "no plugin wording: {m}");
            self.0
        }
    }

    fn run(store: &ConsentStore, c: &Fixed, root: &Path, ok: bool) -> Gate {
        gate(
            store,
            c,
            root,
            Path::new("/bin/claude"),
            &["-p".into()],
            root,
            &[],
            &move || ok,
        )
    }

    #[test]
    fn helper_program_needs_a_window_consent_or_a_remembered_always() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConsentStore::new(dir.path().join("c.json"));
        let root = dir.path().join("v");
        std::fs::create_dir_all(&root).unwrap();
        let claude = || Some(PathBuf::from("/bin/claude"));
        // never consented: nothing may run, and the program is not even looked up when a
        // window consent exists
        assert_eq!(helper_program(None, &store, &root, claude), None);
        assert_eq!(
            helper_program(Some("/w/claude".into()), &store, &root, || unreachable!()),
            Some(PathBuf::from("/w/claude"))
        );
        // a program missing on disk is not a consent
        store.allow_plugin(&root, AGENT_PLUGIN_ID).unwrap();
        assert_eq!(helper_program(None, &store, &root, || None), None);
        assert_eq!(
            helper_program(None, &store, &root, claude),
            Some(PathBuf::from("/bin/claude"))
        );
        // another vault never inherits it
        let other = dir.path().join("w");
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(helper_program(None, &store, &other, claude), None);
    }

    #[test]
    fn once_always_deny_and_changed() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConsentStore::new(dir.path().join("c.json"));
        let root = dir.path().join("v");
        std::fs::create_dir_all(&root).unwrap();

        let deny = Fixed(Decision::Deny, AtomicUsize::new(0));
        assert_eq!(run(&store, &deny, &root, true), Gate::Denied);

        let once = Fixed(Decision::Once, AtomicUsize::new(0));
        assert_eq!(run(&store, &once, &root, true), Gate::Allowed);
        assert_eq!(run(&store, &once, &root, true), Gate::Allowed);
        assert_eq!(once.1.load(Ordering::SeqCst), 2, "once is not remembered");

        let always = Fixed(Decision::Always, AtomicUsize::new(0));
        assert_eq!(run(&store, &always, &root, false), Gate::Changed);
        assert!(
            !store.has_wildcard(&root, AGENT_PLUGIN_ID),
            "not remembered when changed"
        );
        assert_eq!(run(&store, &always, &root, true), Gate::Allowed);
        assert_eq!(run(&store, &always, &root, true), Gate::Allowed);
        assert_eq!(
            always.1.load(Ordering::SeqCst),
            2,
            "second start skips the dialog"
        );
        assert!(store.has_wildcard(&root, AGENT_PLUGIN_ID));

        revoke(&store, &root).unwrap();
        assert!(!store.has_wildcard(&root, AGENT_PLUGIN_ID));
        assert_eq!(run(&store, &deny, &root, true), Gate::Denied);
    }
}
