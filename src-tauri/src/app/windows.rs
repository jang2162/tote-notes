//! Workspace windows, labelled `ws-<n>` by `AppCore::next_label`. Windows on one folder share
//! its workspace.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

use super::commands::CommandError;
use super::flush::FlushGoal;
use super::places::TabKey;
use super::{lifecycle, requests, AppCore, SwitchTarget};
use crate::cli::CliRequest;
use crate::session::{layout_frame, WindowFrame};
use crate::workspace::{Workspace, DEFAULT_WORKSPACE};

const DEFAULT_WIDTH: f64 = 1100.0;
const DEFAULT_HEIGHT: f64 = 760.0;
/// How far right and down a new window sits from the window it came from.
const NEAR_OFFSET: f64 = 24.0;
/// The title bar sits above a frame's inner `height`, so the window is this much taller outside.
const TITLE_BAR_HEIGHT: f64 = 28.0;

/// Debug builds started with `TOTE_BACKGROUND=1` — smoke checks run by agents — open windows
/// without taking focus, so a check never pulls the person's screen away.
pub fn background() -> bool {
    cfg!(debug_assertions) && std::env::var_os("TOTE_BACKGROUND").is_some()
}

/// Where a new window's frame comes from.
pub enum WindowPlan {
    /// The `n`th window of the workspace reopened (from 0): its saved layout and frame.
    Restore(usize),
    /// A window of its own, at `near` when given, else at the default size in the middle.
    Fresh { near: Option<WindowFrame> },
    /// A window of its own for the tab `key` of window `from`, which `tab` (its session entry)
    /// describes: the window starts with that tab alone (`AppCore::adopt_tab`). Placed as `Fresh`.
    Tab {
        tab: Value,
        near: Option<WindowFrame>,
        from: String,
        key: TabKey,
    },
}

/// Where a window opened from the window at `source` goes: a little right and down of it, at its
/// size. The caller still fits it onto a monitor (`place`).
pub fn near_frame(source: WindowFrame) -> WindowFrame {
    WindowFrame {
        x: source.x + NEAR_OFFSET,
        y: source.y + NEAR_OFFSET,
        ..source
    }
}

