//! The menu bar icon (spec `docs/superpowers/specs/2026-11-14-tote-notes-global-quick-note-design.md`
//! 「메뉴 막대 아이콘」): there while 설정 › 일반 says so, with a menu of 빠른 메모, opening tote and
//! quitting.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use super::flush::FlushGoal;
use super::{lifecycle, quick_note, windows, AppCore};

const TRAY_ID: &str = "tote";

/// What the ids of the icon's menu start with. Its events come to the menu bar's handler
/// (`menu::on_event`), where 「종료」 must not be taken for the menu bar's `quit` or anything else.
const TRAY_MENU: &str = "tray:";

#[derive(Debug, PartialEq, Eq)]
pub enum Entry {
    Item {
        id: &'static str,
        text: &'static str,
    },
    Separator,
}

/// The icon's menu, top to bottom.
pub const ENTRIES: &[Entry] = &[
    Entry::Item {
        id: "tray:quick-note",
        text: "빠른 메모",
    },
    Entry::Item {
        id: "tray:open",
        text: "Tote Notes 열기",
    },
    Entry::Separator,
    Entry::Item {
        id: "tray:quit",
        text: "종료",
    },
];

/// The item of the icon's menu that menu event `id` is, without its prefix; `None` for any other.
pub fn item_of(id: &str) -> Option<&str> {
    id.strip_prefix(TRAY_MENU)
}

pub fn on_menu(app: &AppHandle, item: &str) {
    match item {
        "quick-note" => quick_note::run(app),
        "open" => open(app),
        // The menu bar's Tote Notes 종료: pending edits are written first.
        "quit" => lifecycle::begin(app, FlushGoal::Quit),
        _ => {}
    }
}

/// The window focused last comes to the front; with none, the workspace used last opens, as a
/// click on the Dock icon does.
fn open(app: &AppHandle) {
    match app.state::<AppCore>().latest_window() {
        Some(label) => windows::focus(app, &label),
        None => windows::open_latest(app),
    }
}

/// Puts the icon in the menu bar or takes it out, as the settings say. On the main thread, in turn:
/// two settings changes at once would otherwise both find no icon and put up two.
pub fn follow_settings(app: &AppHandle) {
    quick_note::on_main_thread(app, show_or_hide);
}

fn show_or_hide(app: &AppHandle) {
    let visible = app.state::<AppCore>().settings().tray.visible;
    let shown = app.tray_by_id(TRAY_ID).is_some();
    if visible && !shown {
        if let Err(err) = build(app) {
            eprintln!("tote: cannot put the icon in the menu bar: {err}");
        }
    } else if !visible && shown {
        let _ = app.remove_tray_by_id(TRAY_ID);
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for entry in ENTRIES {
        match entry {
            Entry::Item { id, text } => items.push(Box::new(MenuItem::with_id(
                app,
                *id,
                *text,
                true,
                None::<&str>,
            )?)),
            Entry::Separator => items.push(Box::new(PredefinedMenuItem::separator(app)?)),
        }
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(Box::as_ref).collect();
    let menu = Menu::with_items(app, &refs)?;
    // Black on clear, drawn by macOS in the menu bar's own colour, light or dark. Made from
    // icons/icon.png as the spec's 「메뉴 막대 아이콘」 says.
    let icon: Image<'static> = tauri::include_image!("icons/tray-template.png");
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Tote Notes")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_is_quick_note_open_a_line_and_quit() {
        assert_eq!(
            ENTRIES,
            &[
                Entry::Item {
                    id: "tray:quick-note",
                    text: "빠른 메모"
                },
                Entry::Item {
                    id: "tray:open",
                    text: "Tote Notes 열기"
                },
                Entry::Separator,
                Entry::Item {
                    id: "tray:quit",
                    text: "종료"
                },
            ]
        );
    }

    #[test]
    fn only_the_icons_items_are_routed_to_it() {
        for entry in ENTRIES {
            if let Entry::Item { id, .. } = entry {
                assert!(item_of(id).is_some(), "{id}");
            }
        }
        assert_eq!(item_of("tray:quit"), Some("quit"));
        // The menu bar's own and a pop-up menu's.
        for id in ["quit", "new-memo", "popup-menu:tray:quit", "settings"] {
            assert_eq!(item_of(id), None, "{id}");
        }
    }

    #[test]
    fn the_icon_is_a_template_size_image() {
        let icon: Image<'static> = tauri::include_image!("icons/tray-template.png");
        assert_eq!((icon.width(), icon.height()), (36, 36));
        // Black wherever drawn: macOS uses the alpha alone.
        assert!(icon.rgba().chunks(4).all(|px| px[..3] == [0, 0, 0]));
        assert!(icon.rgba().chunks(4).any(|px| px[3] == 255));
    }
}
