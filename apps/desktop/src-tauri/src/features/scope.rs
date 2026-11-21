//! The owning scope of a started feature (ADR 2026-11-20 "start and stop features live through an
//! owning scope, with leak guardrails").
//!
//! Every start of a feature receives a fresh [`FeatureScope`]; stopping the feature drops it.
//! Everything a feature holds while it runs goes through the scope, so that stopping releases it
//! by construction instead of by hand-written cleanup:
//!
//! - [`FeatureScope::spawn`]: a thread, started under `features::guard` (a panic fails the
//!   feature, not the app) and handed the scope's [`CancelToken`];
//! - [`FeatureScope::process`]: a child process in its own process group, killed with its
//!   grandchildren when the owner drops it or the scope stops;
//! - [`FeatureScope::timer`]: a repeating job on a scope thread;
//! - [`FeatureScope::observe`]: a watcher observer, unregistered on stop;
//! - [`FeatureScope::listen`]: an app event listener, removed on stop;
//! - [`FeatureScope::manage`] / [`FeatureScope::state`]: the feature's state, dropped on stop (it
//!   replaces feature-level statics and `Lazy` state: a static can never be dropped);
//! - points a feature extends (`features::points::extend`, contributor = the feature id) are
//!   retracted by the lifecycle when it stops (`lifecycle::release`);
//! - [`FeatureScope::on_stop`]: a closure for what has no kind of its own (a flush);
//! - [`FeatureScope::adopt`]: a manager that owns its resources itself (a process table, a stream
//!   registry) is counted in the census and stopped through `on_stop`;
//! - [`FeatureScope::busy`] / [`FeatureScope::busy_probe`]: "work is in progress", read by the
//!   Features section before it turns the feature off.
//!
//! [`FeatureScope::shutdown`] stops a scope in this order: observers and listeners go (nothing
//! new arrives), the cancellation token fires, the `on_stop` closures run in reverse, process
//! groups are killed, the state is dropped (channels close, so worker threads end), threads are
//! joined with a bounded wait, and whatever is still alive is counted ([`Counts`]) and killed
//! where it can be. A scope that has stopped refuses every new resource.
//!
//! The scope is Tauri-free except for [`FeatureScope::listen`]; the agent's pure core only sees
//! [`Spawner`] and [`CancelToken`].

use crate::watcher::{self, ObserverHandle, PathObserver};
use parking_lot::{Condvar, Mutex};
use std::any::{Any, TypeId};
use std::collections::{BTreeMap, HashMap};
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Listener, Runtime};

/// How long a stop waits for the scope's threads before it counts them as leftovers.
pub const JOIN_WAIT: Duration = Duration::from_secs(5);

// ---------- cancellation ----------

/// A one-way flag with an interruptible sleep: the scope fires it on stop, long-running scope
/// code checks it or sleeps on it instead of on the clock.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<(Mutex<bool>, Condvar)>);

impl CancelToken {
    pub fn is_cancelled(&self) -> bool {
        *self.0 .0.lock()
    }

    pub fn cancel(&self) {
        *self.0 .0.lock() = true;
        self.0 .1.notify_all();
    }

    /// Sleeps for `d`; `false` when the token fired first (the caller should return).
    pub fn sleep(&self, d: Duration) -> bool {
        let deadline = Instant::now() + d;
        let mut cancelled = self.0 .0.lock();
        while !*cancelled {
            if self.0 .1.wait_until(&mut cancelled, deadline).timed_out() {
                return !*cancelled;
            }
        }
        false
    }
}

// ---------- the census ----------

/// The kinds of resource a scope counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[allow(dead_code)]
pub enum Kind {
    Thread,
    Process,
    Timer,
    Observer,
    Listener,
    State,
}

impl Kind {
    pub const fn name(self) -> &'static str {
        match self {
            Kind::Thread => "thread",
            Kind::Process => "process",
            Kind::Timer => "timer",
            Kind::Observer => "observer",
            Kind::Listener => "listener",
            Kind::State => "state handle",
        }
    }
}