/// Where `window` is, as the session keeps it: logical outer position and inner size.
pub fn frame_of(window: &WebviewWindow) -> Option<WindowFrame> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(WindowFrame {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
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

/// What `switch` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Switched {
    /// The window shows the workspace already, or another window showing it came forward; this
    /// window stays as it is.
    Focused,
    /// The window writes its tabs, then shows the workspace (`FlushGoal::SwitchWorkspace`).
    Switching,
}

/// Window `label` asks to show the workspace at `to` (the rail, ⌃1–⌃9, a workspace just made).
/// `not-a-workspace` when `to` is not one.
pub fn switch(app: &AppHandle, label: &str, to: &Path) -> Result<Switched, CommandError> {
    let core = app.state::<AppCore>();
    let to = std::fs::canonicalize(to)?;
    match core.switch_target(label, &to) {
        SwitchTarget::Stay => Ok(Switched::Focused),
        SwitchTarget::Focus(other) => {
            focus(app, &other);
            Ok(Switched::Focused)
        }
        SwitchTarget::Open if !Workspace::is_workspace(&to) => Err(CommandError::new(
            "not-a-workspace",
            format!("{} is not a tote workspace", to.display()),
        )),
        SwitchTarget::Open => {
            lifecycle::begin(
                app,
                FlushGoal::SwitchWorkspace {
                    label: label.to_string(),
                    to,
                },
            );
            Ok(Switched::Switching)
        }
    }
}

/// Opens a new window on the workspace at `path`. Reopening a saved window opens the workspace too
/// when no window shows it yet; a window of its own (`Fresh`, `Tab`) joins a workspace a window
/// shows. Returns the window's label.
pub fn open_window(app: &AppHandle, path: &Path, plan: WindowPlan) -> Result<String, CommandError> {
    let core = app.state::<AppCore>();
    let path = std::fs::canonicalize(path)?;
    let (label, fresh, frame, undo) = match plan {
        WindowPlan::Restore(k) => {
            // Another request is opening a window on this folder right now: that window is the
            // answer. Opening one here as well could run `Workspace::open` twice for one folder.
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
            core.register_window(&label, &path, opened, Some(k));
            let frame = core.saved_layout(&path, k).as_ref().and_then(layout_frame);
            (label, fresh, frame, Undo::Release)
        }
        WindowPlan::Fresh { near } => (join(&core, &path)?, false, near, Undo::Release),
        WindowPlan::Tab {
            tab,
            near,
            from,
            key,
        } => {
            let label = join(&core, &path)?;
            // In the session before the window exists: a quit while it loads keeps the tab.
            if let Err(err) = core.adopt_tab(&label, &from, tab, key.clone()) {
                core.release(&label);
                return Err(err.into());
            }
            (label, false, near, Undo::GiveBack { from, key })
        }
    };
    let title = title_of(&core, &path, &label);
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .min_inner_size(480.0, 320.0)
        .focused(!background());
    let builder = match frame.and_then(|f| place(f, &monitor_rects(app))) {
        Some(f) => builder.position(f.x, f.y).inner_size(f.width, f.height),
        None => builder.inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT).center(),
    };
    if let Err(err) = builder.build() {
        match undo {
            Undo::Release => core.release(&label),
            Undo::GiveBack { from, key } => core.give_back(&label, &from, &key),
        }
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

/// How `open_window` takes back a window it could not make.
enum Undo {
    Release,
    /// The torn-off tab goes back to the window it came from.
    GiveBack {
        from: String,
        key: TabKey,
    },
}

fn join(core: &AppCore, path: &Path) -> Result<String, CommandError> {
    core.join(path).ok_or_else(|| {
        CommandError::new(
            "no-workspace",
            format!("no window shows {}", path.display()),
        )
    })
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
///
/// Every window is made here before any frontend runs — `setup` runs before the event loop — so
/// the first layout a window writes cannot drop from the session file the saved layout of a
/// window not reopened yet.
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
    let monitors = match app.available_monitors() {
        Ok(monitors) => monitors,
        Err(err) => {
            eprintln!("tote: no monitors: {err}");
            Vec::new()
        }
    };
    if monitors.is_empty() {
        eprintln!("tote: no monitors: the list is empty");
    }
    monitors
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

/// `frame` moved onto the monitor its title bar is on, as a whole: shrunk to the monitor when
/// larger, then moved left and up until its far edges are inside. `None` when no monitor holds
/// that spot, so the caller opens the window at the default size in the middle.
pub fn place(frame: WindowFrame, monitors: &[(f64, f64, f64, f64)]) -> Option<WindowFrame> {
    let (px, py) = (frame.x + 40.0, frame.y + 10.0);
    let &(mx, my, mw, mh) = monitors
        .iter()
        .find(|&&(mx, my, mw, mh)| px >= mx && px < mx + mw && py >= my && py < my + mh)?;
    let width = frame.width.min(mw);
    let height = frame.height.min(mh - TITLE_BAR_HEIGHT);
    Some(WindowFrame {
        x: frame.x.min(mx + mw - width),
        y: frame.y.min(my + mh - height - TITLE_BAR_HEIGHT),
        width,
        height,
    })
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

    #[test]
    fn a_new_window_sits_near_its_source() {
        let source = WindowFrame {
            x: 100.0,
            y: 50.0,
            width: 900.0,
            height: 700.0,
        };
        assert_eq!(
            near_frame(source),
            WindowFrame {
                x: 124.0,
                y: 74.0,
                width: 900.0,
                height: 700.0
            }
        );
    }

    const M: [(f64, f64, f64, f64); 3] = [
        (0.0, 0.0, 3840.0, 1600.0),
        (3840.0, -734.0, 1440.0, 2560.0),
        (0.0, 1600.0, 2560.0, 1440.0),
    ];

    fn at(x: f64, y: f64, width: f64, height: f64) -> WindowFrame {
        WindowFrame {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_new_window_at_a_monitor_corner_stays_on_it() {
        let source = at(4180.0, 1060.0, 1100.0, 760.0);
        assert_eq!(
            place(near_frame(source), &M),
            Some(at(4180.0, 1038.0, 1100.0, 760.0))
        );
    }

    #[test]
    fn a_saved_frame_half_off_its_monitor_moves_in() {
        assert_eq!(
            place(at(5000.0, 100.0, 900.0, 700.0), &M),
            Some(at(4380.0, 100.0, 900.0, 700.0))
        );
    }

    #[test]
    fn a_window_larger_than_its_monitor_shrinks_to_fit() {
        assert_eq!(
            place(at(3840.0, -734.0, 2000.0, 3000.0), &M),
            Some(at(3840.0, -734.0, 1440.0, 2532.0))
        );
    }

    #[test]
    fn a_frame_on_no_monitor_is_dropped() {
        let frame = at(6000.0, 100.0, 900.0, 700.0);
        assert_eq!(place(frame, &M), None);
        assert_eq!(place(frame, &[]), None);
    }

    #[test]
    fn a_frame_inside_a_monitor_is_kept() {
        let frame = at(100.0, 100.0, 900.0, 600.0);
        assert_eq!(place(frame, &M), Some(frame));
    }
}
