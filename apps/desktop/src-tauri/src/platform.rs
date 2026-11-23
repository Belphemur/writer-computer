//! The desktop family the app runs on, as a value the pure parts of the shell (the menu
//! definition, the close policy) take as an argument so a test can pick either side. Only
//! `current` reads the build target.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    MacOs,
    /// Linux, and every other non-macOS desktop: no menu bar, no Dock.
    Linux,
}

impl Os {
    pub const fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }

    /// A close request on the main window hides it (a Dock click brings it back, state kept)
    /// on macOS. Elsewhere there is no Dock, so a close stays a close, and closing the last
    /// window ends the app through the same `RunEvent::Exit` path as a macOS quit (agent
    /// chats saved, git commits on close).
    pub fn hides_window_on_close(self, label: &str) -> bool {
        self == Os::MacOs && label == crate::MAIN_WINDOW_LABEL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_window_on_macos_hides_on_close() {
        assert!(Os::MacOs.hides_window_on_close("main"));
        assert!(!Os::MacOs.hides_window_on_close("w-1"));
        assert!(!Os::Linux.hides_window_on_close("main"));
        assert!(!Os::Linux.hides_window_on_close("w-1"));
    }
}
