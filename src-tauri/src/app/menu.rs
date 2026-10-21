//! The menu bar, and a tab's context menu. Edit uses the system items — in a WKWebView copy and
//! paste only work through them. Tab actions go to the frontend of the focused window as
//! `tote://menu`.

use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::sync::{mpsc, Mutex, MutexGuard};
use std::thread::ThreadId;

use serde::Deserialize;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow, Wry};
use tauri_plugin_dialog::DialogExt;

use super::flush::FlushGoal;
use super::windows::{cascade, frame_of, monitor_rects, WindowPlan};
use super::{lifecycle, lock, windows, AppCore};

use crate::cli::front::app_bundle;
use crate::cli::install::{install, Installed};
use crate::shortcuts::{self, Command, COMMANDS, QUIT_ACCELERATOR, SETTINGS_ACCELERATOR};

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

/// An entry of a submenu.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Slot {
    /// An app command, by its id in `shortcuts::COMMANDS`: its name and shortcut come from there.
    Command(&'static str),
    /// An item with a name and a shortcut of its own that no setting changes: 설정…, tote 종료.
    Fixed {
        id: &'static str,
        text: &'static str,
        accelerator: &'static str,
    },
    Separator,
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
    BringAllToFront,
}

/// The id of 설정…, whose shortcut is fixed.
const SETTINGS: &str = "settings";

/// The id of tote 종료, whose shortcut is fixed.
const QUIT: &str = "quit";

const SETTINGS_ITEM: Slot = Slot::Fixed {
    id: SETTINGS,
    text: "설정…",
    accelerator: SETTINGS_ACCELERATOR,
};

const QUIT_ITEM: Slot = Slot::Fixed {
    id: QUIT,
    text: "tote 종료",
    accelerator: QUIT_ACCELERATOR,
};

/// The menu bar: each submenu's title and entries, the commands in `shortcuts::COMMANDS` order.
const MENUS: &[(&str, &[Slot])] = &[
    (
        "tote",
        &[
            Slot::About,
            Slot::Separator,
            SETTINGS_ITEM,
            Slot::Separator,
            Slot::Command("install-cli"),
            Slot::Separator,
            Slot::Services,
            Slot::Separator,
            Slot::Hide,
            Slot::HideOthers,
            Slot::ShowAll,
            Slot::Separator,
            // Not the system Quit item: that one terminates at once, without writing pending edits.
            QUIT_ITEM,
        ],
    ),
    (
        "파일",
        &[
            Slot::Command("new-memo"),
            Slot::Command("new-window"),
            Slot::Command("open-file"),
            Slot::Separator,
            Slot::Command("save"),
            Slot::Command("import"),
            Slot::Command("rename"),
            Slot::Separator,
            Slot::Command("versions"),
            Slot::Command("reveal-backups"),
            Slot::Separator,
            Slot::Command("close-tab"),
            Slot::Command("close-window"),
            Slot::Separator,
            Slot::Command("open-workspace"),
            Slot::Command("new-workspace"),
        ],
    ),
    (
        "편집",
        &[
            Slot::Undo,
            Slot::Redo,
            Slot::Separator,
            Slot::Cut,
            Slot::Copy,
            Slot::Paste,
            Slot::SelectAll,
        ],
    ),
    (
        "보기",
        &[
            Slot::Command("search-workspace"),
            Slot::Separator,
            Slot::Command("split-pane"),
            Slot::Command("split-pane-down"),
            Slot::Command("focus-pane-left"),
            Slot::Command("focus-pane-right"),
            Slot::Command("focus-pane-up"),
            Slot::Command("focus-pane-down"),
            Slot::Separator,
            Slot::Command("next-tab"),
            Slot::Command("prev-tab"),
            Slot::Separator,
            Slot::Command("toggle-preview"),
            Slot::Separator,
            Slot::Fullscreen,
        ],
    ),
    (
        "윈도우",
        &[
            Slot::Minimize,
            Slot::Maximize,
            Slot::Separator,
            Slot::Command("move-tab-to-new-window"),
            Slot::Separator,
            Slot::BringAllToFront,
        ],
    ),
];

/// The id of the item `slot` makes whose shortcut `MenuShortcuts` keeps: every command, and the
/// fixed items.
fn shortcut_item(slot: &Slot) -> Option<&'static str> {
    match slot {
        Slot::Command(id) => Some(id),
        Slot::Fixed { id, .. } => Some(id),
        _ => None,
    }
}