/// Live resources per kind; kinds with none are absent, so "nothing leaked" is `is_empty()`.
pub type Counts = BTreeMap<Kind, usize>;

/// "1 process, 2 threads": what a warning or a log line says about a leak.
pub fn describe(counts: &Counts) -> String {
    counts
        .iter()
        .map(|(k, n)| format!("{n} {}{}", k.name(), if *n == 1 { "" } else { "s" }))
        .collect::<Vec<_>>()
        .join(", ")
}

fn add(counts: &mut Counts, kind: Kind, n: usize) {
    if n > 0 {
        *counts.entry(kind).or_insert(0) += n;
    }
}

// ---------- threads for code that must stay Tauri-free ----------

type SpawnFn =
    dyn Fn(&'static str, Box<dyn FnOnce(CancelToken) + Send>) -> io::Result<()> + Send + Sync;
type ProcessFn = dyn Fn(&mut Command) -> io::Result<ScopedChild> + Send + Sync;

/// What a Tauri-free core (the agent) is given to start its threads and child processes: the
/// scope's `spawn` and `process` and its token, without the scope. After the scope stopped,
/// both are refused.
#[derive(Clone)]
pub struct Spawner {
    spawn: Arc<SpawnFn>,
    process: Arc<ProcessFn>,
    token: CancelToken,
}

impl Spawner {
    pub fn spawn(
        &self,
        name: &'static str,
        f: impl FnOnce(CancelToken) + Send + 'static,
    ) -> io::Result<()> {
        (self.spawn)(name, Box::new(f))
    }

    /// A child process in its own process group (see [`FeatureScope::process`]).
    pub fn process(&self, cmd: &mut Command) -> io::Result<ScopedChild> {
        (self.process)(cmd)
    }

    pub fn token(&self) -> &CancelToken {
        &self.token
    }

    /// An interruptible sleep (`false`: the scope stopped, do not go on).
    pub fn sleep(&self, d: Duration) -> bool {
        self.token.sleep(d)
    }

    /// Plain threads and a token that never fires: for the CLI, which has no feature host, and
    /// for tests of a pure core. Never used by the app.
    pub fn detached() -> Self {
        Self {
            spawn: Arc::new(|name, f| {
                let token = CancelToken::default();
                std::thread::Builder::new()
                    .name(name.into())
                    .spawn(move || f(token))
                    .map(drop)
            }),
            process: Arc::new(|cmd| {
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    cmd.process_group(0);
                }
                let child = cmd.spawn()?;
                let cell = Arc::new(ChildCell {
                    pid: child.id(),
                    done: AtomicBool::new(false),
                });
                Ok(ScopedChild { child, cell })
            }),
            token: CancelToken::default(),
        }
    }
}

// ---------- processes ----------

#[cfg(unix)]
fn kill_group(pid: u32) {
    // SAFETY: signals the process group of a child this scope started with `process_group(0)`
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

struct ChildCell {
    pid: u32,
    /// Reaped or dropped: its group id may be reused, so it is never signalled again.
    done: AtomicBool,
}

impl ChildCell {
    fn kill(&self) {
        if !self.done.load(Ordering::SeqCst) {
            kill_group(self.pid);
        }
    }
}

/// A child process of a scope, alone in its process group. Dropping it kills the group (the
/// child's own children too) and reaps the child; the scope does the same for every child still
/// registered when it stops.
pub struct ScopedChild {
    child: Child,
    cell: Arc<ChildCell>,
}

impl ScopedChild {
    pub fn id(&self) -> u32 {
        self.cell.pid
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.cell.done.store(true, Ordering::SeqCst);
        }
        Ok(status)
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait()?;
        self.cell.done.store(true, Ordering::SeqCst);
        Ok(status)
    }

    /// Kills the whole group and reaps the child.
    pub fn kill(&mut self) {
        self.cell.kill();
        let _ = self.child.kill();
        let _ = self.wait();
    }
}

