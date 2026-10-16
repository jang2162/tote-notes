//! Workspace windows, labelled `ws-<n>` by `AppCore::next_label`. Windows on one folder share
//! its workspace.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

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

/// Where a new window's frame comes from.
pub enum WindowPlan {
    /// The `n`th window of the workspace reopened (from 0): its saved frame.
    Restore(usize),
    /// A window of its own, at `near` when given, else at the default size in the middle.
    Fresh { near: Option<WindowFrame> },
}

/// Shows the workspace at `path`: its window focused most recently comes to the front, or a
/// window opens when none shows it. Returns the window's label.
pub fn show(app: &AppHandle, path: &Path) -> Result<String, CommandError> {
    let core = app.state::<AppCore>();
    let path = std::fs::canonicalize(path)?;
    // A window still being made is in the list too: it shows the workspace as soon as it is up.
    if let Some(label) = core.front_window_of(&path) {
        focus(app, &label);
        return Ok(label);
    }
    open_window(app, &path, WindowPlan::Restore(0))
}

/// Opens a new window on the workspace at `path`, opening the workspace too when no window shows
/// it yet. Returns the window's label.
pub fn open_window(app: &AppHandle, path: &Path, plan: WindowPlan) -> Result<String, CommandError> {
    let core = app.state::<AppCore>();
    let path = std::fs::canonicalize(path)?;
    // Another request is opening a window on this folder right now: that window is the answer.
    // Opening one here as well could run `Workspace::open` twice for one folder.
    let label = match core.reserve(&path) {
        Ok(label) => label,
        Err(opening) => return Ok(opening),
    };
    let opened = if core.is_open_path(&path) {
        None
    } else {
        match Workspace::open(&path) {
            Ok(workspace) => Some(workspace),
            Err(err) => {
                core.release(&label);
                return Err(err.into());
            }
        }
    };
    let fresh = opened.is_some();
    let frame = match plan {
        // The session file keeps one frame per device, so every window reopened on a folder
        // starts from it.
        WindowPlan::Restore(_) => read_window_frame(&path, &core.machine.device_id),
        WindowPlan::Fresh { near } => near,
    };
    core.register_window(&label, &path, opened);
    let title = title_of(&core, &path, &label);
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
    retitle(app, &path);
    // A workspace just opened is marked changed; have the backup thread take it now. A second
    // window brings nothing new.
    if fresh {
        core.request_backup(&label);
    }
    Ok(label)
}

fn title_of(core: &AppCore, path: &Path, label: &str) -> String {
    core.titles_of(path)
        .into_iter()
        .find(|(l, _)| l == label)
        .map(|(_, title)| title)
        .unwrap_or_default()
}

/// Titles the windows on `path` again (`AppCore::titles_of`): after one opens or goes, the
/// numbers shift.
pub fn retitle(app: &AppHandle, path: &Path) {
    for (label, title) in app.state::<AppCore>().titles_of(path) {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_title(&title);
        }
    }
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
    // A workspace shown in two windows is listed twice; the nth entry reopens its nth window.
    let mut nth: HashMap<PathBuf, usize> = HashMap::new();
    // A folder that is gone stays in the recent list, so the picker offers it as 「찾을 수 없음」
    // and the person can point tote at the place it moved to.
    for path in core.take_open_windows() {
        let count = nth.entry(path.clone()).or_default();
        let plan = WindowPlan::Restore(*count);
        *count += 1;
        match open_window(app, &path, plan) {
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
            let path = core.path_of(label);
            for (id, ack) in core.closed(label) {
                lifecycle::settle(app, id, ack);
            }
            if let Some(path) = path {
                retitle(app, &path);
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
