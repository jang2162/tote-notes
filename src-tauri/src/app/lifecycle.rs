//! Closing a window, switching its workspace and quitting: the affected windows write their
//! edits first, then the window or tote goes. Writing on close and quit is what bounds the loss
//! when a hidden window's timers stall (spec 「저장」). A save that keeps failing is the one thing
//! that asks first (spec 「오류 처리」).

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::flush::{Ack, Begin, FlushGoal};
use super::{windows, AppCore, PendingOpen, SwitchError};

/// Long enough to write any memo to a local disk; short enough that a hung page cannot keep tote
/// from closing.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(3);

/// What the end of a round or the answer to its question calls for, in order. Kept apart from
/// carrying it out so the tests can check that every path answers a waiting macOS (Dock quit,
/// logout): it waits until told, and a path that never tells it stops the logout for good.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Finish(FlushGoal),
    BeginQuit,
    /// Tell a waiting macOS 「no」 (Dock quit, logout). Does nothing when macOS is not waiting.
    /// A quit Apple Event held while a close asked is let go by this answer too.
    RefuseSystemQuit,
    Ask {
        goal: FlushGoal,
        reasons: Vec<String>,
    },
}

pub fn steps_for_ack(ack: Ack) -> Vec<Step> {
    match ack {
        Ack::Pending | Ack::Stale => vec![],
        Ack::Done(goal) => vec![Step::Finish(goal)],
        Ack::DoneThenQuit(goal) => vec![Step::Finish(goal), Step::BeginQuit],
        Ack::Blocked { goal, reasons } => vec![Step::Ask { goal, reasons }],
    }
}

/// The question about a round was answered: 「그래도」 when `anyway`. `quit_waiting`: a quit
/// joined the round, so its answer goes for the quit too.
pub fn steps_for_answer(goal: FlushGoal, anyway: bool, quit_waiting: bool) -> Vec<Step> {
    match (goal, anyway) {
        (FlushGoal::Quit, true) => vec![Step::Finish(FlushGoal::Quit)],
        (FlushGoal::Quit, false) => vec![Step::RefuseSystemQuit],
        (close, true) if quit_waiting => vec![Step::Finish(close), Step::BeginQuit],
        (close, true) => vec![Step::Finish(close)],
        (_, false) if quit_waiting => vec![Step::RefuseSystemQuit],
        (_, false) => vec![],
    }
}

/// What `tote://flush` asks of a window: write its tabs for round `id`, which is for `goal`
/// (`FlushGoal::kind`).
#[derive(Clone, Serialize)]
struct FlushRequest {
    id: u64,
    goal: &'static str,
}

pub fn begin(app: &AppHandle, goal: FlushGoal) {
    let kind = goal.kind();
    let round = app.state::<AppCore>().begin_flush(goal);
    run(app, round, kind);
}

/// Carries out what starting a round for a goal of `kind` calls for.
fn run(app: &AppHandle, round: Begin, kind: &'static str) {
    match round {
        Begin::Done(goal) => finish(app, goal),
        Begin::AlreadyRunning => {}
        Begin::Started { id, windows } => {
            let request = FlushRequest { id, goal: kind };
            for label in &windows {
                let _ = app.emit_to(
                    EventTarget::webview_window(label.as_str()),
                    "tote://flush",
                    request.clone(),
                );
            }
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(FLUSH_TIMEOUT);
                let ack = app.state::<AppCore>().expire_flush(id);
                settle(&app, id, ack);
            });
        }
    }
}

/// A window's frontend answered round `id` (`flush_done`), with why it is `blocked` if it could
/// not write everything. Returns whether the page keeps its panes empty (`keeps_leaving`).
pub fn ack(app: &AppHandle, id: u64, label: &str, blocked: Option<String>) -> bool {
    let core = app.state::<AppCore>();
    let ack = core.ack_flush(id, label, blocked);
    let leaving = keeps_leaving(&ack, core.window_is_leaving(label));
    settle(app, id, ack);
    leaving
}

/// Whether a page that answered with `ack` keeps its panes empty. An answer to a round that is
/// over came after the round was settled without it — the timeout ran out first — so a
/// `tote://stay` for it either never comes or came before the page let go of its panes: the page
/// takes them back unless its window is going.
fn keeps_leaving(ack: &Ack, window_is_leaving: bool) -> bool {
    match ack {
        Ack::Stale => window_is_leaving,
        _ => true,
    }
}

