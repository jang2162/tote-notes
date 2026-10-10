//! The menu bar. Edit uses the system items — in a WKWebView copy and paste only work through
//! them. Tab actions go to the frontend of the latest window as `tote://menu`.

use std::io;
use std::path::Path;

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow, Wry};
use tauri_plugin_dialog::DialogExt;

use super::flush::FlushGoal;
use super::{lifecycle, windows, AppCore};
use crate::cli::front::app_bundle;
use crate::cli::install::{install, Installed};

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
        .item(&item(app, "open-file", "파일 열기…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item(app, "save", "저장", Some("CmdOrCtrl+S"))?)
        .item(&item(app, "import", "워크스페이스로 가져오기", None)?)
        .item(&item(app, "rename", "이름 바꾸기…", None)?)
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
        .bring_all_to_front()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&tote, &file, &edit, &view, &window])
        .build()
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "quit" => lifecycle::begin(app, FlushGoal::Quit),
        "install-cli" => install_cli(app),
        "close-window" => {
            if let Some(window) = latest_window(app) {
                let _ = window.close();
            }
        }
        id => match latest_window(app) {
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

fn latest_window(app: &AppHandle) -> Option<WebviewWindow> {
    let label = app.state::<AppCore>().latest_window()?;
    app.get_webview_window(&label)
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
