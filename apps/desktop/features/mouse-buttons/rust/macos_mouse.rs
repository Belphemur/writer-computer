//! macOS mouse side buttons (back / forward) delivered natively.
//!
//! WKWebView does not give a page the side buttons (`NSEvent` `otherMouseDown` with
//! `buttonNumber` 3 and 4) in every setup, so the webview cannot be trusted to turn them into DOM
//! events. A process-wide local `NSEvent` monitor sees them before AppKit dispatches them: on the
//! press it emits the Tauri event [`EVENT`] to the focused Writer window and swallows the press and
//! its release (a monitor returning nil) so nothing else acts on them twice. The middle button (2)
//! is left alone: wry forwards it to WKWebView, which turns it into the DOM `mousedown`/`auxclick`.
//!
//! Crash rule (2026-11-17 incident, see the spec): the monitor body runs inside AppKit's
//! `_NSSendEventToObservers` through an `extern "C"` block, so an Objective-C exception or a panic
//! escaping it aborts the whole app (release builds also use `panic = "abort"`, so `catch_unwind`
//! alone cannot save us). The handler therefore does nothing but cheap AppKit reads wrapped in
//! `objc2::exception::catch`, makes a pure decision, and hands everything else (logging, window
//! lookup, `emit_to`) to a worker thread over a channel. No Tauri window API is ever called from
//! inside the monitor.
//!
//! Diagnostics (shipped, rate limited, info level): the monitor also sees left/right presses, other
//! buttons, swipe events and command/control/option chords on `[ ] ArrowLeft ArrowRight`, so the log
//! shows whether a mouse driver turns the side buttons into keystrokes or swipes.
//!
//! Spec: `SPECs/mouse-side-buttons-spec.md`; mounted by `features/mouse-buttons/rust/mod.rs`. The `NSEvent` glue cannot be unit tested; the pure
//! decisions and the panic guard can, and are.

use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use std::panic::{catch_unwind, AssertUnwindSafe, UnwindSafe};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::mpsc::{channel, Sender};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Tauri event sent to one window; payload `{ "direction": "back" | "forward" }`. Named
/// `<feature id>:<name>` like every feature event; `feature.json` `rust.events` lists it and the
/// web side listens through `ctx.listen("navigate")`.
pub(crate) const EVENT: &str = "mouse-buttons:navigate";

const T_LEFT_DOWN: usize = 1;
const T_RIGHT_DOWN: usize = 3;
const T_KEY_DOWN: usize = 10;
const T_OTHER_DOWN: usize = 25;
const T_OTHER_UP: usize = 26;
const T_SWIPE: usize = 31;
const EVENT_MASK: u64 = (1 << T_LEFT_DOWN)
    | (1 << T_RIGHT_DOWN)
    | (1 << T_KEY_DOWN)
    | (1 << T_OTHER_DOWN)
    | (1 << T_OTHER_UP)
    | (1 << T_SWIPE);

const FLAG_CTRL: usize = 1 << 18;
const FLAG_ALT: usize = 1 << 19;
const FLAG_CMD: usize = 1 << 20;
/// `[`, `]`, left arrow, right arrow (ANSI virtual key codes).
const NAV_KEY_CODES: [u16; 4] = [33, 30, 123, 124];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Direction {
    Back,
    Forward,
}

impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Direction::Back => "back",
            Direction::Forward => "forward",
        }
    }
}

/// `NSEvent.buttonNumber`: 0 left, 1 right, 2 middle, 3 back, 4 forward.
pub(crate) fn direction_for_button(button_number: isize) -> Option<Direction> {
    match button_number {
        3 => Some(Direction::Back),
        4 => Some(Direction::Forward),
        _ => None,
    }
}

/// Every Writer window label: `main` and the `w-<uuid>` secondary workspace windows.
pub(crate) fn is_writer_window_label(label: &str) -> bool {
    label == "main" || label.starts_with("w-")
}

/// The few plain values read from an `NSEvent`; nothing else of the event leaves the handler.
#[derive(Debug, Clone, Copy, PartialEq)]
struct RawEvent {
    kind: usize,
    button: isize,
    key_code: u16,
    flags: usize,
    delta_x: f64,
    delta_y: f64,
    has_window: bool,
}

