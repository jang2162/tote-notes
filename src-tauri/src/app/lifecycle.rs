//! Closing a window, switching its workspace and quitting: the affected windows write their
//! edits first, then the window or tote goes. Writing on close and quit is what bounds the loss
//! when a hidden window's timers stall (spec 「저장」). A save that keeps failing is the one thing
//! that asks first (spec 「오류 처리」).

use std::path::Path;
use std::time::Duration;

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
    RefuseSystemQuit,
    Ask {
        goal: FlushGoal,
        reasons: Vec<String>,
    },
}

pub fn steps_for_ack(ack: Ack) -> Vec<Step> {
    match ack {
        Ack::Pending => vec![],
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

pub fn begin(app: &AppHandle, goal: FlushGoal) {
    let round = app.state::<AppCore>().begin_flush(goal);
    run(app, round);
}

/// Carries out what starting a round calls for.
fn run(app: &AppHandle, round: Begin) {
    match round {
        Begin::Done(goal) => finish(app, goal),
        Begin::AlreadyRunning => {}
        Begin::Started { id, windows } => {
            for label in &windows {
                let _ = app.emit_to(
                    EventTarget::webview_window(label.as_str()),
                    "tote://flush",
                    id,
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
/// not write everything.
pub fn ack(app: &AppHandle, id: u64, label: &str, blocked: Option<String>) {
    let ack = app.state::<AppCore>().ack_flush(id, label, blocked);
    settle(app, id, ack);
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
            // A Dock quit is still waiting on macOS's answer; the quit round's own end gives it.
            Step::BeginQuit => begin(app, FlushGoal::Quit),
            Step::RefuseSystemQuit => {
                #[cfg(target_os = "macos")]
                system_quit::answer(app, false);
            }
            Step::Ask { goal, reasons } => ask_blocked(app, id, goal, &reasons),
        }
    }
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
        .message(reasons.join("\n"))
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
    run_steps(app, id, steps_for_answer(goal, anyway, quit_waiting));
}

pub fn finish(app: &AppHandle, goal: FlushGoal) {
    match goal {
        FlushGoal::CloseWindow(label) => {
            // `closed` comes only once the window is gone: a quit begun right after this (a
            // joined quit's `BeginQuit`) must neither wait on the window nor reopen it.
            app.state::<AppCore>().closing(&label);
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.destroy();
            }
        }
        FlushGoal::SwitchWorkspace { label, to } => switch_window(app, &label, &to),
        FlushGoal::Quit => {
            app.state::<AppCore>().start_quit();
            // macOS asked first (the Dock, a logout): answering it, not `exit`, lets a logout go
            // on once tote is gone.
            #[cfg(target_os = "macos")]
            if system_quit::answer(app, true) {
                return;
            }
            app.exit(0);
        }
    }
}

/// Window `label` wrote its tabs: it shows the workspace at `to` now, unless a window came to show
/// it meanwhile — that one comes forward and this one stays — or it cannot be opened, which the
/// window's status bar says.
fn switch_window(app: &AppHandle, label: &str, to: &Path) {
    let core = app.state::<AppCore>();
    let opened = match core.prepare_switch(label, to) {
        Ok(opened) => opened,
        Err(SwitchError::Shown(other)) => return windows::focus(app, &other),
        Err(SwitchError::Open(err)) => {
            core.push_pending(
                label,
                PendingOpen::Notice {
                    message: format!("워크스페이스를 열지 못했습니다: {err}"),
                },
            );
            let _ = app.emit_to(EventTarget::webview_window(label), "tote://pending", ());
            return;
        }
    };
    let from = core.path_of(label);
    if let Err(err) = core.switch_window(label, to, opened) {
        eprintln!("tote: {label}: could not switch to {}: {err}", to.display());
        return;
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
    use tauri::{AppHandle, Manager};

    use super::super::flush::{Begin, FlushGoal};
    use super::super::AppCore;

    type ShouldTerminate =
        extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> NSApplicationTerminateReply;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// macOS was told 「later」 and waits for `replyToApplicationShouldTerminate:`.
    static WAITING: AtomicBool = AtomicBool::new(false);

    const NOT_HOOKED: &str =
        "tote: could not answer macOS's quit; the Dock's quit will not write first";

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
        let class: &AnyClass = AsRef::<AnyObject>::as_ref(&*delegate).class();
        let method: ShouldTerminate = should_terminate;
        // SAFETY: the class is tao's own, registered at runtime without this selector, and the
        // function matches the encoding: returns NSUInteger (`Q`), takes self, _cmd and the sender.
        let added = unsafe {
            class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                sel!(applicationShouldTerminate:),
                std::mem::transmute::<ShouldTerminate, Imp>(method),
                c"Q@:@".as_ptr(),
            )
        };
        if !added.as_bool() {
            eprintln!("{NOT_HOOKED}");
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
        // No window has anything to write; and once tote is going, it goes.
        if !core.has_windows() || core.is_quitting() {
            return NSApplicationTerminateReply::TerminateNow;
        }
        let round = core.begin_flush(FlushGoal::Quit);
        let reply = reply_for(&round);
        if reply == NSApplicationTerminateReply::TerminateLater {
            WAITING.store(true, Ordering::SeqCst);
            super::run(app, round);
        }
        reply
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

    /// Tells a waiting macOS whether tote quits. False when macOS is not waiting — the quit came
    /// from tote's own menu, and tote exits by itself.
    pub fn answer(app: &AppHandle, quit: bool) -> bool {
        if !WAITING.swap(false, Ordering::SeqCst) {
            return false;
        }
        let replied = app.run_on_main_thread(move || {
            if let Some(mtm) = MainThreadMarker::new() {
                NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(quit);
            }
        });
        if let Err(err) = replied {
            eprintln!("tote: could not answer macOS's quit: {err}");
        }
        true
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