/// Carries out what the end of round `id` calls for.
pub fn settle(app: &AppHandle, id: u64, ack: Ack) {
    run_steps(app, id, steps_for_ack(ack));
}

fn run_steps(app: &AppHandle, id: u64, steps: Vec<Step>) {
    for step in steps {
        match step {
            // A switch with a quit right after it reloads too: the quit may be cancelled, and a
            // window left on its old page could not write. The quit does not wait on the page
            // reloading — a switched window is out of its round (`AppCore::begin_flush`).
            Step::Finish(goal) => finish(app, goal),
            // A Dock quit or a logout may still be waiting on macOS's answer; the quit round's own
            // end gives it.
            Step::BeginQuit => begin(app, FlushGoal::Quit),
            Step::RefuseSystemQuit => {
                #[cfg(target_os = "macos")]
                system_quit::answer(app, false);
            }
            Step::Ask { goal, reasons } => ask_blocked(app, id, goal, &reasons),
        }
    }
}

/// The question's text: the reasons, then what 「그래도」 costs for this goal.
fn blocked_message(goal: &FlushGoal, reasons: &[String]) -> String {
    let anyway = match goal {
        FlushGoal::CloseWindow(_) => "닫으면",
        FlushGoal::SwitchWorkspace { .. } => "바꾸면",
        FlushGoal::Quit => "종료하면",
    };
    format!(
        "{}\n그래도 {anyway} 저장하지 못한 글은 사라집니다.",
        reasons.join("\n")
    )
}

/// The text is still only in memory: going now loses it, so the person decides.
fn ask_blocked(app: &AppHandle, id: u64, goal: FlushGoal, reasons: &[String]) {
    let anyway = match goal {
        FlushGoal::CloseWindow(_) => "그래도 닫기",
        FlushGoal::SwitchWorkspace { .. } => "그래도 바꾸기",
        FlushGoal::Quit => "그래도 종료",
    };
    let mut dialog = app
        .dialog()
        .message(blocked_message(&goal, reasons))
        .title("저장하지 못한 메모가 있습니다")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            anyway.to_string(),
            "취소".to_string(),
        ));
    if let Some(window) = goal
        .window()
        .and_then(|label| app.get_webview_window(label))
    {
        dialog = dialog.parent(&window);
    }
    let app = app.clone();
    dialog.show(move |anyway| resolve_blocked(&app, id, goal, anyway));
}

/// The question about round `id` was answered. Either answer ends the round; only 「그래도」
/// carries the goal out. A quit that joined a close's question goes the same way as the close.
pub fn resolve_blocked(app: &AppHandle, id: u64, goal: FlushGoal, anyway: bool) {
    let quit_waiting = app.state::<AppCore>().cancel_flush(id);
    if !anyway {
        ended(app, &goal, Exit::Cancelled);
    }
    run_steps(app, id, steps_for_answer(goal, anyway, quit_waiting));
}

/// How a round left its window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Exit {
    /// The goal was carried out: the window is gone, or reloads on its new workspace.
    Done,
    /// 「취소」 to the question.
    Cancelled,
    /// A window came to show the workspace of the switch while this one wrote its tabs; that one
    /// comes forward instead.
    Shown,
    /// The workspace of the switch could not be opened, or the window not switched to it.
    NotSwitched,
    /// The window could not be closed.
    NotClosed,
}

/// The page of a window round's window emptied its panes as it answered (`AppController.onFlush`);
/// every exit that keeps the window must give them back, or it shows nothing and takes no key for
/// good. A quit's windows never let go of theirs.
fn keeps_window(goal: &FlushGoal, exit: Exit) -> bool {
    goal.window().is_some() && exit != Exit::Done
}

/// Round for `goal` left its window by `exit`: the page gets its panes back if the window stays.
fn ended(app: &AppHandle, goal: &FlushGoal, exit: Exit) {
    if let Some(label) = goal.window().filter(|_| keeps_window(goal, exit)) {
        stay(app, label);
    }
}

/// Tells the page of window `label` that the close or switch it wrote its tabs for is off
/// (`tote://stay`).
pub fn stay(app: &AppHandle, label: &str) {
    let _ = app.emit_to(EventTarget::webview_window(label), "tote://stay", ());
}