impl RawEvent {
    fn new(kind: usize) -> Self {
        Self {
            kind,
            button: -1,
            key_code: 0,
            flags: 0,
            delta_x: 0.0,
            delta_y: 0.0,
            has_window: false,
        }
    }
}

/// Press or release of a side button: acted on and swallowed.
fn side_button(raw: &RawEvent) -> Option<(Direction, bool)> {
    let down = match raw.kind {
        T_OTHER_DOWN => true,
        T_OTHER_UP => false,
        _ => return None,
    };
    direction_for_button(raw.button).map(|d| (d, down))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Category {
    OtherButton,
    LeftButton,
    RightButton,
    Chord,
    Swipe,
}

impl Category {
    const ALL: [Category; 5] = [
        Category::OtherButton,
        Category::LeftButton,
        Category::RightButton,
        Category::Chord,
        Category::Swipe,
    ];

    /// How many events of this kind are logged per run.
    fn limit(self) -> usize {
        match self {
            Category::LeftButton => 3,
            Category::RightButton => 5,
            Category::OtherButton | Category::Chord | Category::Swipe => 30,
        }
    }

    fn index(self) -> usize {
        Self::ALL.iter().position(|c| *c == self).unwrap_or(0)
    }
}

/// Diagnostic line for an event, or None when it is not worth logging.
fn describe(raw: &RawEvent) -> Option<(Category, String)> {
    let window = if raw.has_window {
        "window"
    } else {
        "no window"
    };
    match raw.kind {
        T_LEFT_DOWN => Some((
            Category::LeftButton,
            format!("native left press ({window})"),
        )),
        T_RIGHT_DOWN => Some((
            Category::RightButton,
            format!("native right press ({window})"),
        )),
        T_OTHER_DOWN | T_OTHER_UP => Some((
            Category::OtherButton,
            format!(
                "native mouse button {} {} ({window})",
                raw.button,
                if raw.kind == T_OTHER_DOWN {
                    "down"
                } else {
                    "up"
                }
            ),
        )),
        T_SWIPE => Some((
            Category::Swipe,
            format!("native swipe deltaX {} deltaY {}", raw.delta_x, raw.delta_y),
        )),
        T_KEY_DOWN => {
            let chord = raw.flags & (FLAG_CMD | FLAG_CTRL | FLAG_ALT) != 0;
            (chord && NAV_KEY_CODES.contains(&raw.key_code)).then(|| {
                (
                    Category::Chord,
                    format!(
                        "native key chord keyCode {} (cmd {}, ctrl {}, alt {})",
                        raw.key_code,
                        raw.flags & FLAG_CMD != 0,
                        raw.flags & FLAG_CTRL != 0,
                        raw.flags & FLAG_ALT != 0
                    ),
                )
            })
        }
        _ => None,
    }
}

/// Runs `f`; on a panic returns `fallback` and says why. Release builds use `panic = "abort"`, so
/// this only helps in debug and tests: the real protection is that the monitor body cannot panic.
fn guard<T>(fallback: T, f: impl FnOnce() -> T + UnwindSafe) -> T {
    match catch_unwind(f) {
        Ok(v) => v,
        Err(payload) => {
            report_failure(&format!(
                "panic in the mouse monitor: {}",
                crate::logging::describe_panic(payload.as_ref())
            ));
            fallback
        }
    }
}

static FAILURE_LOGGED: AtomicBool = AtomicBool::new(false);

/// Logs the first monitor failure at error level; later ones stay silent (it runs per event).
fn report_failure(what: &str) {
    if !FAILURE_LOGGED.swap(true, Ordering::Relaxed) {
        log::error!(
            "{what}; the event was passed through untouched (further failures are not logged)"
        );
    }
}

static MONITOR: AtomicPtr<AnyObject> = AtomicPtr::new(ptr::null_mut());

/// Is the monitor installed in this process? (`feature.json` kill switch tests read this.)
pub(crate) fn is_installed() -> bool {
    !MONITOR.load(Ordering::Acquire).is_null()
}

/// Installs the process-wide monitor. An `Err` is returned to the feature runner, which logs it
/// and keeps the app running without the native path (the DOM fallback still works).
pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if is_installed() {
        return Ok(());
    }
    let (tx, rx) = channel::<RawEvent>();
    let worker_app = app.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("mouse-monitor".into())
        .spawn(move || worker(worker_app, rx))
    {
        return Err(format!(
            "mouse monitor not installed: could not start its worker thread: {err}"
        ));
    }
    let handler = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
        guard(event, AssertUnwindSafe(|| handle_event(&tx, event)))
    });
    // SAFETY: called from `setup` on the main thread; AppKit copies the block.
    let token: *mut AnyObject = unsafe {
        msg_send![
            class!(NSEvent),
            addLocalMonitorForEventsMatchingMask: EVENT_MASK,
            handler: &*handler
        ]
    };
    if token.is_null() {
        return Err(
            "mouse monitor not installed: addLocalMonitorForEventsMatchingMask returned nil".into(),
        );
    }
    // The token is autoreleased; keep it for the process lifetime.
    let token: *mut AnyObject = unsafe { msg_send![token, retain] };
    MONITOR.store(token, Ordering::Release);
    log::info!("mouse monitor installed (token {token:p}, mask {EVENT_MASK:#x})");
    Ok(())
}

