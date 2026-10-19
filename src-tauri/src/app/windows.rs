//! Workspace windows, labelled `ws-<n>` by `AppCore::next_label`. Windows on one folder share
//! its workspace.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{
    AppHandle, Manager, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};

use super::commands::CommandError;
use super::flush::FlushGoal;
use super::menu::{change_shortcuts, MenuShortcuts};
use super::places::TabKey;
use super::{lifecycle, requests, AppCore, DropCandidate, SwitchTarget};
use crate::cli::CliRequest;
use crate::session::{layout_frame, WindowFrame};
use crate::workspace::{Workspace, DEFAULT_WORKSPACE};

const DEFAULT_WIDTH: f64 = 1100.0;
const DEFAULT_HEIGHT: f64 = 760.0;
/// How far right and down a new window sits from the window it came from.
const NEAR_OFFSET: f64 = 24.0;

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

/// Where a window opened from the window at `source` goes: `NEAR_OFFSET` right and down of it, at
/// its size, except that an axis which would run past the work area of the monitor `source` is on
/// steps left or up instead. The caller still fits it onto a monitor (`place`).
pub fn cascade(source: WindowFrame, monitors: &[MonitorRect]) -> WindowFrame {
    let Some((wx, wy, ww, wh)) = monitor_at(source, monitors).map(|m| m.work) else {
        return WindowFrame {
            x: source.x + NEAR_OFFSET,
            y: source.y + NEAR_OFFSET,
            ..source
        };
    };
    let step = |at: f64, extent: f64, start: f64, size: f64| {
        if at + NEAR_OFFSET + extent > start + size {
            at - NEAR_OFFSET
        } else {
            at + NEAR_OFFSET
        }
    };
    WindowFrame {
        x: step(source.x, source.width, wx, ww),
        y: step(source.y, source.height, wy, wh),
        ..source
    }
}

/// Where `window` is, as the session keeps it: logical outer position and inner size.
/// Tauri's default title bar style on macOS gives the window a full-size content view, so a
/// frame's inner height is the whole window's.
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

/// Window `label` asks to show the workspace at `to` (the switcher, ⌃1–⌃9, a workspace just made).
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
            if !core.register_window(&label, &path, opened, Some(k)) {
                core.release(&label);
                return Err(CommandError::new(
                    "not-a-workspace",
                    format!("{} is not open as a workspace", path.display()),
                ));
            }
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
    // A window recording a shortcut that loses focus or goes gives the menu its shortcuts back,
    // whether or not its page said it was done. Window events come on the main thread.
    if matches!(event, WindowEvent::Focused(false) | WindowEvent::Destroyed) {
        if let Some(shortcuts) = app.try_state::<MenuShortcuts>() {
            shortcuts.resume_if(window.label());
        }
    }
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

/// A page starting to load in a window recording a shortcut (a reload, as a workspace switch makes)
/// gives the menu its shortcuts back: the old page's word that it was done may not have arrived.
pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    if payload.event() == PageLoadEvent::Started {
        let label = webview.label().to_string();
        change_shortcuts(webview.app_handle(), move |menu| menu.resume_if(&label));
    }
}

/// A rectangle as (x, y, width, height).
pub type Rect = (f64, f64, f64, f64);

/// A monitor in logical pixels: the whole screen, and the part of it windows may use (the menu bar
/// and the Dock taken out).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorRect {
    pub full: Rect,
    pub work: Rect,
}

pub fn monitor_rects(app: &AppHandle) -> Vec<MonitorRect> {
    let monitors = match app.available_monitors() {
        Ok(monitors) if monitors.is_empty() => {
            eprintln!("tote: no monitors: the list is empty");
            return Vec::new();
        }
        Ok(monitors) => monitors,
        Err(err) => {
            eprintln!("tote: no monitors: {err}");
            return Vec::new();
        }
    };
    monitors
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let logical = |pos: &tauri::PhysicalPosition<i32>, size: &tauri::PhysicalSize<u32>| {
                (
                    f64::from(pos.x) / scale,
                    f64::from(pos.y) / scale,
                    f64::from(size.width) / scale,
                    f64::from(size.height) / scale,
                )
            };
            let work = monitor.work_area();
            MonitorRect {
                full: logical(monitor.position(), monitor.size()),
                work: logical(&work.position, &work.size),
            }
        })
        .collect()
}