pub fn finish(app: &AppHandle, goal: FlushGoal) {
    let exit = match &goal {
        FlushGoal::CloseWindow(label) => {
            // `closed` comes only once the window is gone: a quit begun right after this (a
            // joined quit's `BeginQuit`) must neither wait on the window nor reopen it.
            app.state::<AppCore>().closing(label);
            match app.get_webview_window(label).map(|window| window.destroy()) {
                Some(Err(err)) => {
                    eprintln!("tote: {label}: could not close: {err}");
                    app.state::<AppCore>().close_failed(label);
                    Exit::NotClosed
                }
                _ => Exit::Done,
            }
        }
        FlushGoal::SwitchWorkspace { label, to } => switch_window(app, label, to),
        FlushGoal::Quit => {
            app.state::<AppCore>().start_quit();
            // macOS asked first (the Dock, a logout): answering it, not `exit`, lets a logout go
            // on once tote is gone.
            #[cfg(target_os = "macos")]
            if system_quit::answer(app, true) {
                return;
            }
            app.exit(0);
            return;
        }
    };
    ended(app, &goal, exit);
}

/// Window `label` wrote its tabs: it shows the workspace at `to` now, unless a window came to show
/// it meanwhile — that one comes forward and this one stays — or it cannot be opened, which the
/// window's status bar says. Returns how the switch left the window.
fn switch_window(app: &AppHandle, label: &str, to: &Path) -> Exit {
    let exit = switch_window_inner(app, label, to);
    // Whichever way it ended: a CLI request that came meanwhile is handled as if it came now.
    let core = app.state::<AppCore>();
    for request in core.finish_switch(label) {
        super::requests::handle(app, request);
    }
    exit
}

fn switch_window_inner(app: &AppHandle, label: &str, to: &Path) -> Exit {
    let core = app.state::<AppCore>();
    let opened = match core.prepare_switch(label, to) {
        Ok(opened) => opened,
        Err(SwitchError::Shown(other)) => {
            windows::focus(app, &other);
            return Exit::Shown;
        }
        Err(SwitchError::Open(err)) => {
            core.push_pending(
                label,
                PendingOpen::Notice {
                    message: format!("워크스페이스를 열지 못했습니다: {err}"),
                },
            );
            let _ = app.emit_to(EventTarget::webview_window(label), "tote://pending", ());
            return Exit::NotSwitched;
        }
    };
    let from = core.path_of(label);
    if let Err(err) = core.switch_window(label, to, opened) {
        eprintln!("tote: {label}: could not switch to {}: {err}", to.display());
        return Exit::NotSwitched;
    }
    for path in from.iter().map(|p| p.as_path()).chain([to]) {
        windows::retitle(app, path);
    }
    let _ = app.emit("tote://workspaces", ());
    // A workspace just opened is marked changed; have the backup thread take it now.
    core.request_backup(label);
    if let Some(window) = app.get_webview_window(label) {
        if let Err(err) = window.reload() {
            eprintln!("tote: {label}: could not reload: {err}");
        }
    }
    Exit::Done
}

/// The Dock's 「종료」, a logout and a restart quit through `terminate:`, never through the menu's
/// 「tote 종료」, and tao does not answer macOS's 「may it quit?」 — tote would go at once without
/// writing anything. This adds that answer to tao's app delegate: 「later」, then the same
/// write-then-close round as ⌘Q. Call once, from `setup`.
#[cfg(target_os = "macos")]
pub fn hook_system_quit(app: &AppHandle) {
    system_quit::install(app);
}

#[cfg(target_os = "macos")]
mod system_quit {
    use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

    use objc2::encode::{Encoding, RefEncode};
    use objc2::ffi::class_addMethod;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
    use tauri::{AppHandle, Manager};

    use super::super::flush::{Begin, FlushGoal};
    use super::super::AppCore;