impl Drop for ScopedChild {
    fn drop(&mut self) {
        if !self.cell.done.load(Ordering::SeqCst) {
            self.kill();
        }
    }
}

// ---------- the scope ----------

type StopFn = Box<dyn FnOnce() + Send>;
type Wrap = Arc<dyn Fn(&'static str, Box<dyn FnOnce() + Send>) + Send + Sync>;
type CountFn = Arc<dyn Fn() -> usize + Send + Sync>;
type ProbeFn = Box<dyn Fn() -> Option<String> + Send + Sync>;

#[derive(Default)]
struct Parts {
    /// `Kind::Thread` or `Kind::Timer`.
    threads: Vec<(Kind, JoinHandle<()>)>,
    processes: Vec<Arc<ChildCell>>,
    observers: Vec<ObserverHandle>,
    /// Each removes one listener.
    listeners: Vec<StopFn>,
    state: HashMap<TypeId, Arc<dyn Any + Send + Sync>>,
    on_stop: Vec<StopFn>,
    adopted: Vec<(Kind, CountFn)>,
    busy: Option<String>,
    busy_probe: Option<ProbeFn>,
}

struct Inner {
    id: String,
    token: CancelToken,
    /// Runs a scope thread under `features::guard`; `None` in tests of the scope itself.
    wrap: Option<Wrap>,
    stopped: AtomicBool,
    parts: Mutex<Parts>,
}

/// The scope of one started feature. Cloning shares it; the feature stops when `shutdown` runs
/// (or the last clone drops).
#[derive(Clone)]
pub struct FeatureScope(Arc<Inner>);

fn refused(id: &str) -> io::Error {
    io::Error::other(format!("feature {id} has stopped"))
}

#[allow(dead_code)] // the surface every feature may use; features migrate onto it one by one
impl FeatureScope {
    /// A scope whose threads run through `wrap` (the lifecycle passes `features::guard`).
    pub fn new(id: &str, wrap: Option<Wrap>) -> Self {
        Self(Arc::new(Inner {
            id: id.to_string(),
            token: CancelToken::default(),
            wrap,
            stopped: AtomicBool::new(false),
            parts: Mutex::new(Parts::default()),
        }))
    }

    pub fn id(&self) -> &str {
        &self.0.id
    }

    pub fn token(&self) -> &CancelToken {
        &self.0.token
    }

    pub fn is_stopped(&self) -> bool {
        self.0.stopped.load(Ordering::SeqCst)
    }

    fn spawn_kind(
        &self,
        kind: Kind,
        name: &'static str,
        f: impl FnOnce(CancelToken) + Send + 'static,
    ) -> io::Result<()> {
        let mut parts = self.0.parts.lock();
        if self.is_stopped() {
            return Err(refused(&self.0.id));
        }
        parts.threads.retain(|(_, h)| !h.is_finished());
        let token = self.0.token.clone();
        let wrap = self.0.wrap.clone();
        let handle = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let run: Box<dyn FnOnce() + Send> = Box::new(move || f(token));
                match wrap {
                    Some(w) => w(name, run),
                    None => run(),
                }
            })?;
        parts.threads.push((kind, handle));
        Ok(())
    }

    /// A thread of the feature; it gets the scope's token and should return when it fires.
    pub fn spawn(
        &self,
        name: &'static str,
        f: impl FnOnce(CancelToken) + Send + 'static,
    ) -> io::Result<()> {
        self.spawn_kind(Kind::Thread, name, f)
    }

    /// Runs `f` every `every` until the scope stops (the first run is one period after the call).
    pub fn timer(
        &self,
        name: &'static str,
        every: Duration,
        mut f: impl FnMut() + Send + 'static,
    ) -> io::Result<()> {
        self.spawn_kind(Kind::Timer, name, move |token| {
            while token.sleep(every) {
                f();
            }
        })
    }

    /// The scope's `spawn` for a core that must stay Tauri-free; it holds the scope weakly, so a
    /// stopped scope is not kept alive by the core's state.
    pub fn spawner(&self) -> Spawner {
        let weak: Weak<Inner> = Arc::downgrade(&self.0);
        Spawner {
            token: self.0.token.clone(),
            spawn: Arc::new({
                let weak = weak.clone();
                move |name, f| match weak.upgrade() {
                    Some(inner) => FeatureScope(inner).spawn(name, f),
                    None => Err(io::Error::other("feature scope is gone")),
                }
            }),
            process: Arc::new(move |cmd| match weak.upgrade() {
                Some(inner) => FeatureScope(inner).process(cmd),
                None => Err(io::Error::other("feature scope is gone")),
            }),
        }
    }

    /// Starts `cmd` alone in its process group. The caller owns the child; the scope kills the
    /// group if the child is still running when the feature stops.
    pub fn process(&self, cmd: &mut Command) -> io::Result<ScopedChild> {
        let mut parts = self.0.parts.lock();
        if self.is_stopped() {
            return Err(refused(&self.0.id));
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let child = cmd.spawn()?;
        let cell = Arc::new(ChildCell {
            pid: child.id(),
            done: AtomicBool::new(false),
        });
        parts.processes.retain(|c| !c.done.load(Ordering::SeqCst));
        parts.processes.push(Arc::clone(&cell));
        Ok(ScopedChild { child, cell })
    }

    /// Registers a consumer of the watcher's changed paths until the scope stops.
    pub fn observe(&self, observer: PathObserver) -> io::Result<()> {
        let mut parts = self.0.parts.lock();
        if self.is_stopped() {
            return Err(refused(&self.0.id));
        }
        parts.observers.push(watcher::observe_paths(observer));
        Ok(())
    }

    /// Listens to an app event until the scope stops.
    pub fn listen<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        event: &str,
        handler: impl Fn(tauri::Event) + Send + 'static,
    ) -> io::Result<()> {
        let mut parts = self.0.parts.lock();
        if self.is_stopped() {
            return Err(refused(&self.0.id));
        }
        let id = app.listen(event.to_string(), handler);
        let app = app.clone();
        parts.listeners.push(Box::new(move || app.unlisten(id)));
        Ok(())
    }

    /// Keeps `value` as the feature's state of type `T` (replacing an earlier one) until the
    /// scope stops, and returns the handle to it. After a stop nothing is kept.
    pub fn manage<T: Send + Sync + 'static>(&self, value: T) -> Arc<T> {
        let value = Arc::new(value);
        if !self.is_stopped() {
            let mut parts = self.0.parts.lock();
            parts.state.insert(
                TypeId::of::<T>(),
                Arc::clone(&value) as Arc<dyn Any + Send + Sync>,
            );
        }
        value
    }

    /// The feature's state of type `T`, if it is managed and the scope has not stopped.
    pub fn state<T: Send + Sync + 'static>(&self) -> Option<Arc<T>> {
        let parts = self.0.parts.lock();
        let any = parts.state.get(&TypeId::of::<T>())?;
        Arc::clone(any).downcast::<T>().ok()
    }

    /// Runs `f` when the scope stops, after the observers and listeners are gone and before the
    /// process groups are killed; closures run in reverse order of registration.
    pub fn on_stop(&self, f: impl FnOnce() + Send + 'static) {
        let mut parts = self.0.parts.lock();
        if self.is_stopped() {
            drop(parts);
            f();
        } else {
            parts.on_stop.push(Box::new(f));
        }
    }

    /// Counts the resources of a manager the feature owns (`count` reads its live number) under
    /// `kind` in [`Self::live_counts`]. Stopping the manager is an [`Self::on_stop`] of its own.
    pub fn adopt(&self, kind: Kind, count: impl Fn() -> usize + Send + Sync + 'static) {
        self.0.parts.lock().adopted.push((kind, Arc::new(count)));
    }

    /// Work is in progress; the Features section asks before it turns the feature off.
    pub fn busy(&self, reason: impl Into<String>) {
        self.0.parts.lock().busy = Some(reason.into());
    }

    pub fn idle(&self) {
        self.0.parts.lock().busy = None;
    }

    /// Computes the busy reason when asked (the agent: "2 running chats"); `None` is idle.
    pub fn busy_probe(&self, probe: impl Fn() -> Option<String> + Send + Sync + 'static) {
        self.0.parts.lock().busy_probe = Some(Box::new(probe));
    }

    /// Why the feature is busy, or `None` when it can stop at once.
    pub fn busy_reason(&self) -> Option<String> {
        let parts = self.0.parts.lock();
        parts
            .busy
            .clone()
            .or_else(|| parts.busy_probe.as_ref().and_then(|p| p()))
    }

    /// Weak handles to every managed state (tests: after a stop they must all be dead).
    #[cfg(test)]
    pub(crate) fn state_weaks(&self) -> Vec<Weak<dyn Any + Send + Sync>> {
        self.0
            .parts
            .lock()
            .state
            .values()
            .map(Arc::downgrade)
            .collect()
    }

    /// Everything the scope owns that is still alive, per kind.
    pub fn live_counts(&self) -> Counts {
        let (adopted, mut counts) = {
            let parts = self.0.parts.lock();
            let mut counts = Counts::new();
            for (kind, h) in &parts.threads {
                if !h.is_finished() {
                    add(&mut counts, *kind, 1);
                }
            }
            let procs = parts
                .processes
                .iter()
                .filter(|c| !c.done.load(Ordering::SeqCst))
                .count();
            add(&mut counts, Kind::Process, procs);
            add(&mut counts, Kind::Observer, parts.observers.len());
            add(&mut counts, Kind::Listener, parts.listeners.len());
            add(&mut counts, Kind::State, parts.state.len());
            (parts.adopted.clone(), counts)
        };
        // outside the lock: a manager's count takes its own locks
        for (kind, count) in adopted {
            add(&mut counts, kind, count());
        }
        counts
    }

    fn adopted_total(&self) -> usize {
        let adopted = self.0.parts.lock().adopted.clone();
        adopted.iter().map(|(_, count)| count()).sum()
    }

    /// Kills what is still running (process groups) and returns what is left alive.
    pub fn force_kill(&self) -> Counts {
        let cells: Vec<_> = self.0.parts.lock().processes.clone();
        for c in &cells {
            c.kill();
        }
        self.live_counts()
    }

    /// Stops the scope (see the module docs for the order) and returns the leftovers that
    /// outlived `join_wait`. Idempotent: a second call only reports.
    pub fn shutdown(&self, join_wait: Duration) -> Counts {
        self.0.shutdown(self, join_wait)
    }
}