/// The monitor holding the point 40px right of and 10px below `frame`'s corner, on its title bar.
fn monitor_at(frame: WindowFrame, monitors: &[MonitorRect]) -> Option<MonitorRect> {
    let (px, py) = (frame.x + 40.0, frame.y + 10.0);
    monitors.iter().copied().find(|m| {
        let (mx, my, mw, mh) = m.full;
        px >= mx && px < mx + mw && py >= my && py < my + mh
    })
}

/// `frame` moved into the work area of the monitor its title bar is on, as a whole: shrunk to the
/// work area when larger, then moved left and up until its far edges are inside, and right and
/// down until its near edges are. The monitor is picked on its full area, so a title bar over the
/// Dock still lands on its monitor. `None` when no monitor holds that spot, so the caller opens
/// the window at the default size in the middle.
pub fn place(frame: WindowFrame, monitors: &[MonitorRect]) -> Option<WindowFrame> {
    let (mx, my, mw, mh) = monitor_at(frame, monitors)?.work;
    let width = frame.width.min(mw);
    let height = frame.height.min(mh);
    Some(WindowFrame {
        x: frame.x.min(mx + mw - width).max(mx),
        y: frame.y.min(my + mh - height).max(my),
        width,
        height,
    })
}

/// A point on the screen in logical pixels, where a tab was let go outside its window.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

/// A window a tab dragged out of window `from` may land on (`window_at`).
pub struct WindowSpot<'a> {
    pub label: &'a str,
    pub frame: WindowFrame,
    /// Whether it shows the workspace of the window the tab comes from.
    pub same_workspace: bool,
    /// `AppCore::window_is_leaving`.
    pub leaving: bool,
}

/// The window a tab let go at `at`, outside window `from`, joins. `spots` are the windows most
/// recently focused first, which stands for front to back. The front one under the point decides:
/// when it shows another workspace or is leaving the tab gets a window of its own (`None`) rather
/// than going to a window it hides. `from` is passed over, as the point is outside it.
pub fn window_at<'a>(spots: &[WindowSpot<'a>], at: ScreenPoint, from: &str) -> Option<&'a str> {
    let spot = spots.iter().filter(|s| s.label != from).find(|s| {
        let f = s.frame;
        at.x >= f.x && at.x < f.x + f.width && at.y >= f.y && at.y < f.y + f.height
    })?;
    (spot.same_workspace && !spot.leaving).then_some(spot.label)
}

/// Where a window for a tab let go at `at` goes: its top-left corner at the point, at the size of
/// the window `source` the tab came from. The caller still fits it onto a monitor (`place`).
pub fn frame_at(at: ScreenPoint, source: WindowFrame) -> WindowFrame {
    WindowFrame {
        x: at.x,
        y: at.y,
        ..source
    }
}

/// The point the page sent (`PointerEvent.screenX/screenY`) in the logical space `frame_of` and
/// `monitor_rects` report, which `window_at`, `frame_at` and `to_window_point` all take it in.
///
/// Assumed until the real app is checked (the free splits plan, Task 1): the page's screen
/// coordinates are that space already — the main monitor's top-left at 0,0, y down, another
/// monitor's negative where it sits left or above. When the check finds otherwise, only this
/// function changes.
pub fn screen_point(at: ScreenPoint) -> ScreenPoint {
    at
}

/// `at` (`screen_point`) in the window at `frame`, from its top-left corner. The window's content
/// covers its title bar (`frame_of`), so this is where the point is in its page too.
pub fn to_window_point(at: ScreenPoint, frame: WindowFrame) -> (f64, f64) {
    (at.x - frame.x, at.y - frame.y)
}

