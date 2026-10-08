//! Closing a window and quitting: the affected windows write their edits first, then tote goes.
//! Writing on close and quit is what bounds the loss when a hidden window's timers stall
//! (spec 「저장」).

use std::time::Duration;

use tauri::{AppHandle, Emitter, EventTarget, Manager};

use super::flush::{Begin, FlushGoal};
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
                let goal = app.state::<AppCore>().expire_flush(id);
                if let Some(goal) = goal {
                    finish(&app, goal);
                }
            });
        }
    }
}

/// A window's frontend answered round `id` (`flush_done`).
pub fn ack(app: &AppHandle, id: u64, label: &str) {
    let goal = app.state::<AppCore>().ack_flush(id, label);
    if let Some(goal) = goal {
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