impl Inner {
    fn shutdown(&self, scope: &FeatureScope, join_wait: Duration) -> Counts {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return scope.live_counts();
        }
        // 1. nothing new arrives
        let (observers, listeners) = {
            let mut p = self.parts.lock();
            (
                std::mem::take(&mut p.observers),
                std::mem::take(&mut p.listeners),
            )
        };
        drop(observers);
        for remove in listeners {
            remove();
        }
        // 2. cancel, then the feature's own flushes and stops
        self.token.cancel();
        let stops = std::mem::take(&mut self.parts.lock().on_stop);
        for f in stops.into_iter().rev() {
            if catch_unwind(AssertUnwindSafe(f)).is_err() {
                log::error!("feature {}: a stop closure panicked", self.id);
            }
        }
        // 3. process groups
        let cells: Vec<_> = self.parts.lock().processes.clone();
        for c in &cells {
            c.kill();
        }
        // 4. the state: channels close, workers end
        let state = std::mem::take(&mut self.parts.lock().state);
        drop(state);
        // 5. bounded wait for threads and for the children's owners to reap them
        let deadline = Instant::now() + join_wait;
        let threads = std::mem::take(&mut self.parts.lock().threads);
        let me = std::thread::current().id();
        let mut left = Vec::new();
        for (kind, h) in threads {
            while !h.is_finished() && h.thread().id() != me && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(2));
            }
            if h.is_finished() {
                let _ = h.join();
            } else {
                left.push((kind, h));
            }
        }
        self.parts.lock().threads = left;
        // children are reaped by their owners, and adopted managers drain after their stop
        while (cells.iter().any(|c| !c.done.load(Ordering::SeqCst)) || scope.adopted_total() > 0)
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(2));
        }
        // 6. what is left
        scope.force_kill()
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if !self.stopped.swap(true, Ordering::SeqCst) {
            // the last clone went away without a stop: still never leave a process behind
            self.token.cancel();
            for c in &self.parts.get_mut().processes {
                c.kill();
            }
        }
    }
}

