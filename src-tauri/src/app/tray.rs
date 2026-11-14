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

/// What the icon's menu does, apart from the app: the tests stand in a recording one.
pub trait Actions {
    fn quick_note(&self);
    fn open(&self);
    /// A round that writes every window first (`lifecycle::begin`).
    fn begin(&self, goal: FlushGoal);
}

pub fn on_menu(app: &AppHandle, item: &str) {
    act(item, &App(app));
}

/// 「종료」 is the menu bar's Tote Notes 종료: pending edits are written first. Quitting outright
/// (`AppHandle::exit`) would lose them.
fn act(item: &str, actions: &impl Actions) {
    match item {
        "quick-note" => actions.quick_note(),
        "open" => actions.open(),
        "quit" => actions.begin(FlushGoal::Quit),
        _ => {}
    }
}

struct App<'a>(&'a AppHandle);

impl Actions for App<'_> {
    fn quick_note(&self) {
        quick_note::run(self.0);
    }

    fn open(&self) {
        open(self.0);
    }

    fn begin(&self, goal: FlushGoal) {
        lifecycle::begin(self.0, goal);
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
    quick_note::on_main_thread(app, |app| {
        show_or_hide(
            app.state::<AppCore>().settings().tray.visible,
            &MenuBar(app),
        );
    });
}

/// The icon in the menu bar, apart from the app: the tests stand in a recording one.
pub trait Icon {
    fn shown(&self) -> bool;
    fn show(&self) -> Result<(), String>;
    fn hide(&self);
}

fn show_or_hide(visible: bool, icon: &impl Icon) {
    let shown = icon.shown();
    if visible && !shown {
        if let Err(err) = icon.show() {
            eprintln!("tote: cannot put the icon in the menu bar: {err}");
        }
    } else if !visible && shown {
        icon.hide();
    }
}

struct MenuBar<'a>(&'a AppHandle);

impl Icon for MenuBar<'_> {
    fn shown(&self) -> bool {
        self.0.tray_by_id(TRAY_ID).is_some()
    }

    fn show(&self) -> Result<(), String> {
        build(self.0).map_err(|e| e.to_string())
    }

    fn hide(&self) {
        // Dropped here, the last handle to it: the icon leaves the menu bar.
        let _ = self.0.remove_tray_by_id(TRAY_ID);
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

    #[derive(Default)]
    struct Recorded(std::cell::RefCell<Vec<String>>, std::cell::Cell<bool>);

    impl Recorded {
        fn calls(&self) -> Vec<String> {
            self.0.borrow().clone()
        }
    }

    impl Actions for Recorded {
        fn quick_note(&self) {
            self.0.borrow_mut().push("quick-note".into());
        }
        fn open(&self) {
            self.0.borrow_mut().push("open".into());
        }
        fn begin(&self, goal: FlushGoal) {
            self.0.borrow_mut().push(format!("begin {goal:?}"));
        }
    }

    impl Icon for Recorded {
        fn shown(&self) -> bool {
            self.1.get()
        }
        fn show(&self) -> Result<(), String> {
            self.1.set(true);
            self.0.borrow_mut().push("show".into());
            Ok(())
        }
        fn hide(&self) {
            self.1.set(false);
            self.0.borrow_mut().push("hide".into());
        }
    }

    /// 「종료」 writes what is pending first, as the menu bar's Tote Notes 종료 does.
    #[test]
    fn quit_writes_every_window_first() {
        let actions = Recorded::default();
        act("quit", &actions);
        assert_eq!(actions.calls(), ["begin Quit"]);
    }

    #[test]
    fn each_item_does_its_own() {
        for (item, call) in [("quick-note", "quick-note"), ("open", "open")] {
            let actions = Recorded::default();
            act(item, &actions);
            assert_eq!(actions.calls(), [call], "{item}");
        }
        let actions = Recorded::default();
        act("nope", &actions);
        assert!(actions.calls().is_empty());
    }

    #[test]
    fn the_icon_comes_and_goes_with_the_setting() {
        let icon = Recorded::default();
        show_or_hide(false, &icon);
        assert!(icon.calls().is_empty());
        show_or_hide(true, &icon);
        show_or_hide(true, &icon);
        assert_eq!(icon.calls(), ["show"]);
        show_or_hide(false, &icon);
        assert_eq!(icon.calls(), ["show", "hide"]);
        assert!(!icon.shown());
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
