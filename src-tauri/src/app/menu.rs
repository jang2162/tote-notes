//! The menu bar, and a tab's context menu. Edit uses the system items — in a WKWebView copy and
//! paste only work through them. Tab actions go to the frontend of the focused window as
//! `tote://menu`.

use std::io;
use std::path::Path;
use std::sync::{mpsc, Mutex};

use serde::Deserialize;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow, Wry};
use tauri_plugin_dialog::DialogExt;

use super::flush::FlushGoal;
use super::windows::{cascade, frame_of, monitor_rects, WindowPlan};
use super::{lifecycle, lock, windows, AppCore};

use crate::cli::front::app_bundle;
use crate::cli::install::{install, Installed};

/// What the ids of a tab's context menu items start with: their events answer `show_tab_menu`
/// and never act as the menu bar's items of the same name.
const TAB_MENU: &str = "tab-menu:";

fn item(
    app: &AppHandle,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<Wry>> {
    let builder = MenuItemBuilder::with_id(id, text);
    match accelerator {
        Some(accelerator) => builder.accelerator(accelerator),
        None => builder,
    }
    .build(app)
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let tote = SubmenuBuilder::new(app, "tote")
        .about(None)
        .separator()
        .item(&item(app, "settings", "설정…", Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&item(app, "install-cli", "셸 명령 설치…", None)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        // Not the system Quit item: that one terminates at once, without writing pending edits.
        .item(&item(app, "quit", "tote 종료", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let file = SubmenuBuilder::new(app, "파일")
        .item(&item(app, "new-memo", "새 메모", Some("CmdOrCtrl+N"))?)
        .item(&item(app, "new-window", "새 창", Some("Alt+CmdOrCtrl+N"))?)
        .item(&item(app, "open-file", "파일 열기…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item(app, "save", "저장", Some("CmdOrCtrl+S"))?)
        .item(&item(app, "import", "워크스페이스로 가져오기", None)?)
        .item(&item(app, "rename", "이름 바꾸기…", None)?)
        .separator()
        .item(&item(app, "versions", "이전 버전…", None)?)
        .item(&item(app, "reveal-backups", "백업 폴더 열기", None)?)
        .separator()
        .item(&item(app, "close-tab", "탭 닫기", Some("CmdOrCtrl+W"))?)
        .item(&item(
            app,
            "close-window",
            "창 닫기",
            Some("CmdOrCtrl+Shift+W"),
        )?)
        .separator()
        .item(&item(
            app,
            "open-workspace",
            "워크스페이스 열기…",
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .item(&item(
            app,
            "new-workspace",
            "새 워크스페이스…",
            Some("CmdOrCtrl+Shift+N"),
        )?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "편집")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "보기")
        .item(&item(
            app,
            "search-workspace",
            "워크스페이스 검색",
            Some("CmdOrCtrl+Shift+F"),
        )?)
        .separator()
        .item(&item(
            app,
            "split-pane",
            "오른쪽으로 나누기",
            Some("CmdOrCtrl+\\"),
        )?)
        .item(&item(
            app,
            "split-pane-down",
            "아래로 나누기",
            Some("CmdOrCtrl+Shift+\\"),
        )?)
        .item(&item(
            app,
            "focus-pane-left",
            "왼쪽 칸으로",
            Some("Alt+CmdOrCtrl+Left"),
        )?)
        .item(&item(
            app,
            "focus-pane-right",
            "오른쪽 칸으로",
            Some("Alt+CmdOrCtrl+Right"),
        )?)
        .item(&item(
            app,
            "focus-pane-up",
            "위쪽 칸으로",
            Some("Alt+CmdOrCtrl+Up"),
        )?)
        .item(&item(
            app,
            "focus-pane-down",
            "아래쪽 칸으로",
            Some("Alt+CmdOrCtrl+Down"),
        )?)
        .separator()
        .item(&item(
            app,
            "next-tab",
            "다음 탭",
            Some("CmdOrCtrl+Shift+]"),
        )?)
        .item(&item(
            app,
            "prev-tab",
            "이전 탭",
            Some("CmdOrCtrl+Shift+["),
        )?)
        .separator()
        .item(&item(
            app,
            "toggle-preview",
            "미리보기 전환",
            Some("CmdOrCtrl+Shift+V"),
        )?)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "윈도우")
        .minimize()
        .maximize()
        .separator()
        .item(&item(
            app,
            "move-tab-to-new-window",
            "탭을 새 창으로 옮기기",
            None,
        )?)
        .separator()
        .bring_all_to_front()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&tote, &file, &edit, &view, &window])
        .build()
}

/// Where a menu event goes.
#[derive(Debug, PartialEq)]
enum Route<'a> {
    /// An item of a tab's context menu, by the id `show_tab_menu` was given.
    TabMenu(&'a str),
    /// An item of the menu bar.
    App(&'a str),
}

fn route(id: &str) -> Route<'_> {
    match id.strip_prefix(TAB_MENU) {
        Some(item) => Route::TabMenu(item),
        None => Route::App(id),
    }
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let id = match route(event.id().as_ref()) {
        Route::TabMenu(item) => return app.state::<TabMenu>().record(item),
        Route::App(id) => id,
    };
    match id {
        "quit" => lifecycle::begin(app, FlushGoal::Quit),
        "install-cli" => install_cli(app),
        "new-window" => new_window(app),
        "close-window" => {
            if let Some(window) = target_window(app) {
                let _ = window.close();
            }
        }
        id => match target_window(app) {
            Some(window) => {
                let _ = app.emit_to(
                    EventTarget::webview_window(window.label()),
                    "tote://menu",
                    id,
                );
            }
            // No window to act in: open one rather than drop the action silently.
            None => windows::open_latest(app),
        },
    }
}

/// ⌥⌘N: another window on the workspace of the window it is pressed in, empty, a little off it.
fn new_window(app: &AppHandle) {
    let Some(window) = target_window(app) else {
        return windows::open_latest(app);
    };
    let Some(path) = app.state::<AppCore>().path_of(window.label()) else {
        return;
    };
    let near = frame_of(&window).map(|f| cascade(f, &monitor_rects(app)));
    if let Err(err) = windows::open_window(app, &path, WindowPlan::Fresh { near }) {
        eprintln!("tote: {}: {}", path.display(), err.message);
    }
}

/// An item of a tab's context menu (`show_tab_menu`).
#[derive(Debug, Deserialize)]
pub struct TabMenuItem {
    pub id: String,
    pub text: String,
}

/// The item picked in the tab menu on show. One at a time: macOS shows one context menu at once.
#[derive(Default)]
pub struct TabMenu {
    pick: Mutex<Option<String>>,
}

impl TabMenu {
    /// A menu is about to show: nothing is picked in it yet, whatever an earlier one left.
    fn begin(&self) {
        *lock(&self.pick) = None;
    }

    fn record(&self, item: &str) {
        *lock(&self.pick) = Some(item.to_string());
    }

    fn take(&self) -> Option<String> {
        lock(&self.pick).take()
    }
}

/// Shows `items` as a context menu at the pointer in `window` and returns the id of the one
/// picked, `None` when the menu closed without a pick. Blocks until the menu closes: call it off
/// the main thread.
pub fn show_tab_menu(
    app: &AppHandle,
    window: &WebviewWindow,
    items: &[TabMenuItem],
) -> tauri::Result<Option<String>> {
    let picks = app.state::<TabMenu>();
    picks.begin();
    let mut menu = MenuBuilder::new(app);
    for each in items {
        menu = menu.item(&item(
            app,
            &format!("{TAB_MENU}{}", each.id),
            &each.text,
            None,
        )?);
    }
    // Returns once the menu has closed.
    window.popup_menu(&menu.build()?)?;
    // The pick's event was queued on the event loop while the menu was open, ahead of this task:
    // once the task has run, `on_event` has recorded it.
    let (done, ran) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = done.send(());
    })?;
    let _ = ran.recv();
    Ok(picks.take())
}

/// The window a menu item acts in: the focused one, else the one focused last — with every
/// window minimized none has focus, yet ⌘N still acts somewhere.
fn target_window(app: &AppHandle) -> Option<WebviewWindow> {
    let focused = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false));
    focused.or_else(|| {
        let label = app.state::<AppCore>().latest_window()?;
        app.get_webview_window(&label)
    })
}

fn install_cli(app: &AppHandle) {
    let message = match link_cli(app) {
        Ok(Installed::Preferred(at)) => {
            format!("{} 에 설치했습니다. 터미널에서 tote 를 쓸 수 있습니다.", at.display())
        }
        Ok(Installed::Fallback(at)) => format!(
            "{} 에 설치했습니다.\n셸의 PATH 에 이 폴더가 없다면 ~/.zshrc 에 다음 줄을 넣으세요.\nexport PATH=\"$HOME/.local/bin:$PATH\"",
            at.display()
        ),
        Err(err) => format!("설치하지 못했습니다: {err}"),
    };
    app.dialog()
        .message(message)
        .title("셸 명령 설치")
        .show(|_| {});
}

fn link_cli(app: &AppHandle) -> io::Result<Installed> {
    let exe = std::env::current_exe()?;
    if app_bundle(&exe).is_none() {
        return Err(io::Error::other(
            "앱 번들(tote.app)에서 실행할 때만 설치할 수 있습니다",
        ));
    }
    let script = app
        .path()
        .resource_dir()
        .map_err(io::Error::other)?
        .join("bin/tote");
    let home = dirs::home_dir().ok_or_else(|| io::Error::other("홈 폴더를 찾지 못했습니다"))?;
    install(
        &script,
        Path::new("/usr/local/bin"),
        &home.join(".local/bin"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tab_menu_item_does_not_reach_the_menu_bar_actions() {
        assert_eq!(
            route("tab-menu:move-tab-to-new-window"),
            Route::TabMenu("move-tab-to-new-window")
        );
        assert_eq!(
            route("move-tab-to-new-window"),
            Route::App("move-tab-to-new-window")
        );
    }

    #[test]
    fn a_tab_menu_closed_without_a_pick_answers_none() {
        let menu = TabMenu::default();
        menu.begin();
        assert_eq!(menu.take(), None);
        menu.begin();
        menu.record("move-tab-to-new-window");
        assert_eq!(menu.take(), Some("move-tab-to-new-window".to_string()));
        assert_eq!(menu.take(), None);
    }

    #[test]
    fn a_pick_left_over_does_not_answer_the_next_tab_menu() {
        let menu = TabMenu::default();
        // A pick that came after its menu's answer was taken.
        menu.record("move-tab-to-new-window");
        menu.begin();
        assert_eq!(menu.take(), None);
    }
}