/// Every item whose shortcut `MenuShortcuts` keeps, in menu order.
#[cfg(test)]
fn shortcut_items() -> Vec<&'static str> {
    MENUS
        .iter()
        .flat_map(|(_, slots)| slots.iter().filter_map(shortcut_item))
        .collect()
}

/// The fixed items' ids and shortcuts, in menu order.
fn fixed_items() -> Vec<(&'static str, &'static str)> {
    MENUS
        .iter()
        .flat_map(|(_, slots)| slots.iter())
        .filter_map(|slot| match slot {
            Slot::Fixed {
                id, accelerator, ..
            } => Some((*id, *accelerator)),
            _ => None,
        })
        .collect()
}

/// The name of the item `slot` makes: a command's from `shortcuts::COMMANDS`, a fixed item's own.
fn shortcut_label(slot: &Slot) -> Option<&'static str> {
    match slot {
        Slot::Command(id) => Some(
            COMMANDS
                .iter()
                .find(|command| command.id == *id)
                .unwrap_or_else(|| panic!("MENUS names only commands of shortcuts::COMMANDS: {id}"))
                .label,
        ),
        Slot::Fixed { text, .. } => Some(text),
        _ => None,
    }
}

/// Builds the menu bar with the default shortcuts and manages its items as `MenuShortcuts`. The
/// settings are not loaded yet: setup applies the saved shortcuts (src/lib.rs).
pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let keys = accelerators_while(false, &shortcuts::effective(&BTreeMap::new()));
    let items = MENUS
        .iter()
        .flat_map(|(_, slots)| slots.iter())
        .filter_map(|slot| Some((shortcut_item(slot)?, shortcut_label(slot)?)))
        .map(|(id, label)| {
            let (_, keys) = keys
                .iter()
                .find(|(item, _)| *item == id)
                .expect("MENUS names only commands of shortcuts::COMMANDS, and the fixed items");
            Ok((id, item(app, id, label, keys.as_deref())?))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let mut bar = MenuBuilder::new(app);
    for (title, slots) in MENUS {
        let mut menu = SubmenuBuilder::new(app, *title);
        for slot in *slots {
            if let Some(id) = shortcut_item(slot) {
                let (_, made) = items.iter().find(|(item, _)| *item == id).unwrap();
                menu = menu.item(made);
                continue;
            }
            menu = match slot {
                Slot::Command(_) | Slot::Fixed { .. } => unreachable!("an item with a shortcut"),
                Slot::Separator => menu.separator(),
                Slot::About => menu.about(None),
                Slot::Services => menu.services(),
                Slot::Hide => menu.hide(),
                Slot::HideOthers => menu.hide_others(),
                Slot::ShowAll => menu.show_all(),
                Slot::Undo => menu.undo(),
                Slot::Redo => menu.redo(),
                Slot::Cut => menu.cut(),
                Slot::Copy => menu.copy(),
                Slot::Paste => menu.paste(),
                Slot::SelectAll => menu.select_all(),
                Slot::Fullscreen => menu.fullscreen(),
                Slot::Minimize => menu.minimize(),
                Slot::Maximize => menu.maximize(),
                Slot::BringAllToFront => menu.bring_all_to_front(),
            };
        }
        bar = bar.item(&menu.build()?);
    }
    app.manage(MenuShortcuts::new(items));
    bar.build()
}

/// Sets a menu item's shortcut: a `MenuItem`, or a recorder in the tests.
pub trait AcceleratorSlot {
    fn put(&self, accelerator: Option<&str>);
}

impl AcceleratorSlot for MenuItem<Wry> {
    fn put(&self, accelerator: Option<&str>) {
        if let Err(err) = self.set_accelerator(accelerator) {
            eprintln!("tote: menu item {}: {err}", self.id().0);
        }
    }
}

/// The menu items with a shortcut: every app command and the fixed items. Their shortcuts follow
/// the saved settings, and come off while a window records a shortcut so the keys reach the
/// recorder instead of running a command (spec 「녹음 중에 명령이 실행되지 않게」).
///
/// Use it on the main thread only, where `build` made it: in setup, a window or page-load event,
/// or a closure handed over with `change_shortcuts` (a command or another thread). It sets the
/// items while holding its lock, and an item's setter waits for the main thread: called from
/// elsewhere it would wait for the main thread while the main thread waits for the lock. Debug
/// builds check the thread.
pub(crate) struct MenuShortcuts<I = MenuItem<Wry>> {
    state: Mutex<ShortcutState<I>>,
    thread: ThreadId,
}

struct ShortcutState<I> {
    items: Vec<(&'static str, I)>,
    /// The commands' shortcuts as last applied, to put back on resume.
    table: Vec<(&'static Command, Option<String>)>,
    /// The window recording a shortcut, while the shortcuts are off.
    suspended_by: Option<String>,
}

impl<I: AcceleratorSlot> MenuShortcuts<I> {
    /// `items` as `build` made them, with the default shortcuts.
    pub(crate) fn new(items: Vec<(&'static str, I)>) -> Self {
        Self {
            state: Mutex::new(ShortcutState {
                items,
                table: shortcuts::effective(&BTreeMap::new()),
                suspended_by: None,
            }),
            thread: std::thread::current().id(),
        }
    }

    fn state(&self) -> MutexGuard<'_, ShortcutState<I>> {
        debug_assert_eq!(
            std::thread::current().id(),
            self.thread,
            "MenuShortcuts used off the main thread"
        );
        lock(&self.state)
    }

    /// The commands' shortcuts are now `effective`. While they are off only the table changes;
    /// they come back with it.
    pub(crate) fn apply(&self, effective: &[(&'static Command, Option<String>)]) {
        let mut state = self.state();
        state.table = effective.to_vec();
        if state.suspended_by.is_none() {
            state.put();
        }
    }

    /// Window `label` records a shortcut: every item's comes off.
    pub(crate) fn suspend(&self, label: &str) {
        let mut state = self.state();
        state.suspended_by = Some(label.to_string());
        state.put();
    }

    /// Puts the shortcuts back, whichever window took them off. For the tests and a way out: the
    /// app puts them back with `resume_if`, by the window that took them off.
    #[cfg_attr(not(test), allow(dead_code))] // Nothing in the app needs it yet.
    pub(crate) fn resume(&self) {
        let mut state = self.state();
        if state.suspended_by.take().is_some() {
            state.put();
        }
    }

    /// Puts the shortcuts back if window `label` took them off: another window losing focus or
    /// closing leaves the recording window's alone.
    pub(crate) fn resume_if(&self, label: &str) {
        let mut state = self.state();
        if state.suspended_by.as_deref() == Some(label) {
            state.suspended_by = None;
            state.put();
        }
    }
}

impl<I: AcceleratorSlot> ShortcutState<I> {
    fn put(&self) {
        for (id, keys) in accelerators_while(self.suspended_by.is_some(), &self.table) {
            if let Some((_, item)) = self.items.iter().find(|(item, _)| *item == id) {
                item.put(keys.as_deref());
            }
        }
    }
}

/// The shortcut each item gets: its command's in `effective`, and the fixed items' own; none at all
/// while suspended.
fn accelerators_while(
    suspended: bool,
    effective: &[(&'static Command, Option<String>)],
) -> Vec<(&'static str, Option<String>)> {
    effective
        .iter()
        .map(|(command, keys)| (command.id, keys.clone()))
        .chain(
            fixed_items()
                .into_iter()
                .map(|(id, accelerator)| (id, Some(accelerator.to_string()))),
        )
        .map(|(id, keys)| (id, keys.filter(|_| !suspended)))
        .collect()
}

/// Runs `change` on the main thread, where `MenuShortcuts` has to be used. On the main thread it
/// runs at once.
pub(crate) fn change_shortcuts(
    app: &AppHandle,
    change: impl FnOnce(&MenuShortcuts) + Send + 'static,
) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(shortcuts) = handle.try_state::<MenuShortcuts>() {
            change(&shortcuts);
        }
    });
}

/// Puts the saved shortcuts on the menu. Reads the settings when it runs on the main thread, so of
/// two saves close together the one that runs last puts the newest map.
pub(crate) fn follow_settings(app: &AppHandle) {
    let handle = app.clone();
    change_shortcuts(app, move |menu| {
        let saved = handle.state::<AppCore>().settings().shortcuts;
        menu.apply(&shortcuts::effective(&saved));
    });
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

    /// A menu item that keeps every shortcut it is given.
    #[derive(Default)]
    struct Recorder(Mutex<Vec<Option<String>>>);

    impl AcceleratorSlot for std::sync::Arc<Recorder> {
        fn put(&self, accelerator: Option<&str>) {
            lock(&self.0).push(accelerator.map(str::to_string));
        }
    }

    struct Menu {
        shortcuts: MenuShortcuts<std::sync::Arc<Recorder>>,
        items: Vec<(&'static str, std::sync::Arc<Recorder>)>,
    }

    impl Menu {
        fn new() -> Self {
            let items: Vec<_> = shortcut_items()
                .into_iter()
                .map(|id| (id, std::sync::Arc::new(Recorder::default())))
                .collect();
            let shortcuts = MenuShortcuts::new(items.clone());
            Self { shortcuts, items }
        }

        /// The shortcut item `id` has now: the last one it was given.
        fn shortcut(&self, id: &str) -> Option<String> {
            let (_, item) = self.items.iter().find(|(item, _)| *item == id).unwrap();
            lock(&item.0).last().cloned().flatten()
        }

        fn all(&self) -> Vec<Option<String>> {
            self.items.iter().map(|(id, _)| self.shortcut(id)).collect()
        }

        fn puts(&self) -> usize {
            self.items.iter().map(|(_, item)| lock(&item.0).len()).sum()
        }
    }

    fn saved(entries: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
        entries
            .iter()
            .map(|(id, keys)| (id.to_string(), keys.map(str::to_string)))
            .collect()
    }

    #[test]
    fn suspended_menus_carry_no_accelerators_and_resume_restores_them() {
        let table = shortcuts::effective(&BTreeMap::new());
        let on = accelerators_while(false, &table);
        assert_eq!(on.len(), COMMANDS.len() + 2);
        assert!(on.contains(&("new-memo", Some("CmdOrCtrl+N".into()))));
        assert!(on.contains(&("settings", Some("CmdOrCtrl+,".into()))));
        assert!(on.contains(&("quit", Some("CmdOrCtrl+Q".into()))));
        assert!(on.contains(&("rename", None)));
        let off = accelerators_while(true, &table);
        assert_eq!(off.len(), on.len());
        assert!(off.iter().all(|(_, keys)| keys.is_none()));

        let menu = Menu::new();
        menu.shortcuts.apply(&table);
        let before = menu.all();
        assert_eq!(menu.shortcut("new-memo"), Some("CmdOrCtrl+N".into()));
        assert_eq!(menu.shortcut("settings"), Some("CmdOrCtrl+,".into()));
        assert_eq!(menu.shortcut("quit"), Some("CmdOrCtrl+Q".into()));
        menu.shortcuts.suspend("ws-1");
        assert!(menu.all().iter().all(Option::is_none));
        menu.shortcuts.resume();
        assert_eq!(menu.all(), before);
        // By the window that took them off, as when it closes.
        menu.shortcuts.suspend("ws-1");
        menu.shortcuts.resume_if("ws-1");
        assert_eq!(menu.all(), before);
    }

    #[test]
    fn a_settings_change_while_suspended_takes_effect_on_resume() {
        let menu = Menu::new();
        menu.shortcuts
            .apply(&shortcuts::effective(&BTreeMap::new()));
        menu.shortcuts.suspend("ws-1");
        let puts = menu.puts();
        let changed = saved(&[("new-memo", Some("CmdOrCtrl+Shift+M")), ("rename", None)]);
        menu.shortcuts.apply(&shortcuts::effective(&changed));
        assert_eq!(menu.puts(), puts, "nothing is put back while suspended");
        assert!(menu.all().iter().all(Option::is_none));
        menu.shortcuts.resume_if("ws-1");
        assert_eq!(menu.shortcut("new-memo"), Some("CmdOrCtrl+Shift+M".into()));
        assert_eq!(menu.shortcut("rename"), None);
        assert_eq!(menu.shortcut("quit"), Some("CmdOrCtrl+Q".into()));
        assert_eq!(menu.shortcut("save"), Some("CmdOrCtrl+S".into()));
        assert_eq!(menu.shortcut("settings"), Some("CmdOrCtrl+,".into()));
    }

    #[test]
    fn only_the_window_that_suspended_can_resume_by_focus_or_close() {
        let menu = Menu::new();
        menu.shortcuts
            .apply(&shortcuts::effective(&BTreeMap::new()));
        let before = menu.all();
        // Not suspended: a window losing focus changes nothing.
        let puts = menu.puts();
        menu.shortcuts.resume_if("ws-2");
        menu.shortcuts.resume();
        assert_eq!(menu.puts(), puts);
        menu.shortcuts.suspend("ws-1");
        let puts = menu.puts();
        menu.shortcuts.resume_if("ws-2");
        assert_eq!(menu.puts(), puts);
        assert!(menu.all().iter().all(Option::is_none));
        menu.shortcuts.resume_if("ws-1");
        assert_eq!(menu.all(), before);
        // Another window starts recording: the first one's focus or close leaves it suspended.
        menu.shortcuts.suspend("ws-1");
        menu.shortcuts.suspend("ws-2");
        menu.shortcuts.resume_if("ws-1");
        assert!(menu.all().iter().all(Option::is_none));
        menu.shortcuts.resume_if("ws-2");
        assert_eq!(menu.all(), before);
    }

    #[test]
    fn the_table_lists_every_command_and_the_fixed_keys() {
        let in_menus: Vec<(&str, &str)> = MENUS
            .iter()
            .flat_map(|(title, slots)| {
                slots.iter().filter_map(move |slot| match slot {
                    Slot::Command(id) => Some((*id, *title)),
                    _ => None,
                })
            })
            .collect();
        let commands: Vec<(&str, &str)> = COMMANDS.iter().map(|c| (c.id, c.menu)).collect();
        assert_eq!(in_menus, commands);
        assert!(MENUS
            .iter()
            .any(|(_, slots)| slots.contains(&SETTINGS_ITEM)));

        let table = shortcuts::table(&saved(&[("rename", Some("CmdOrCtrl+K"))]));
        let ids: Vec<&str> = table.commands.iter().map(|row| row.id).collect();
        let command_ids: Vec<&str> = COMMANDS.iter().map(|c| c.id).collect();
        assert_eq!(ids, command_ids);
        let rename = table
            .commands
            .iter()
            .find(|row| row.id == "rename")
            .unwrap();
        assert_eq!(rename.label, "이름 바꾸기…");
        assert_eq!(rename.menu, "파일");
        assert_eq!(rename.default, None);
        assert_eq!(rename.current, Some("CmdOrCtrl+K".into()));
        let new_memo = table
            .commands
            .iter()
            .find(|row| row.id == "new-memo")
            .unwrap();
        assert_eq!(new_memo.default, Some("CmdOrCtrl+N"));
        assert_eq!(new_memo.current, Some("CmdOrCtrl+N".into()));
        let fixed: Vec<(&str, &str)> = table
            .fixed
            .iter()
            .map(|f| (f.name, f.accelerator))
            .collect();
        let expected: Vec<(&str, &str)> = shortcuts::FIXED
            .iter()
            .map(|f| (f.name, f.accelerator))
            .collect();
        assert_eq!(fixed, expected);
        let json = serde_json::to_value(&table).unwrap();
        assert_eq!(json["commands"][0]["default"], serde_json::Value::Null);
        assert_eq!(json["fixed"][0]["accelerator"], "CmdOrCtrl+,");
    }

    #[test]
    fn the_quit_menu_item_keeps_its_name_and_shortcut() {
        let quit = MENUS
            .iter()
            .flat_map(|(_, slots)| slots.iter())
            .find(|slot| shortcut_item(slot) == Some("quit"))
            .unwrap();
        assert_eq!(shortcut_label(quit), Some("tote 종료"));
        assert_eq!(
            fixed_items(),
            [("settings", "CmdOrCtrl+,"), ("quit", "CmdOrCtrl+Q")]
        );

        let menu = Menu::new();
        menu.shortcuts
            .apply(&shortcuts::effective(&BTreeMap::new()));
        assert_eq!(menu.shortcut("quit"), Some("CmdOrCtrl+Q".into()));
        menu.shortcuts.suspend("ws-1");
        assert_eq!(menu.shortcut("quit"), None);
        assert_eq!(menu.shortcut("settings"), None);
        menu.shortcuts.resume_if("ws-1");
        assert_eq!(menu.shortcut("quit"), Some("CmdOrCtrl+Q".into()));
        assert_eq!(menu.shortcut("settings"), Some("CmdOrCtrl+,".into()));
    }

    #[test]
    fn every_item_the_table_puts_a_shortcut_on_is_kept() {
        let mut kept = shortcut_items();
        assert!(kept.contains(&SETTINGS));
        assert!(kept.contains(&QUIT));
        let mut put: Vec<&str> = accelerators_while(false, &shortcuts::effective(&BTreeMap::new()))
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        kept.sort_unstable();
        put.sort_unstable();
        assert_eq!(kept, put);
    }

    #[test]
    #[cfg(debug_assertions)]
    fn the_shortcuts_are_used_on_the_thread_that_built_them_only() {
        let menu = std::sync::Arc::new(Menu::new());
        let elsewhere = std::sync::Arc::clone(&menu);
        let call = std::thread::spawn(move || elsewhere.shortcuts.suspend("ws-1")).join();
        assert!(call.is_err());
    }
}