/// The window of `from`'s workspace a tab let go at `at` lands on, with its frame (`window_at`). A
/// window hidden or minimized is not on the screen there.
pub fn drop_target(app: &AppHandle, from: &str, at: ScreenPoint) -> Option<(String, WindowFrame)> {
    let shown: Vec<(DropCandidate, WindowFrame)> = app
        .state::<AppCore>()
        .drop_candidates(from)
        .into_iter()
        .filter_map(|candidate| {
            let window = app.get_webview_window(&candidate.label)?;
            let on_screen =
                window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true);
            let frame = frame_of(&window).filter(|_| on_screen)?;
            Some((candidate, frame))
        })
        .collect();
    let spots: Vec<WindowSpot> = shown
        .iter()
        .map(|(candidate, frame)| WindowSpot {
            label: &candidate.label,
            frame: *frame,
            same_workspace: candidate.same_workspace,
            leaving: candidate.leaving,
        })
        .collect();
    let label = window_at(&spots, at, from)?;
    shown
        .iter()
        .find(|(candidate, _)| candidate.label == label)
        .map(|(candidate, frame)| (candidate.label.clone(), *frame))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(x: f64, y: f64, width: f64, height: f64) -> WindowFrame {
        WindowFrame {
            x,
            y,
            width,
            height,
        }
    }

    /// Monitors whose work area is the whole screen.
    fn flat(rects: &[Rect]) -> Vec<MonitorRect> {
        rects
            .iter()
            .map(|&r| MonitorRect { full: r, work: r })
            .collect()
    }

    /// Two monitors as macOS reports them: a Dock on the left of the main one, menu bars on both.
    fn m() -> [MonitorRect; 2] {
        [
            MonitorRect {
                full: (0.0, 0.0, 3840.0, 1600.0),
                work: (61.0, 33.0, 3779.0, 1567.0),
            },
            MonitorRect {
                full: (3840.0, -734.0, 1440.0, 2560.0),
                work: (3840.0, -701.0, 1440.0, 2527.0),
            },
        ]
    }

    fn stepped(source: WindowFrame, monitors: &[MonitorRect]) -> Option<WindowFrame> {
        place(cascade(source, monitors), monitors)
    }

    #[test]
    fn a_new_window_at_the_corner_steps_back_up_and_left() {
        assert_eq!(
            stepped(at(4180.0, 1066.0, 1100.0, 760.0), &m()),
            Some(at(4156.0, 1042.0, 1100.0, 760.0))
        );
    }

    #[test]
    fn a_new_window_in_the_open_steps_down_and_right() {
        assert_eq!(
            stepped(at(500.0, 300.0, 1100.0, 760.0), &m()),
            Some(at(524.0, 324.0, 1100.0, 760.0))
        );
    }

    #[test]
    fn a_new_window_at_the_right_edge_only_steps_left() {
        assert_eq!(
            stepped(at(2740.0, 300.0, 1100.0, 760.0), &m()),
            Some(at(2716.0, 324.0, 1100.0, 760.0))
        );
    }

    #[test]
    fn a_new_window_at_the_bottom_edge_only_steps_up() {
        assert_eq!(
            stepped(at(500.0, 830.0, 1100.0, 760.0), &m()),
            Some(at(524.0, 806.0, 1100.0, 760.0))
        );
    }

    #[test]
    fn a_new_window_on_no_monitor_steps_down_and_right() {
        let source = at(6000.0, 100.0, 1100.0, 760.0);
        assert_eq!(cascade(source, &m()), at(6024.0, 124.0, 1100.0, 760.0));
    }

    #[test]
    fn a_restored_frame_clears_the_menu_bar_and_the_dock() {
        assert_eq!(
            place(at(20.0, 10.0, 900.0, 600.0), &m()),
            Some(at(61.0, 33.0, 900.0, 600.0))
        );
    }

    #[test]
    fn a_frame_whose_probe_is_on_the_dock_stays_on_its_monitor() {
        assert_eq!(
            place(at(0.0, 100.0, 900.0, 600.0), &m()),
            Some(at(61.0, 100.0, 900.0, 600.0))
        );
    }

    #[test]
    fn a_window_taller_than_the_work_area_shrinks_to_it() {
        let placed = place(at(100.0, 100.0, 900.0, 1600.0), &m()).unwrap();
        assert_eq!((placed.y, placed.height), (33.0, 1567.0));
    }

    #[test]
    fn a_nan_frame_is_dropped() {
        assert_eq!(place(at(f64::NAN, 100.0, 900.0, 600.0), &m()), None);
    }

    #[test]
    fn a_zero_sized_frame_is_kept_in_place() {
        // The window's minimum size (480×320) keeps a zero-sized frame from ever being shown.
        assert_eq!(
            place(at(100.0, 100.0, 0.0, 0.0), &m()),
            Some(at(100.0, 100.0, 0.0, 0.0))
        );
    }

    const OLD: [Rect; 3] = [
        (0.0, 0.0, 3840.0, 1600.0),
        (3840.0, -734.0, 1440.0, 2560.0),
        (0.0, 1600.0, 2560.0, 1440.0),
    ];

    #[test]
    fn a_saved_frame_half_off_its_monitor_moves_in() {
        assert_eq!(
            place(at(5000.0, 100.0, 900.0, 700.0), &flat(&OLD)),
            Some(at(4380.0, 100.0, 900.0, 700.0))
        );
    }

    #[test]
    fn a_window_larger_than_its_monitor_shrinks_to_fit() {
        assert_eq!(
            place(at(3840.0, -734.0, 2000.0, 3000.0), &flat(&OLD)),
            Some(at(3840.0, -734.0, 1440.0, 2560.0))
        );
    }

    #[test]
    fn a_frame_on_no_monitor_is_dropped() {
        let frame = at(6000.0, 100.0, 900.0, 700.0);
        assert_eq!(place(frame, &flat(&OLD)), None);
        assert_eq!(place(frame, &[]), None);
    }

    #[test]
    fn a_saved_frame_is_reused_only_on_a_present_monitor() {
        let monitors = flat(&[(0.0, 0.0, 1512.0, 982.0), (-1920.0, 0.0, 1920.0, 1080.0)]);
        let frame = |x: f64, y: f64| at(x, y, 900.0, 700.0);
        assert!(place(frame(100.0, 50.0), &monitors).is_some());
        assert!(place(frame(-1800.0, 100.0), &monitors).is_some());
        assert!(place(frame(4000.0, 100.0), &monitors).is_none());
        assert!(place(frame(100.0, 50.0), &[]).is_none());
    }

    #[test]
    fn a_frame_poking_into_a_neighbour_on_the_left_or_top_is_pulled_back() {
        let monitors = flat(&OLD);
        assert_eq!(
            place(at(3810.0, 100.0, 900.0, 700.0), &monitors),
            Some(at(3840.0, 100.0, 900.0, 700.0))
        );
        let y = place(at(100.0, -5.0, 900.0, 600.0), &monitors).unwrap().y;
        assert_eq!(y, 0.0);
    }

    #[test]
    fn a_frame_inside_a_monitor_is_kept() {
        let frame = at(100.0, 100.0, 900.0, 600.0);
        assert_eq!(place(frame, &flat(&OLD)), Some(frame));
    }

    fn point(x: f64, y: f64) -> ScreenPoint {
        ScreenPoint { x, y }
    }

    fn spot(label: &str, frame: WindowFrame) -> WindowSpot<'_> {
        WindowSpot {
            label,
            frame,
            same_workspace: true,
            leaving: false,
        }
    }

    #[test]
    fn window_at_picks_the_most_recent_window_under_the_point() {
        let spots = [
            spot("ws-3", at(400.0, 300.0, 900.0, 600.0)),
            spot("ws-2", at(100.0, 100.0, 900.0, 600.0)),
        ];
        assert_eq!(window_at(&spots, point(500.0, 400.0), "ws-1"), Some("ws-3"));
        assert_eq!(window_at(&spots, point(200.0, 200.0), "ws-1"), Some("ws-2"));
        assert_eq!(window_at(&spots, point(1400.0, 1000.0), "ws-1"), None);
    }

    #[test]
    fn window_at_finds_a_window_on_the_monitor_to_the_left() {
        let spots = [spot("ws-2", at(-2000.0, 200.0, 900.0, 600.0))];
        assert_eq!(
            window_at(&spots, point(-1500.0, 500.0), "ws-1"),
            Some("ws-2")
        );
        assert_eq!(window_at(&spots, point(-500.0, 500.0), "ws-1"), None);
    }

    #[test]
    fn window_at_skips_leaving_and_other_workspace_windows() {
        let frame = at(100.0, 100.0, 900.0, 600.0);
        let spots = [
            WindowSpot {
                leaving: true,
                ..spot("ws-2", frame)
            },
            WindowSpot {
                same_workspace: false,
                ..spot("ws-3", frame)
            },
            spot("ws-1", frame),
        ];
        assert_eq!(window_at(&spots, point(500.0, 400.0), "ws-1"), None);
        // Each on its own as well.
        assert_eq!(window_at(&spots[1..], point(500.0, 400.0), "ws-1"), None);
        assert_eq!(window_at(&spots[..1], point(500.0, 400.0), "ws-1"), None);
    }

    #[test]
    fn window_at_sends_the_tab_away_from_a_window_hidden_behind_another_workspace() {
        let frame = at(100.0, 100.0, 900.0, 600.0);
        let spots = [
            WindowSpot {
                same_workspace: false,
                ..spot("ws-3", frame)
            },
            spot("ws-2", frame),
        ];
        assert_eq!(window_at(&spots, point(500.0, 400.0), "ws-1"), None);
    }

    #[test]
    fn window_at_looks_through_the_window_the_tab_comes_from() {
        let frame = at(100.0, 100.0, 900.0, 600.0);
        let spots = [spot("ws-1", frame), spot("ws-2", frame)];
        assert_eq!(window_at(&spots, point(500.0, 400.0), "ws-1"), Some("ws-2"));
    }

    #[test]
    fn frame_at_puts_the_top_left_at_the_point_with_the_source_size() {
        let source = at(100.0, 100.0, 900.0, 600.0);
        assert_eq!(
            frame_at(point(1200.0, 300.0), source),
            at(1200.0, 300.0, 900.0, 600.0)
        );
        assert_eq!(
            frame_at(point(-2000.0, 50.0), source),
            at(-2000.0, 50.0, 900.0, 600.0)
        );
    }

    #[test]
    fn a_new_window_dropped_near_the_far_corner_stays_on_its_monitor() {
        let monitors = flat(&[(0.0, 0.0, 2560.0, 1440.0), (-2560.0, 0.0, 2560.0, 1440.0)]);
        let source = at(100.0, 100.0, 900.0, 600.0);
        assert_eq!(
            place(frame_at(point(2400.0, 1300.0), source), &monitors),
            Some(at(1660.0, 840.0, 900.0, 600.0))
        );
        assert_eq!(
            place(frame_at(point(-1000.0, 1300.0), source), &monitors),
            Some(at(-1000.0, 840.0, 900.0, 600.0))
        );
    }

    #[test]
    fn a_screen_point_from_the_page_is_taken_as_frame_of_reports_it() {
        assert_eq!(screen_point(point(500.0, 400.0)), point(500.0, 400.0));
        assert_eq!(screen_point(point(-1500.0, 500.0)), point(-1500.0, 500.0));
    }

    #[test]
    fn a_drop_point_is_taken_from_the_window_top_left() {
        assert_eq!(
            to_window_point(point(500.0, 400.0), at(100.0, 150.0, 900.0, 600.0)),
            (400.0, 250.0)
        );
        assert_eq!(
            to_window_point(point(-1500.0, 500.0), at(-2000.0, 200.0, 900.0, 600.0)),
            (500.0, 300.0)
        );
    }
}
