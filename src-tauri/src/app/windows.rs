//! Workspace windows: one per workspace folder, labelled by `AppCore::label_for`.

use std::path::Path;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

use super::commands::CommandError;
use super::flush::FlushGoal;
use super::{lifecycle, requests, AppCore};
use crate::cli::CliRequest;
use crate::session::{read_window_frame, WindowFrame};
use crate::workspace::{Workspace, DEFAULT_WORKSPACE};

const DEFAULT_WIDTH: f64 = 1100.0;
const DEFAULT_HEIGHT: f64 = 760.0;

/// Debug builds started with `TOTE_BACKGROUND=1` — smoke checks run by agents — open windows
/// without taking focus, so a check never pulls the person's screen away.
pub fn background() -> bool {
    cfg!(debug_assertions) && std::env::var_os("TOTE_BACKGROUND").is_some()
}

/// Shows the window of the workspace at `path`, opening it when needed. Returns its label.
pub fn show(app: &AppHandle, path: &Path) -> Result<String, CommandError> {
    let core = app.state::<AppCore>();
    let path = std::fs::canonicalize(path)?;
    let label = AppCore::label_for(&path);
    if app.get_webview_window(&label).is_some() {
        focus(app, &label);
        return Ok(label);
    }
    // Another request is already opening this folder: it shows the window, so opening it again
    // here would run `Workspace::open` twice and could undo the first one's registration.
    if !core.reserve(&label) {
        return Ok(label);
    }
    let workspace = match Workspace::open(&path) {
        Ok(workspace) => workspace,
        Err(err) => {
            core.release(&label);
            return Err(err.into());
        }
    };
    let title = workspace.name();
    let frame = read_window_frame(workspace.root(), &core.machine.device_id);
    core.register(&label, workspace);
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .min_inner_size(480.0, 320.0)
        .focused(!background());
    let builder = match frame.filter(|f| frame_visible(f, &monitor_rects(app))) {
        Some(f) => builder.position(f.x, f.y).inner_size(f.width, f.height),
        None => builder.inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT).center(),
    };
    if let Err(err) = builder.build() {
        core.release(&label);
        return Err(err.into());
    }
    crate::perf::mark("window-shown");
    core.opened(&label);
    Ok(label)
}

pub fn focus(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        if !background() {
            let _ = window.set_focus();
        }
    }
}

/// Reopens the windows open at the last quit, then carries out the `tote` request that started
/// the app, if any.
pub fn restore(app: &AppHandle, request: Option<CliRequest>) {
    let core = app.state::<AppCore>();
    let mut shown = 0;
    // A folder that is gone stays in the recent list, so the picker offers it as 「찾을 수 없음」
    // and the person can point tote at the place it moved to.
    for path in core.take_open_windows() {
        match show(app, &path) {
            Ok(_) => shown += 1,
            Err(err) => eprintln!("tote: {}: {}", path.display(), err.message),
        }
    }
    let names_a_workspace = request.as_ref().is_some_and(|r| r.workspace.is_some());
    if shown == 0 && !names_a_workspace {
        open_latest(app);
    }
    if let Some(request) = request {
        requests::handle(app, request);
    }
}

/// Opens the most recently used workspace; on a first launch makes the default one.
pub fn open_latest(app: &AppHandle) {
    let core = app.state::<AppCore>();
    let path = match core.fallback_workspace() {
        Some(path) => path,
        None => match Workspace::create(&core.workspace_root(), DEFAULT_WORKSPACE) {
            Ok(workspace) => workspace.root().to_path_buf(),
            Err(err) => {
                eprintln!("tote: {err}");
                return;
            }
        },
    };
    if let Err(err) = show(app, &path) {
        eprintln!("tote: {}: {}", path.display(), err.message);
    }
}

pub fn on_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    let Some(core) = app.try_state::<AppCore>() else {
        return;
    };
    let label = window.label();
    match event {
        WindowEvent::Focused(true) => core.focused(label),
        // Closing writes first: the frontend gets `tote://flush`, and the window goes once it
        // answers or the timeout runs out.
        WindowEvent::CloseRequested { api, .. } if !core.is_quitting() => {
            api.prevent_close();
            lifecycle::begin(app, FlushGoal::CloseWindow(label.to_string()));
        }
        WindowEvent::Destroyed => {
            for (id, ack) in core.closed(label) {
                lifecycle::settle(app, id, ack);
            }
        }
        _ => {}
    }
}

/// Monitors as (x, y, width, height) in logical pixels.
fn monitor_rects(app: &AppHandle) -> Vec<(f64, f64, f64, f64)> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let (pos, size) = (monitor.position(), monitor.size());
            (
                f64::from(pos.x) / scale,
                f64::from(pos.y) / scale,
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            )
        })
        .collect()
}

/// A saved frame is reused only when its title bar lies on a monitor that is still there —
/// otherwise the window would open where nobody can see or grab it.
pub fn frame_visible(frame: &WindowFrame, monitors: &[(f64, f64, f64, f64)]) -> bool {
    let (x, y) = (frame.x + 40.0, frame.y + 10.0);
    monitors
        .iter()
        .any(|&(mx, my, mw, mh)| x >= mx && x < mx + mw && y >= my && y < my + mh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_frame_is_reused_only_on_a_present_monitor() {
        let monitors = [(0.0, 0.0, 1512.0, 982.0), (-1920.0, 0.0, 1920.0, 1080.0)];
        let frame = |x: f64, y: f64| WindowFrame {
            x,
            y,
            width: 900.0,
            height: 700.0,
        };
        assert!(frame_visible(&frame(100.0, 50.0), &monitors));
        assert!(frame_visible(&frame(-1800.0, 100.0), &monitors));
        assert!(!frame_visible(&frame(4000.0, 100.0), &monitors));
        assert!(!frame_visible(&frame(100.0, 50.0), &[]));
    }
}