/// A few seconds after a stop, looks again at what the scope owned (`settle` is the delay, a
/// detached sleeping thread) and calls `leaked` with the counts when anything is still alive.
/// The caller decides what a leak means (a warning in debug, a force-kill and a strike in release).
pub fn verify_stopped(
    scope: FeatureScope,
    settle: Duration,
    leaked: impl FnOnce(&FeatureScope, Counts) + Send + 'static,
) {
    let spawned = std::thread::Builder::new()
        .name("feature-verify".into())
        .spawn(move || {
            std::thread::sleep(settle);
            let counts = scope.live_counts();
            if !counts.is_empty() {
                leaked(&scope, counts);
            }
        });
    if let Err(e) = spawned {
        log::warn!("could not schedule the stop check of a feature: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc::channel;
    use tauri::test::mock_app;

    fn scope() -> FeatureScope {
        FeatureScope::new("t", None)
    }

    #[test]
    fn a_thread_gets_the_token_and_ends_when_the_scope_stops() {
        let s = scope();
        let (tx, rx) = channel();
        s.spawn("t-worker", move |token| {
            tx.send("up").unwrap();
            while token.sleep(Duration::from_secs(60)) {}
            tx.send("down").unwrap();
        })
        .unwrap();
        assert_eq!(rx.recv().unwrap(), "up");
        assert_eq!(s.live_counts().get(&Kind::Thread), Some(&1));
        assert!(s.shutdown(JOIN_WAIT).is_empty());
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), "down");
        assert!(s.live_counts().is_empty());
    }

    #[test]
    fn a_stopped_scope_refuses_new_resources() {
        let s = scope();
        s.shutdown(JOIN_WAIT);
        assert!(s.spawn("late", |_| {}).is_err());
        assert!(s.timer("late", Duration::from_millis(1), || {}).is_err());
        assert!(s.process(&mut Command::new("true")).is_err());
        assert!(s.observe(Box::new(|_, _, _, _| {})).is_err());
        let kept = s.manage(7u8);
        assert_eq!(*kept, 7);
        assert!(s.state::<u8>().is_none(), "nothing is kept after a stop");
    }

    #[test]
    fn a_timer_ticks_and_stops_with_the_scope() {
        let s = scope();
        let ticks = Arc::new(AtomicUsize::new(0));
        let t = Arc::clone(&ticks);
        s.timer("t-tick", Duration::from_millis(5), move || {
            t.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        assert_eq!(s.live_counts().get(&Kind::Timer), Some(&1));
        let start = Instant::now();
        while ticks.load(Ordering::SeqCst) < 3 && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(ticks.load(Ordering::SeqCst) >= 3);
        assert!(s.shutdown(JOIN_WAIT).is_empty());
        let after = ticks.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(
            ticks.load(Ordering::SeqCst),
            after,
            "no tick after the stop"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stopping_kills_the_whole_process_group_and_dropping_a_child_does_too() {
        let s = scope();
        // a shell with a grandchild: both must die
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 60 & echo $!; wait"])
            .stdout(std::process::Stdio::piped());
        let mut child = s.process(&mut cmd).unwrap();
        let mut out = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(child.take_stdout().unwrap()),
            &mut out,
        )
        .unwrap();
        let grandchild: i32 = out.trim().parse().unwrap();
        assert_eq!(s.live_counts().get(&Kind::Process), Some(&1));
        let waiter = std::thread::spawn(move || child.wait().unwrap());
        assert!(s.shutdown(JOIN_WAIT).is_empty());
        let status = waiter.join().unwrap();
        assert!(!status.success());
        // the grandchild is gone (kill -0 fails once it is reaped by init)
        let start = Instant::now();
        loop {
            // SAFETY: signal 0 only checks that the process exists
            let alive = unsafe { libc::kill(grandchild, 0) } == 0;
            if !alive || start.elapsed() > Duration::from_secs(5) {
                assert!(!alive, "the grandchild outlived the stop");
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        // dropping the owner kills its group even without a stop
        let s2 = scope();
        let child = s2.process(Command::new("sleep").arg("60")).unwrap();
        let pid = child.id() as i32;
        drop(child);
        assert!(s2.live_counts().is_empty());
        // SAFETY: signal 0 only checks that the process exists
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "the child is reaped");
    }

    #[test]
    fn state_is_typed_dropped_on_stop_and_never_leaks_a_handle() {
        struct Engine(u32);
        let s = scope();
        let kept = s.manage(Engine(3));
        let weak = Arc::downgrade(&kept);
        assert_eq!(s.state::<Engine>().unwrap().0, 3);
        assert!(s.state::<String>().is_none());
        assert_eq!(s.live_counts().get(&Kind::State), Some(&1));
        drop(kept);
        assert!(weak.upgrade().is_some(), "the scope still holds it");
        s.shutdown(JOIN_WAIT);
        assert!(weak.upgrade().is_none(), "dropped with the scope");
        assert!(s.state::<Engine>().is_none());
    }

    #[test]
    fn on_stop_runs_in_reverse_after_the_token_fires_and_busy_is_read_live() {
        let s = scope();
        let order = Arc::new(Mutex::new(Vec::new()));
        for n in 1..=3 {
            let o = Arc::clone(&order);
            let token = s.token().clone();
            s.on_stop(move || o.lock().push((n, token.is_cancelled())));
        }
        s.busy("2 running chats");
        assert_eq!(s.busy_reason().as_deref(), Some("2 running chats"));
        s.idle();
        assert_eq!(s.busy_reason(), None);
        let flag = Arc::new(AtomicBool::new(true));
        let f = Arc::clone(&flag);
        s.busy_probe(move || f.load(Ordering::SeqCst).then(|| "a sync".to_string()));
        assert_eq!(s.busy_reason().as_deref(), Some("a sync"));
        flag.store(false, Ordering::SeqCst);
        assert_eq!(s.busy_reason(), None);
        s.shutdown(JOIN_WAIT);
        assert_eq!(*order.lock(), [(3, true), (2, true), (1, true)]);
        // a closure registered after the stop runs at once
        let ran = Arc::new(AtomicBool::new(false));
        let r = Arc::clone(&ran);
        s.on_stop(move || r.store(true, Ordering::SeqCst));
        assert!(ran.load(Ordering::SeqCst));
    }

    #[test]
    fn a_panicking_stop_closure_does_not_stop_the_others() {
        let s = scope();
        let ran = Arc::new(AtomicBool::new(false));
        let r = Arc::clone(&ran);
        s.on_stop(move || r.store(true, Ordering::SeqCst));
        s.on_stop(|| panic!("boom"));
        s.shutdown(JOIN_WAIT);
        assert!(ran.load(Ordering::SeqCst));
    }

    #[test]
    fn an_adopted_manager_is_counted_until_it_is_empty() {
        let s = scope();
        let live = Arc::new(AtomicUsize::new(2));
        let l = Arc::clone(&live);
        s.adopt(Kind::Process, move || l.load(Ordering::SeqCst));
        let l = Arc::clone(&live);
        s.on_stop(move || l.store(0, Ordering::SeqCst));
        assert_eq!(s.live_counts().get(&Kind::Process), Some(&2));
        assert!(s.shutdown(JOIN_WAIT).is_empty());
    }

    #[test]
    fn a_thread_that_will_not_stop_is_reported_after_the_bounded_wait() {
        let s = scope();
        let (release, stuck) = channel::<()>();
        s.spawn("t-stuck", move |_| {
            let _ = stuck.recv();
        })
        .unwrap();
        let left = s.shutdown(Duration::from_millis(30));
        assert_eq!(left.get(&Kind::Thread), Some(&1));
        assert_eq!(describe(&left), "1 thread");
        drop(release);
        let start = Instant::now();
        while !s.live_counts().is_empty() && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(s.live_counts().is_empty());
    }

    #[test]
    fn listeners_are_removed_on_stop() {
        use tauri::Emitter;
        let app = mock_app();
        let s = scope();
        let heard = Arc::new(AtomicUsize::new(0));
        let h = Arc::clone(&heard);
        s.listen(app.handle(), "t:ping", move |_| {
            h.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        assert_eq!(s.live_counts().get(&Kind::Listener), Some(&1));
        app.handle().emit("t:ping", ()).unwrap();
        assert_eq!(heard.load(Ordering::SeqCst), 1);
        assert!(s.shutdown(JOIN_WAIT).is_empty());
        app.handle().emit("t:ping", ()).unwrap();
        assert_eq!(heard.load(Ordering::SeqCst), 1, "not heard after the stop");
    }

    #[test]
    fn observers_are_unregistered_on_stop() {
        let s = scope();
        s.observe(Box::new(|_, _, _, _| {})).unwrap();
        assert_eq!(s.live_counts().get(&Kind::Observer), Some(&1));
        assert!(s.shutdown(JOIN_WAIT).is_empty());
    }

    #[test]
    fn the_spawner_starts_scope_threads_and_is_refused_after_the_stop() {
        let s = scope();
        let spawner = s.spawner();
        let (tx, rx) = channel();
        spawner
            .spawn("t-core", move |_| tx.send(1).unwrap())
            .unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 1);
        s.shutdown(JOIN_WAIT);
        assert!(spawner.spawn("t-late", |_| {}).is_err());
        assert!(
            !spawner.sleep(Duration::from_secs(60)),
            "a stopped scope wakes sleepers"
        );
        // dropping the scope handle does not keep a stopped scope alive through the spawner
        drop(s);
        assert!(spawner.spawn("t-gone", |_| {}).is_err());
    }

    #[test]
    fn verify_stopped_reports_only_when_something_is_alive() {
        let clean = scope();
        let called = Arc::new(AtomicBool::new(false));
        let c = Arc::clone(&called);
        verify_stopped(clean.clone(), Duration::from_millis(10), move |_, _| {
            c.store(true, Ordering::SeqCst)
        });
        std::thread::sleep(Duration::from_millis(60));
        assert!(!called.load(Ordering::SeqCst));

        let dirty = scope();
        dirty.adopt(Kind::Process, || 1);
        let (tx, rx) = channel();
        verify_stopped(dirty, Duration::from_millis(10), move |_, counts| {
            tx.send(describe(&counts)).unwrap()
        });
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "1 process"
        );
    }

    #[test]
    fn detached_spawner_runs_plain_threads() {
        let spawner = Spawner::detached();
        let (tx, rx) = channel();
        spawner
            .spawn("t-detached", move |_| tx.send(()).unwrap())
            .unwrap();
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(spawner.sleep(Duration::from_millis(1)));
    }
}
