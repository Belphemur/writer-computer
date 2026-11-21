//! Points a feature owns and other features extend (ADR 2026-11-20 "let features cooperate
//! through owned points, optional services and rare requires"). This is the Rust registry for the
//! first kind, the **hook**: the owner notifies, contributors react.
//!
//! - The owner declares a typed key in its public `api` module (`static P: Point<Args>`) and calls
//!   [`emit`] where the thing happens. It never learns who listens: with no contributor `emit`
//!   returns at once, which is exactly the behaviour of the app without the contributor.
//! - A contributor calls [`extend`] from its `Feature::start` (the feature's scope retracts the extensions when it stops). The handler is wrapped once here:
//!   it is skipped while the contributor is not live (started and not failed, `features::is_live`),
//!   and it runs under `features::guard`, so a panic fails the contributor, never the owner or the
//!   other contributors. The owner is not checked: an owner that emits is running, and one that
//!   is being switched off or has failed still announces the end of what it was doing (the
//!   agent's `turn-finished` after its stop), which a contributor must hear.
//! - The registry is [`Points`], managed app state (one per `AppHandle`, so a test app never
//!   sees another's contributors). The owner's core is Tauri-free and is handed a `Points` clone
//!   at construction (`AgentSessions::with_spawner`); it calls [`Points::emit`].
//! - Contributors run in id order, never in registration order. A handler must be quick or hand
//!   its work to a thread of its own; an owner that wants a handler to finish before it goes on
//!   (the agent's `turn-started`) calls `emit` from a thread that may block.
//!
//! Providers, transforms and services of the ADR are not built yet: they land with their first
//! user, in this file, without changing the hook API.

use super::{guard, is_live, Boundary};
use parking_lot::RwLock;
use std::any::Any;
use std::marker::PhantomData;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

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
    contributor: String,
    handler: Box<dyn Any + Send + Sync>,
}

/// The contributions of one app. Cloning shares them. Managed by `features::install`.
#[derive(Clone, Default)]
pub struct Points(Arc<RwLock<Vec<Entry>>>);

impl Points {
    fn add<A: 'static>(&self, point: &'static str, contributor: &str, handler: Handler<A>) {
        let mut registry = self.0.write();
        registry.retain(|e| !(e.point == point && e.contributor == contributor));
        registry.push(Entry {
            point,
            contributor: contributor.to_string(),
            handler: Box::new(handler),
        });
    }

    /// Calls every contributor of `point`, in contributor id order.
    pub fn emit<A: 'static>(&self, point: &Point<A>, args: &A) {
        let handlers: Vec<Handler<A>> = {
            let registry = self.0.read();
            if registry.is_empty() {
                return;
            }
            let mut found: Vec<(&str, Handler<A>)> = registry
                .iter()
                .filter(|e| e.point == point.id)
                .filter_map(|e| {
                    e.handler
                        .downcast_ref::<Handler<A>>()
                        .map(|h| (e.contributor.as_str(), Arc::clone(h)))
                })
                .collect();
            found.sort_by_key(|(id, _)| *id);
            found.into_iter().map(|(_, h)| h).collect()
        };
        for handler in handlers {
            handler(args);
        }
    }

    /// How many features extend `point` (the owner skips its work with none; tests).
    pub fn contributors(&self, point: &str) -> usize {
        self.0.read().iter().filter(|e| e.point == point).count()
    }

    /// Does `contributor` extend `point`?
    #[cfg(test)]
    pub fn extended_by(&self, point: &str, contributor: &str) -> bool {
        self.0
            .read()
            .iter()
            .any(|e| e.point == point && e.contributor == contributor)
    }

    /// Drops all of a feature's contributions.
    pub fn retract(&self, contributor: &str) {
        self.0.write().retain(|e| e.contributor != contributor);
    }

    /// Adds a handler with no liveness check or guard (tests only: a probe that is not a feature).
    #[cfg(test)]
    pub fn extend_raw<A: 'static>(
        &self,
        point: &'static Point<A>,
        contributor: &str,
        handler: impl Fn(&A) + Send + Sync + 'static,
    ) {
        self.add(point.id, contributor, Arc::new(handler));
    }
}

/// Adds `handler` to `point` for feature `contributor` (its manifest `extends` names the point).
/// Registering twice for one point and contributor replaces the first, so a repeated `start`
/// never doubles a reaction. The lifecycle retracts a feature's contributions when it stops
/// (`lifecycle::release`).
pub fn extend<R: Runtime, A: 'static>(
    app: &AppHandle<R>,
    point: &'static Point<A>,
    contributor: &'static str,
    handler: impl Fn(&A) + Send + Sync + 'static,
) {
    let Some(points) = app.try_state::<Points>() else {
        log::warn!("feature {contributor}: points are not installed");
        return;
    };
    let wrapped: Handler<A> = {
        let app = app.clone();
        Arc::new(move |args: &A| {
            if !is_live(&app, contributor) {
                return;
            }
            let _ = guard(&app, contributor, Boundary::Hook(point.id), || {
                handler(args)
            });
        })
    };
    points.add(point.id, contributor, wrapped);
}

/// Drops what feature `contributor` extended: its stop releases it.
pub(super) fn retract<R: Runtime>(app: &AppHandle<R>, contributor: &str) {
    if let Some(points) = app.try_state::<Points>() {
        points.retract(contributor);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static P: Point<String> = Point::new("test-owner.ordered", "test-owner");
    static NONE: Point<()> = Point::new("test-owner.nobody", "test-owner");

    #[test]
    fn emit_with_no_contributor_returns_at_once() {
        let points = Points::default();
        points.emit(&NONE, &());
        assert_eq!(points.contributors(NONE.id), 0);
    }

    #[test]
    fn contributors_run_in_id_order_whatever_the_registration_order() {
        let points = Points::default();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        for (id, tag) in [("zz-second", "zz"), ("aa-first", "aa")] {
            let seen = Arc::clone(&seen);
            points.extend_raw(&P, id, move |a| {
                seen.lock().unwrap().push(format!("{tag} {a}"))
            });
        }
        points.emit(&P, &"x".to_string());
        points.retract("zz-second");
        points.retract("aa-first");
        assert_eq!(*seen.lock().unwrap(), vec!["aa x", "zz x"]);
        assert_eq!(points.contributors(P.id), 0);
    }

    #[test]
    fn registering_twice_replaces_the_first() {
        let points = Points::default();
        points.extend_raw(&P, "dup", |_| {});
        points.extend_raw(&P, "dup", |_| {});
        assert_eq!(points.contributors(P.id), 1);
        points.retract("dup");
    }

    #[test]
    fn two_registries_never_see_each_other() {
        let (a, b) = (Points::default(), Points::default());
        a.extend_raw(&P, "only-a", |_| {});
        assert_eq!(a.contributors(P.id), 1);
        assert_eq!(b.contributors(P.id), 0);
    }
}
