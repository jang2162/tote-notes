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
/// carries the goal out.
pub fn resolve_blocked(app: &AppHandle, id: u64, goal: FlushGoal, anyway: bool) {
    app.state::<AppCore>().cancel_flush(id);
    if anyway {
        finish(app, goal);
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
            app.exit(0);
        }
    }
}
