//! Closing a window and quitting: the affected windows write their edits first, then tote goes.
//! Writing on close and quit is what bounds the loss when a hidden window's timers stall
//! (spec 「저장」). A save that keeps failing is the one thing that asks first (spec 「오류 처리」).

use std::time::Duration;

use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::flush::{Ack, Begin, FlushGoal};
use super::AppCore;

/// Long enough to write any memo to a local disk; short enough that a hung page cannot keep tote
/// from closing.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(3);

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
    match ack {
        Ack::Pending => {}
        Ack::Done(goal) => finish(app, goal),
        Ack::Blocked { goal, reasons } => ask_blocked(app, id, goal, &reasons),
    }
}

/// The text is still only in memory: going now loses it, so the person decides.
fn ask_blocked(app: &AppHandle, id: u64, goal: FlushGoal, reasons: &[String]) {
    let anyway = match goal {
        FlushGoal::CloseWindow(_) => "그래도 닫기",
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
    if let FlushGoal::CloseWindow(label) = &goal {
        if let Some(window) = app.get_webview_window(label) {
            dialog = dialog.parent(&window);
        }
    }
    let app = app.clone();
    dialog.show(move |anyway| resolve_blocked(&app, id, goal, anyway));
}

/// The question about round `id` was answered. Either answer ends the round; only 「그래도」
/// carries the goal out. A quit that joined a close's question goes the same way as the close.
pub fn resolve_blocked(app: &AppHandle, id: u64, goal: FlushGoal, anyway: bool) {
    let quit_waiting = app.state::<AppCore>().cancel_flush(id);
    if anyway {
        let close = matches!(goal, FlushGoal::CloseWindow(_));
        finish(app, goal);
        // A Dock quit is still waiting on macOS's answer; the quit round's own end gives it.
        if close && quit_waiting {
            begin(app, FlushGoal::Quit);
        }
    } else if goal == FlushGoal::Quit || quit_waiting {
        #[cfg(target_os = "macos")]
        system_quit::answer(app, false);
    }
}

pub fn finish(app: &AppHandle, goal: FlushGoal) {
    match goal {
        FlushGoal::CloseWindow(label) => {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.destroy();
            }
        }
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
