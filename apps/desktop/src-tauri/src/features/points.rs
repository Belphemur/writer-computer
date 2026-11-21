//! Points a feature owns and other features extend (ADR 2026-11-20 "let features cooperate
//! through owned points, optional services and rare requires"). This is the Rust registry for the
//! first kind, the **hook**: the owner notifies, contributors react.
//!
//! - The owner declares a typed key in its public `api` module (`static P: Point<Args>`) and calls
//!   [`emit`] where the thing happens. It never learns who listens: with no contributor `emit`
//!   returns at once, which is exactly the behaviour of the app without the contributor.
//! - A contributor calls [`extend`] from its `Feature::setup`. The handler is wrapped once here:
//!   it is skipped while the contributor or the point's owner is off (read live from the
//!   settings), and it runs under `features::guard`, so a panic fails the contributor, never the
//!   owner or the other contributors.
//! - Contributors run in id order, never in registration order. A handler must be quick or hand
//!   its work to a thread of its own; an owner that wants a handler to finish before it goes on
//!   (the agent's `turn-started`) calls `emit` from a thread that may block.
//!
//! Providers, transforms and services of the ADR are not built yet: they land with their first
//! user, in this file, without changing the hook API.

use super::{guard, is_live_id, Boundary};
use parking_lot::RwLock;
use std::any::Any;
use std::marker::PhantomData;
use std::sync::Arc;
use tauri::{AppHandle, Runtime};

/// A named hook, typed by its arguments. Declared by the owner (`id` is `<owner>.<point>`).
pub struct Point<A: 'static> {
    pub id: &'static str,
    pub owner: &'static str,
    args: PhantomData<fn(&A)>,
}

impl<A: 'static> Point<A> {
    pub const fn new(id: &'static str, owner: &'static str) -> Self {
        Point {
            id,
            owner,
            args: PhantomData,
        }
    }
}

type Handler<A> = Arc<dyn Fn(&A) + Send + Sync + 'static>;

struct Entry {
    point: &'static str,
    contributor: &'static str,
    handler: Box<dyn Any + Send + Sync>,
}

static REGISTRY: RwLock<Vec<Entry>> = RwLock::new(Vec::new());

/// Adds `handler` to `point` for feature `contributor` (its manifest `extends` names the point).
/// Registering twice for one point and contributor replaces the first, so a repeated `setup`
/// never doubles a reaction.
pub fn extend<R: Runtime, A: 'static>(
    app: &AppHandle<R>,
    point: &'static Point<A>,
    contributor: &'static str,
    handler: impl Fn(&A) + Send + Sync + 'static,
) {
    let app = app.clone();
    let wrapped: Handler<A> = Arc::new(move |args: &A| {
        if !is_live_id(&app, contributor) || !is_live_id(&app, point.owner) {
            return;
        }
        let _ = guard(&app, contributor, Boundary::Hook(point.id), || {
            handler(args)
        });
    });
    let mut registry = REGISTRY.write();
    registry.retain(|e| !(e.point == point.id && e.contributor == contributor));
    registry.push(Entry {
        point: point.id,
        contributor,
        handler: Box::new(wrapped),
    });
}

/// Calls every contributor of `point`, in contributor id order.
pub fn emit<A: 'static>(point: &Point<A>, args: &A) {
    let handlers: Vec<Handler<A>> = {
        let registry = REGISTRY.read();
        if registry.is_empty() {
            return;
        }
        let mut found: Vec<(&'static str, Handler<A>)> = registry
            .iter()
            .filter(|e| e.point == point.id)
            .filter_map(|e| {
                e.handler
                    .downcast_ref::<Handler<A>>()
                    .map(|h| (e.contributor, Arc::clone(h)))
            })
            .collect();
        found.sort_by_key(|(id, _)| *id);
        found.into_iter().map(|(_, h)| h).collect()
    };
    for handler in handlers {
        handler(args);
    }
}

/// How many features extend `point` (tests, and the contract check).
pub fn contributors(point: &str) -> usize {
    REGISTRY.read().iter().filter(|e| e.point == point).count()
}

/// Does `contributor` extend `point`?
#[cfg(test)]
pub fn extended_by(point: &str, contributor: &str) -> bool {
    REGISTRY
        .read()
        .iter()
        .any(|e| e.point == point && e.contributor == contributor)
}

/// Drops all of a feature's contributions: what its shutdown releases.
pub fn retract(contributor: &str) {
    REGISTRY.write().retain(|e| e.contributor != contributor);
}

/// Adds a handler with no liveness check or guard (tests only: a probe that is not a feature).
#[cfg(test)]
pub fn extend_raw<A: 'static>(
    point: &'static Point<A>,
    contributor: &'static str,
    handler: impl Fn(&A) + Send + Sync + 'static,
) {
    let handler: Handler<A> = Arc::new(handler);
    let mut registry = REGISTRY.write();
    registry.retain(|e| !(e.point == point.id && e.contributor == contributor));
    registry.push(Entry {
        point: point.id,
        contributor,
        handler: Box::new(handler),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static P: Point<String> = Point::new("test-owner.ordered", "test-owner");
    static NONE: Point<()> = Point::new("test-owner.nobody", "test-owner");

    #[test]
    fn emit_with_no_contributor_returns_at_once() {
        emit(&NONE, &());
        assert_eq!(contributors(NONE.id), 0);
    }

    #[test]
    fn contributors_run_in_id_order_whatever_the_registration_order() {
        static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
        extend_raw(&P, "zz-second", |a| {
            SEEN.lock().unwrap().push(format!("zz {a}"))
        });
        extend_raw(&P, "aa-first", |a| {
            SEEN.lock().unwrap().push(format!("aa {a}"))
        });
        emit(&P, &"x".to_string());
        retract("zz-second");
        retract("aa-first");
        assert_eq!(*SEEN.lock().unwrap(), vec!["aa x", "zz x"]);
        assert_eq!(contributors(P.id), 0);
    }

    #[test]
    fn registering_twice_replaces_the_first() {
        extend_raw(&P, "dup", |_| {});
        extend_raw(&P, "dup", |_| {});
        assert_eq!(contributors(P.id), 1);
        retract("dup");
    }
}