    type ShouldTerminate =
        extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> NSApplicationTerminateReply;
    type HandleQuitEvent = extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject, *mut AnyObject);

    const fn four_char_code(code: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*code)
    }

    const K_CORE_EVENT_CLASS: u32 = four_char_code(b"aevt");
    const K_AE_QUIT_APPLICATION: u32 = four_char_code(b"quit");
    const KEY_ERROR_NUMBER: u32 = four_char_code(b"errn");
    const TYPE_NULL: u32 = four_char_code(b"null");

    /// What `suspendCurrentAppleEvent` hands back; only ever passed back to the event manager.
    #[repr(C)]
    struct Suspension {
        _opaque: [u8; 0],
    }

    // SAFETY: the encoding Foundation declares for `NSAppleEventManagerSuspensionID`, a pointer to
    // an opaque struct; objc2-foundation encodes it the same way.
    unsafe impl RefEncode for Suspension {
        const ENCODING_REF: Encoding =
            Encoding::Pointer(&Encoding::Struct("__NSAppleEventManagerSuspension", &[]));
    }

    /// A quit Apple Event put off until a close's question is answered.
    struct SuspendedEvent {
        id: *const Suspension,
    }

    // SAFETY: the id is an opaque token tote never reads through; it is handed back to the event
    // manager on the main thread only (`resume`).
    unsafe impl Send for SuspendedEvent {}

    /// What macOS waits on for tote's answer, if anything. One at a time: a quit that comes while
    /// one waits is refused (`admits`). `E` is the held event; the tests stand in a plain value.
    enum Waiting<E = SuspendedEvent> {
        None,
        /// Told 「later」; waits for `replyToApplicationShouldTerminate:`.
        Terminate,
        /// The sender of a quit Apple Event waits for its reply.
        QuitEvent(E),
    }

    /// How `answer` replies to what waited.
    #[derive(Debug, PartialEq, Eq)]
    enum Reply<E> {
        /// `replyToApplicationShouldTerminate:` with this.
        Terminate(bool),
        /// Resume the held event, with this error in its reply.
        Resume(E, Option<i16>),
    }

    /// What `applicationShouldTerminate:` does.
    #[derive(Debug, PartialEq, Eq)]
    enum TerminateDecision {
        /// Another quit already waits on tote's answer: this one is refused, so the waiting one is
        /// still answered once. Overwriting it would leave its sender without a reply for good.
        Cancel,
        Now,
        /// Begin the write-then-close round.
        Flush,
    }

    #[derive(Debug, PartialEq, Eq)]
    enum QuitEventAction {
        /// Hold the event and join the close's question: its answer is the reply.
        Suspend,
        /// What AppKit's own handler does: `terminate:`, then `applicationShouldTerminate:`.
        Terminate,
    }

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static WAITING: Mutex<Waiting> = Mutex::new(Waiting::None);

    const NOT_HOOKED: &str =
        "tote: could not answer macOS's quit; the Dock's quit will not write first";
    const QUIT_EVENT_NOT_HOOKED: &str =
        "tote: could not take the quit Apple Event; a Dock quit during a close's question is lost";

    fn waiting() -> MutexGuard<'static, Waiting> {
        WAITING.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn install(app: &AppHandle) {
        let _ = APP.set(app.clone());
        let Some(mtm) = MainThreadMarker::new() else {
            eprintln!("{NOT_HOOKED} (not on the main thread)");
            return;
        };
        let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
            eprintln!("{NOT_HOOKED} (no app delegate)");
            return;
        };
        let delegate: &AnyObject = AsRef::<AnyObject>::as_ref(&*delegate);
        let class = delegate.class() as *const AnyClass as *mut AnyClass;
        let method: ShouldTerminate = should_terminate;
        // SAFETY: the class is tao's own, registered at runtime without this selector, and the
        // function matches the encoding: returns NSUInteger (`Q`), takes self, _cmd and the sender.
        let added = unsafe {
            class_addMethod(
                class,
                sel!(applicationShouldTerminate:),
                std::mem::transmute::<ShouldTerminate, Imp>(method),
                c"Q@:@".as_ptr(),
            )
        };
        if !added.as_bool() {
            eprintln!("{NOT_HOOKED}");
        }
        install_quit_event(delegate, class);
    }

    /// AppKit's own handler for the quit Apple Event (the Dock's 「종료」, AppleScript's `quit`, a
    /// logout) refuses it by itself while a sheet is up: `applicationShouldTerminate:` is never
    /// called, and a quit that comes during a close's question is lost. This handler takes its
    /// place. It runs after launch (`setup`), so AppKit's own registration does not replace it.
    fn install_quit_event(delegate: &AnyObject, class: *mut AnyClass) {
        let method: HandleQuitEvent = handle_quit_event;
        // SAFETY: as for `applicationShouldTerminate:` above; the function returns void (`v`) and
        // takes self, _cmd, the event and the reply.
        let added = unsafe {
            class_addMethod(
                class,
                sel!(handleQuitEvent:withReplyEvent:),
                std::mem::transmute::<HandleQuitEvent, Imp>(method),
                c"v@:@@".as_ptr(),
            )
        };
        if !added.as_bool() {
            eprintln!("{QUIT_EVENT_NOT_HOOKED}");
            return;
        }
        // SAFETY: NSAppleEventManager is Foundation's, and these are its documented messages with
        // their argument types (AEEventClass and AEEventID are UInt32). It does not retain the
        // handler; tao's delegate lives as long as the app.
        unsafe {
            let manager: Retained<AnyObject> =
                msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
            let _: () = msg_send![
                &*manager,
                setEventHandler: delegate,
                andSelector: sel!(handleQuitEvent:withReplyEvent:),
                forEventClass: K_CORE_EVENT_CLASS,
                andEventID: K_AE_QUIT_APPLICATION
            ];
        }
    }

    extern "C-unwind" fn handle_quit_event(
        _: &AnyObject,
        _: Sel,
        _: *mut AnyObject,
        reply: *mut AnyObject,
    ) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        // SAFETY: the reply AppKit passed this handler, alive until it returns.
        let reply = unsafe { reply.as_ref() };
        let asking = APP
            .get()
            .is_some_and(|app| app.state::<AppCore>().asking_close());
        match quit_event_action(asking) {
            QuitEventAction::Suspend => suspend(reply),
            QuitEventAction::Terminate => {
                NSApplication::sharedApplication(mtm).terminate(None);
                // `terminate:` returns only when the quit was refused; the sender hears so, as
                // from AppKit's own handler. A logout waits on this to call itself off.
                if let Some(reply) = reply {
                    refuse(reply, -128);
                }
            }
        }
    }

    /// Joins the close's question and holds the event for its answer (`answer`). Called from the
    /// quit event's handler, with its reply.
    fn suspend(reply: Option<&AnyObject>) {
        let Some(app) = APP.get() else {
            return;
        };
        let mut waiting = waiting();
        let id: *const Suspension = if admits(&waiting) {
            // SAFETY: called from the quit event's handler on the main thread, so there is a
            // current event to suspend.
            unsafe {
                let manager: Retained<AnyObject> =
                    msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
                msg_send![&*manager, suspendCurrentAppleEvent]
            }
        } else {
            std::ptr::null()
        };
        // Refused, as AppKit would have: a second quit while one is held, or an event that could
        // not be held. The handler returns with this reply, and the round is not joined.
        if id.is_null() {
            drop(waiting);
            if let Some(reply) = reply {
                refuse(reply, -128);
            }
            return;
        }
        *waiting = Waiting::QuitEvent(SuspendedEvent { id });
        let round = app.state::<AppCore>().begin_flush(FlushGoal::Quit);
        // `run` may answer at once, which takes the lock.
        drop(waiting);
        super::run(app, round, FlushGoal::Quit.kind());
    }

    /// Puts error `code` in an Apple Event's reply.
    fn refuse(reply: &AnyObject, code: i16) {
        // SAFETY: `reply` is an NSAppleEventDescriptor, and these are its documented messages
        // (DescType and AEKeyword are UInt32).
        unsafe {
            let kind: u32 = msg_send![reply, descriptorType];
            // The sender asked for no reply.
            if kind == TYPE_NULL {
                return;
            }
            let number: Option<Retained<AnyObject>> = msg_send![
                class!(NSAppleEventDescriptor),
                descriptorWithInt32: i32::from(code)
            ];
            let Some(number) = number else {
                return;
            };
            let _: () =
                msg_send![reply, setParamDescriptor: &*number, forKeyword: KEY_ERROR_NUMBER];
        }
    }

    /// Lets a held quit event go, with `error` in its reply. Main thread only. A panic before the
    /// resume would leave the sender waiting for good, so the only `Retained` result taken without
    /// a nil check is `sharedAppleEventManager`, which AppKit never returns as nil.
    fn resume(event: SuspendedEvent, error: Option<i16>) {
        // SAFETY: `event.id` came from `suspendCurrentAppleEvent`, is not null (`suspend`) and is
        // resumed once — `answer` takes it out of `WAITING` first.
        unsafe {
            let manager: Retained<AnyObject> =
                msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
            if let Some(code) = error {
                let reply: Option<Retained<AnyObject>> =
                    msg_send![&*manager, replyAppleEventForSuspensionID: event.id];
                if let Some(reply) = reply {
                    refuse(&reply, code);
                }
            }
            let _: () = msg_send![&*manager, resumeWithSuspensionID: event.id];
        }
    }

    /// While a close asks, AppKit would refuse the quit before tote hears of it.
    fn quit_event_action(asking_close: bool) -> QuitEventAction {
        if asking_close {
            QuitEventAction::Suspend
        } else {
            QuitEventAction::Terminate
        }
    }

    /// userCanceledErr: what the sender of a refused quit gets.
    fn resume_error_for(quit: bool) -> Option<i16> {
        (!quit).then_some(-128)
    }

    /// A new quit — an event to hold or a `terminate:` to tell 「later」 — is taken only while
    /// nothing waits; the one waiting keeps its answer.
    fn admits<E>(held: &Waiting<E>) -> bool {
        matches!(held, Waiting::None)
    }

    /// The refusal comes first: even with no window left or tote already going, a 「now」 here
    /// would end tote before the waiting quit is answered.
    fn terminate_decision<E>(
        held: &Waiting<E>,
        has_windows: bool,
        quitting: bool,
    ) -> TerminateDecision {
        if !admits(held) {
            TerminateDecision::Cancel
        } else if !has_windows || quitting {
            // No window has anything to write; and once tote is going, it goes.
            TerminateDecision::Now
        } else {
            TerminateDecision::Flush
        }
    }

    /// Takes what waits out of `slot`: how to reply to it, and what `answer` returns.
    fn settle<E>(slot: &mut Waiting<E>, quit: bool) -> (Option<Reply<E>>, bool) {
        match std::mem::replace(slot, Waiting::None) {
            Waiting::None => (None, false),
            Waiting::Terminate => (Some(Reply::Terminate(quit)), true),
            // A held event's reply does not end tote: with 「yes」 `finish` exits by itself.
            Waiting::QuitEvent(event) => {
                (Some(Reply::Resume(event, resume_error_for(quit))), !quit)
            }
        }
    }

    extern "C-unwind" fn should_terminate(
        _: &AnyObject,
        _: Sel,
        _: *mut AnyObject,
    ) -> NSApplicationTerminateReply {
        let Some(app) = APP.get() else {
            return NSApplicationTerminateReply::TerminateNow;
        };
        let core = app.state::<AppCore>();
        let mut waiting = waiting();
        match terminate_decision(&waiting, core.has_windows(), core.is_quitting()) {
            TerminateDecision::Cancel => NSApplicationTerminateReply::TerminateCancel,
            TerminateDecision::Now => NSApplicationTerminateReply::TerminateNow,
            TerminateDecision::Flush => {
                let round = core.begin_flush(FlushGoal::Quit);
                let reply = reply_for(&round);
                if reply == NSApplicationTerminateReply::TerminateLater {
                    *waiting = Waiting::Terminate;
                    // `run` may answer at once, which takes the lock.
                    drop(waiting);
                    super::run(app, round, FlushGoal::Quit.kind());
                }
                reply
            }
        }
    }

    /// 「Later」 only while a round is left to answer it. A round that is over as it starts
    /// (no window to wait for) is answered now: an answer given before 「later」 is returned is
    /// lost, and macOS would wait for good.
    fn reply_for(round: &Begin) -> NSApplicationTerminateReply {
        match round {
            Begin::Started { .. } | Begin::AlreadyRunning => {
                NSApplicationTerminateReply::TerminateLater
            }
            Begin::Done(_) => NSApplicationTerminateReply::TerminateNow,
        }
    }

    /// Tells a waiting macOS whether tote quits, once. False when tote is to exit by itself: the
    /// quit came from tote's own menu, or it goes on a held quit event, whose reply does not end
    /// tote the way `replyToApplicationShouldTerminate:` does.
    pub fn answer(app: &AppHandle, quit: bool) -> bool {
        let (reply, answered) = settle(&mut waiting(), quit);
        let Some(reply) = reply else {
            return answered;
        };
        let replied = app.run_on_main_thread(move || match reply {
            Reply::Terminate(quit) => {
                if let Some(mtm) = MainThreadMarker::new() {
                    NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(quit);
                }
            }
            Reply::Resume(event, error) => resume(event, error),
        });
        if let Err(err) = replied {
            eprintln!("tote: could not answer macOS's quit: {err}");
        }
        answered
    }

    #[cfg(test)]
    mod tests {
        use super::super::super::flush::{Begin, FlushGoal};
        use super::*;

        #[test]
        fn only_a_round_left_running_makes_macos_wait() {
            let started = Begin::Started {
                id: 1,
                windows: vec!["a".into()],
            };
            assert_eq!(
                reply_for(&started),
                NSApplicationTerminateReply::TerminateLater
            );
            assert_eq!(
                reply_for(&Begin::AlreadyRunning),
                NSApplicationTerminateReply::TerminateLater
            );
            // Nothing will answer later: a 「later」 here would leave macOS waiting for good.
            assert_eq!(
                reply_for(&Begin::Done(FlushGoal::Quit)),
                NSApplicationTerminateReply::TerminateNow
            );
        }

        #[test]
        fn a_quit_event_during_an_asking_close_waits_for_its_answer() {
            // `terminate:` would be refused by AppKit with the sheet up.
            assert_eq!(quit_event_action(true), QuitEventAction::Suspend);
            assert_eq!(quit_event_action(false), QuitEventAction::Terminate);
        }

        #[test]
        fn every_answer_resumes_a_suspended_quit_event() {
            // A 「no」 reaches the sender as userCanceledErr, like AppKit's own refusal.
            assert_eq!(resume_error_for(false), Some(-128));
            assert_eq!(resume_error_for(true), None);

            // 「취소」: refused, and macOS was waiting.
            let mut slot = Waiting::QuitEvent(7);
            assert_eq!(
                settle(&mut slot, false),
                (Some(Reply::Resume(7, Some(-128))), true)
            );
            assert!(matches!(slot, Waiting::None));
            // 「그래도」: the reply does not end tote, so `finish` exits by itself.
            let mut slot = Waiting::QuitEvent(7);
            assert_eq!(
                settle(&mut slot, true),
                (Some(Reply::Resume(7, None)), false)
            );
            assert!(matches!(slot, Waiting::None));
        }

        #[test]
        fn every_answer_settles_what_macos_waits_on_once() {
            for quit in [true, false] {
                let mut slot: Waiting<u32> = Waiting::Terminate;
                assert_eq!(
                    settle(&mut slot, quit),
                    (Some(Reply::Terminate(quit)), true)
                );
                // Answered: a later answer finds nothing to settle.
                assert_eq!(settle(&mut slot, quit), (None, false));
            }
            // Nothing waits: the quit came from tote's own menu.
            let mut slot: Waiting<u32> = Waiting::None;
            assert_eq!(settle(&mut slot, true), (None, false));
        }

        #[test]
        fn a_new_quit_while_one_is_held_is_refused() {
            assert!(admits(&Waiting::<u32>::None));
            assert!(!admits(&Waiting::<u32>::Terminate));
            assert!(!admits(&Waiting::QuitEvent(7)));
        }

        #[test]
        fn a_terminate_while_a_quit_event_is_held_is_cancelled() {
            // After 「그래도 닫기」 the quit round runs with no sheet up: a second Dock quit or a
            // logout reaches `applicationShouldTerminate:` while the first event is held. Cancel
            // comes first, whatever tote's state: the held event keeps its answer for later.
            for (windows, quitting) in [(true, false), (false, false), (true, true)] {
                assert_eq!(
                    terminate_decision(&Waiting::QuitEvent(7), windows, quitting),
                    TerminateDecision::Cancel
                );
                assert_eq!(
                    terminate_decision(&Waiting::<u32>::Terminate, windows, quitting),
                    TerminateDecision::Cancel
                );
            }
            let free = Waiting::<u32>::None;
            assert_eq!(
                terminate_decision(&free, true, false),
                TerminateDecision::Flush
            );
            // No window has anything to write; and once tote is going, it goes.
            assert_eq!(
                terminate_decision(&free, false, false),
                TerminateDecision::Now
            );
            assert_eq!(
                terminate_decision(&free, true, true),
                TerminateDecision::Now
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_blocked_question_says_the_text_is_lost() {
        let reasons = ["저장하지 못한 메모 1개".to_string()];
        for (goal, text) in [
            (close(), "그래도 닫으면 저장하지 못한 글은 사라집니다."),
            (switch(), "그래도 바꾸면 저장하지 못한 글은 사라집니다."),
            (
                FlushGoal::Quit,
                "그래도 종료하면 저장하지 못한 글은 사라집니다.",
            ),
        ] {
            assert_eq!(
                blocked_message(&goal, &reasons),
                format!("저장하지 못한 메모 1개\n{text}")
            );
        }
    }

    fn close() -> FlushGoal {
        FlushGoal::CloseWindow("a".into())
    }

    fn switch() -> FlushGoal {
        FlushGoal::SwitchWorkspace {
            label: "a".into(),
            to: "/w/나".into(),
        }
    }

    #[test]
    fn every_answer_settles_a_waiting_system_quit() {
        let table = [
            // `finish` answers macOS 「yes」.
            (
                FlushGoal::Quit,
                true,
                false,
                vec![Step::Finish(FlushGoal::Quit)],
            ),
            // Refused here.
            (FlushGoal::Quit, false, false, vec![Step::RefuseSystemQuit]),
            // No quit joined: macOS is not waiting on this round.
            (close(), true, false, vec![Step::Finish(close())]),
            // No quit joined: macOS is not waiting on this round.
            (close(), false, false, vec![]),
            // The new quit round answers when it ends.
            (
                close(),
                true,
                true,
                vec![Step::Finish(close()), Step::BeginQuit],
            ),
            // Refused here.
            (close(), false, true, vec![Step::RefuseSystemQuit]),
            // A switch is a window round like a close. With a quit right after it, the switch is
            // carried out — the window reloads on its new workspace — then the quit begins
            // (`run_steps`).
            (switch(), true, false, vec![Step::Finish(switch())]),
            (switch(), false, false, vec![]),
            (
                switch(),
                true,
                true,
                vec![Step::Finish(switch()), Step::BeginQuit],
            ),
            (switch(), false, true, vec![Step::RefuseSystemQuit]),
        ];
        for (goal, anyway, quit_waiting, steps) in table {
            assert_eq!(
                steps_for_answer(goal.clone(), anyway, quit_waiting),
                steps,
                "{goal:?}, anyway {anyway}, quit waiting {quit_waiting}"
            );
        }
    }

    #[test]
    fn a_late_answer_keeps_a_switching_window_empty() {
        // The round ended without this answer: the page stays empty only while its window goes.
        assert!(keeps_leaving(&Ack::Stale, true));
        assert!(!keeps_leaving(&Ack::Stale, false));
        assert!(keeps_leaving(&Ack::Done(switch()), false));
    }

    #[test]
    fn every_exit_that_keeps_the_window_says_stay() {
        let table = [
            // 「취소」 to the question.
            (close(), Exit::Cancelled, true),
            (switch(), Exit::Cancelled, true),
            // Another window shows the workspace by now: it comes forward instead.
            (switch(), Exit::Shown, true),
            // The workspace could not be opened, or the window not switched to it.
            (switch(), Exit::NotSwitched, true),
            (close(), Exit::NotClosed, true),
            // The window is gone, or reloads on its new workspace.
            (close(), Exit::Done, false),
            (switch(), Exit::Done, false),
        ];
        for (goal, exit, stays) in table {
            assert_eq!(keeps_window(&goal, exit), stays, "{goal:?}, {exit:?}");
        }
        // A quit's windows never let go of their panes.
        for exit in [
            Exit::Done,
            Exit::Cancelled,
            Exit::Shown,
            Exit::NotSwitched,
            Exit::NotClosed,
        ] {
            assert!(!keeps_window(&FlushGoal::Quit, exit), "{exit:?}");
        }
    }

    #[test]
    fn every_ack_carries_its_goal_out_or_asks() {
        let reasons = vec!["저장하지 못한 메모 1개".to_string()];
        assert_eq!(steps_for_ack(Ack::Pending), vec![]);
        assert_eq!(
            steps_for_ack(Ack::Done(close())),
            vec![Step::Finish(close())]
        );
        assert_eq!(
            steps_for_ack(Ack::DoneThenQuit(close())),
            vec![Step::Finish(close()), Step::BeginQuit]
        );
        assert_eq!(
            steps_for_ack(Ack::Blocked {
                goal: close(),
                reasons: reasons.clone(),
            }),
            vec![Step::Ask {
                goal: close(),
                reasons,
            }]
        );
    }
}