/// Runs inside AppKit's event observers: AppKit reads under an Objective-C exception catch, one
/// pure decision, a channel send. Returns nil only for side-button presses and releases.
fn handle_event(tx: &Sender<RawEvent>, event: *mut AnyObject) -> *mut AnyObject {
    if event.is_null() {
        return event;
    }
    // SAFETY: AppKit passes a live NSEvent for the duration of the call; the selectors read below
    // are valid for the event types in `EVENT_MASK` (and the catch absorbs anything unexpected).
    let read = objc2::exception::catch(AssertUnwindSafe(|| unsafe { read_event(event) }));
    let raw = match read {
        Ok(raw) => raw,
        Err(exception) => {
            report_failure(&format!(
                "Objective-C exception reading an NSEvent: {exception:?}"
            ));
            return event;
        }
    };
    let swallow = side_button(&raw).is_some();
    // A closed channel only means the worker is gone; never fail the event for it.
    let _ = tx.send(raw);
    if swallow {
        ptr::null_mut()
    } else {
        event
    }
}

unsafe fn read_event(event: *mut AnyObject) -> RawEvent {
    let kind: usize = unsafe { msg_send![event, r#type] };
    let mut raw = RawEvent::new(kind);
    let window: *mut AnyObject = unsafe { msg_send![event, window] };
    raw.has_window = !window.is_null();
    match kind {
        T_LEFT_DOWN | T_RIGHT_DOWN | T_OTHER_DOWN | T_OTHER_UP => {
            raw.button = unsafe { msg_send![event, buttonNumber] };
        }
        T_KEY_DOWN => {
            raw.key_code = unsafe { msg_send![event, keyCode] };
            raw.flags = unsafe { msg_send![event, modifierFlags] };
        }
        T_SWIPE => {
            raw.delta_x = unsafe { msg_send![event, deltaX] };
            raw.delta_y = unsafe { msg_send![event, deltaY] };
        }
        _ => {}
    }
    raw
}

/// Off the main thread: rate-limited diagnostics and the window lookup plus `emit_to`.
fn worker<R: Runtime>(app: AppHandle<R>, rx: std::sync::mpsc::Receiver<RawEvent>) {
    let mut seen = [0usize; Category::ALL.len()];
    for raw in rx {
        if let Some((category, line)) = describe(&raw) {
            let n = &mut seen[category.index()];
            *n += 1;
            if *n <= category.limit() {
                log::info!("{line}");
            }
        }
        let Some((direction, true)) = side_button(&raw) else {
            continue;
        };
        let Some(label) = focused_writer_label(&app) else {
            log::warn!(
                "mouse {} pressed but no Writer window is focused",
                direction.as_str()
            );
            continue;
        };
        log::info!("mouse {} -> window {label}", direction.as_str());
        if let Err(err) = app.emit_to(
            label.as_str(),
            EVENT,
            serde_json::json!({ "direction": direction.as_str() }),
        ) {
            log::warn!(
                "mouse {} could not reach window {label}: {err}",
                direction.as_str()
            );
        }
    }
}

fn focused_writer_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.webview_windows().into_iter().find_map(|(label, w)| {
        (is_writer_window_label(&label) && w.is_focused().unwrap_or(false)).then_some(label)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn side_buttons_map_to_directions() {
        assert_eq!(direction_for_button(3), Some(Direction::Back));
        assert_eq!(direction_for_button(4), Some(Direction::Forward));
        for b in [-1, 0, 1, 2, 5, 6] {
            assert_eq!(direction_for_button(b), None, "button {b}");
        }
        assert_eq!(Direction::Back.as_str(), "back");
        assert_eq!(Direction::Forward.as_str(), "forward");
    }

    #[test]
    fn only_writer_windows_match() {
        assert!(is_writer_window_label("main"));
        assert!(is_writer_window_label("w-1234"));
        assert!(!is_writer_window_label("about"));
        assert!(!is_writer_window_label("w"));
    }

    #[test]
    fn event_mask_covers_mouse_buttons_keys_and_swipes() {
        assert_eq!(
            EVENT_MASK,
            (1 << 1) | (1 << 3) | (1 << 10) | (1 << 25) | (1 << 26) | (1 << 31)
        );
    }

    fn other(kind: usize, button: isize) -> RawEvent {
        RawEvent {
            button,
            ..RawEvent::new(kind)
        }
    }

    #[test]
    fn only_side_button_presses_and_releases_are_swallowed() {
        assert_eq!(
            side_button(&other(T_OTHER_DOWN, 3)),
            Some((Direction::Back, true))
        );
        assert_eq!(
            side_button(&other(T_OTHER_UP, 4)),
            Some((Direction::Forward, false))
        );
        assert_eq!(side_button(&other(T_OTHER_DOWN, 2)), None);
        assert_eq!(side_button(&other(T_LEFT_DOWN, 3)), None);
        assert_eq!(side_button(&RawEvent::new(T_KEY_DOWN)), None);
    }

    #[test]
    fn diagnostics_cover_buttons_swipes_and_nav_chords_only() {
        let (cat, line) = describe(&other(T_OTHER_DOWN, 3)).expect("other button");
        assert_eq!(cat, Category::OtherButton);
        assert!(line.contains("button 3 down"));
        assert_eq!(
            describe(&other(T_LEFT_DOWN, 0)).map(|d| d.0),
            Some(Category::LeftButton)
        );
        assert_eq!(
            describe(&other(T_RIGHT_DOWN, 1)).map(|d| d.0),
            Some(Category::RightButton)
        );
        assert_eq!(
            describe(&RawEvent::new(T_SWIPE)).map(|d| d.0),
            Some(Category::Swipe)
        );

        let key = |key_code, flags| RawEvent {
            key_code,
            flags,
            ..RawEvent::new(T_KEY_DOWN)
        };
        assert!(describe(&key(33, FLAG_CMD)).is_some(), "Cmd+[");
        assert!(describe(&key(124, FLAG_ALT)).is_some(), "Alt+Right");
        assert!(describe(&key(30, FLAG_CTRL)).is_some(), "Ctrl+]");
        assert!(describe(&key(33, 0)).is_none(), "plain [ is typing");
        assert!(
            describe(&key(0, FLAG_CMD)).is_none(),
            "Cmd+A is not navigation"
        );
        assert!(describe(&RawEvent::new(99)).is_none());
    }

    #[test]
    fn diagnostic_limits_are_bounded() {
        for c in Category::ALL {
            assert!(c.limit() <= 30);
            assert_eq!(Category::ALL[c.index()], c);
        }
    }

    #[test]
    fn guard_returns_the_fallback_when_the_body_panics() {
        let event = 0x1234usize;
        let out = guard(event, || -> usize { panic!("simulated monitor panic") });
        assert_eq!(out, event);
        assert_eq!(guard(event, || 7usize), 7);
    }

    #[test]
    fn handler_passes_a_null_event_through_and_survives_a_closed_worker() {
        let (tx, rx) = channel::<RawEvent>();
        drop(rx);
        assert!(handle_event(&tx, ptr::null_mut()).is_null());
    }

    #[test]
    fn an_objective_c_exception_is_caught_instead_of_unwinding() {
        // `-[NSArray objectAtIndex:]` out of range raises NSRangeException.
        let caught = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
            let array: *mut AnyObject = msg_send![class!(NSArray), array];
            let _: *mut AnyObject = msg_send![array, objectAtIndex: 5usize];
        }));
        assert!(caught.is_err());
    }
}
