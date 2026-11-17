//! `Lazy<T>`: the one way a feature builds expensive state on first use.
//!
//! A feature's plugin `setup` must only create cheap, empty state (SPECs/builtin-plugins-spec.md
//! section 7.7): no threads, watchers, processes or SQLite handles. Put the expensive part in a
//! `Lazy<T>` field of that state and build it in the first command that needs it:
//!
//! ```ignore
//! #[derive(Default)]
//! struct State { index: Lazy<Index> }
//!
//! #[tauri::command]
//! async fn search(state: State<'_, State>, q: String) -> Result<Hits, AppError> {
//!     let index = state.index.get_or_try_init(|| async { Index::open().await }).await?;
//!     Ok(index.search(&q))
//! }
//! ```
//!
//! Concurrent first calls wait for one initialisation; a failed `get_or_try_init` leaves the cell
//! empty so the next call retries. `get()` never initialises, so a "status" command can report
//! whether the feature has started at all.

use std::future::Future;
use tokio::sync::OnceCell;

// The first user is the first real feature (ADR Step 2 and later).
#[allow(dead_code)]
pub struct Lazy<T>(OnceCell<T>);

impl<T> Default for Lazy<T> {
    fn default() -> Self {
        Self(OnceCell::new())
    }
}

#[allow(dead_code)]
impl<T> Lazy<T> {
    /// The value if it was already built; never builds it.
    pub fn get(&self) -> Option<&T> {
        self.0.get()
    }

    pub fn is_initialized(&self) -> bool {
        self.0.initialized()
    }

    /// Builds the value once; every other caller gets the same reference.
    pub async fn get_or_init<F: Future<Output = T>>(&self, init: impl FnOnce() -> F) -> &T {
        self.0.get_or_init(init).await
    }

    /// Like `get_or_init`, but an `Err` leaves the cell empty (the next call retries).
    pub async fn get_or_try_init<E, F: Future<Output = Result<T, E>>>(
        &self,
        init: impl FnOnce() -> F,
    ) -> Result<&T, E> {
        self.0.get_or_try_init(init).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn builds_exactly_once_even_for_concurrent_first_calls() {
        let builds = AtomicUsize::new(0);
        let lazy: Lazy<usize> = Lazy::default();
        assert!(!lazy.is_initialized());
        assert_eq!(lazy.get(), None);
        let build = || async {
            tokio::task::yield_now().await;
            builds.fetch_add(1, Ordering::SeqCst) + 1
        };
        let (a, b, c) = tokio::join!(
            lazy.get_or_init(build),
            lazy.get_or_init(build),
            lazy.get_or_init(build)
        );
        assert_eq!((*a, *b, *c), (1, 1, 1));
        assert_eq!(*lazy.get_or_init(build).await, 1);
        assert_eq!(builds.load(Ordering::SeqCst), 1);
        assert!(lazy.is_initialized());
    }

    #[tokio::test]
    async fn a_failed_init_leaves_it_empty_and_retries() {
        let lazy: Lazy<u8> = Lazy::default();
        let err = lazy
            .get_or_try_init(|| async { Err::<u8, _>("boom") })
            .await;
        assert_eq!(err.err(), Some("boom"));
        assert!(!lazy.is_initialized());
        let ok = lazy.get_or_try_init(|| async { Ok::<_, &str>(7) }).await;
        assert_eq!(ok.ok().copied(), Some(7));
    }
}
