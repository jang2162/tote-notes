//! 빠른 메모: a new memo from anywhere, by a global shortcut or the menu bar icon (spec
//! `docs/superpowers/specs/2026-11-14-tote-notes-global-quick-note-design.md` 「빠른 메모」), and the
//! global shortcuts registered with macOS for it.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{mpsc, Mutex};

use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use super::{lock, windows, AppCore, PendingOpen};
use crate::global_shortcuts::{self, GlobalShortcutTable};

/// The window 빠른 메모 makes the memo in.
#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    /// The one focused last, which comes to the front.
    Window(String),
    /// No window is open: the most recently used workspace opens (`windows::open_latest`), as for a
    /// click on the Dock icon.
    OpenLatest,
    /// Every window is leaving (a round to close or switch it is open), or tote quits or restarts:
    /// a memo made there would be left behind as an empty file once the window goes.
    Nothing,
}

/// The window focused last that is staying (`AppCore::windows_by_focus`). A leaving one would take
/// the memo only to go — the page makes the file before the tab, and only closing the tab deletes
/// an empty one — so the next window does; with none staying, nothing does.
pub fn target(core: &AppCore) -> Target {
    let Some(windows) = core.windows_by_focus() else {
        return Target::Nothing;
    };
    if windows.is_empty() {
        return Target::OpenLatest;
    }
    windows
        .into_iter()
        .find(|(_, leaving)| !leaving)
        .map_or(Target::Nothing, |(label, _)| Target::Window(label))
}

/// Window `label` makes the memo as ⌘N would, once its page takes what is left for it: a window
/// just opened is not listening yet, so `tote://menu` would be lost there.
pub fn leave_new_memo(core: &AppCore, label: &str) {
    core.push_pending(label, PendingOpen::NewMemo);
}

pub fn run(app: &AppHandle) {
    let core = app.state::<AppCore>();
    let label = match target(&core) {
        Target::Window(label) => {
            windows::focus(app, &label);
            label
        }
        Target::OpenLatest => {
            windows::open_latest(app);
            let Some(label) = core.latest_window() else {
                return;
            };
            label
        }
        Target::Nothing => return,
    };
    leave_new_memo(&core, &label);
    let _ = app.emit_to(EventTarget::webview_window(&label), "tote://pending", ());
}

/// The global shortcuts as registered with macOS: the keys asked for last, the commands whose keys
/// it refused, and the window recording a shortcut meanwhile.
#[derive(Default)]
pub struct GlobalKeys(Mutex<Registered>);

impl GlobalKeys {
    pub fn table(&self, core: &AppCore) -> GlobalShortcutTable {
        let settings = core.settings();
        let failed = lock(&self.0).failed.clone();
        global_shortcuts::table(&settings.global_shortcuts, &settings.shortcuts, &failed)
    }
}

/// What registers keys with macOS: the plugin in the app (`Plugin`), a recording stand-in in the
/// tests.
pub trait Registrar {
    fn unregister_all(&mut self) -> Result<(), String>;
    fn register(&mut self, keys: &str) -> Result<(), String>;
}

#[derive(Default)]
struct Registered {
    /// Command id → keys, as the settings asked for them last.
    wanted: BTreeMap<String, String>,
    failed: BTreeSet<String>,
    /// The window whose settings screen records a shortcut. Meanwhile no global key is registered:
    /// macOS would hand the key to the hot key before the page, and the recorder would never see
    /// it — nor say that it is the global one's.
    suspended_by: Option<String>,
}

impl Registered {
    /// The settings ask for `wanted`: registered anew unless they asked for it last (a refused key
    /// is tried again only once it changes) or a window is recording.
    fn follow(&mut self, wanted: BTreeMap<String, String>, registrar: &mut impl Registrar) {
        if self.wanted == wanted {
            return;
        }
        self.wanted = wanted;
        if self.suspended_by.is_none() {
            self.register_all(registrar);
        }
    }

    /// Lets go of every key first: a key changed or cleared must stop taking the keys from other
    /// apps.
    fn register_all(&mut self, registrar: &mut impl Registrar) {
        if let Err(err) = registrar.unregister_all() {
            eprintln!("tote: cannot let go of the global shortcuts: {err}");
        }
        let mut failed = BTreeSet::new();
        for (id, keys) in &self.wanted {
            if let Err(err) = registrar.register(keys) {
                eprintln!("tote: global shortcut {keys} for {id}: {err}");
                failed.insert(id.clone());
            }
        }
        self.failed = failed;
    }

    fn suspend(&mut self, label: &str, registrar: &mut impl Registrar) {
        if self.suspended_by.is_none() {
            if let Err(err) = registrar.unregister_all() {
                eprintln!("tote: cannot let go of the global shortcuts: {err}");
            }
        }
        self.suspended_by = Some(label.to_string());
    }

    /// Window `label` is done recording, or went: the keys are registered again. One another app
    /// took meanwhile is refused, which the settings screen says once it reads the table again.
    fn resume_if(&mut self, label: &str, registrar: &mut impl Registrar) {
        if self.suspended_by.as_deref() == Some(label) {
            self.suspended_by = None;
            self.register_all(registrar);
        }
    }
}

/// The plugin as the `Registrar`.
struct Plugin<'a>(&'a tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>);

impl Registrar for Plugin<'_> {
    fn unregister_all(&mut self) -> Result<(), String> {
        self.0.unregister_all().map_err(|e| e.to_string())
    }

    fn register(&mut self, keys: &str) -> Result<(), String> {
        let shortcut =
            global_shortcuts::hotkey(keys).ok_or_else(|| format!("unreadable keys {keys}"))?;
        self.0.register(shortcut).map_err(|e| e.to_string())
    }
}

/// The plugin, whose every registered shortcut is 빠른 메모's: the handler need not look up which
/// command a key is for. One that did would take `GlobalKeys`' lock on the main thread, which
/// `register` waits on while `follow_settings` holds it.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                run(app);
            }
        })
        .build()
}

/// Registers the global shortcuts the settings ask for (`Registered::follow`). On the main thread,
/// in turn, and waited for: the settings screen reads the table once `tote://config` comes, which
/// must say whether macOS took the new key.
pub fn follow_settings(app: &AppHandle) {
    on_main_thread(app, |app| {
        let settings = app.state::<AppCore>().settings();
        let wanted = global_shortcuts::effective(&settings.global_shortcuts, &settings.shortcuts)
            .into_iter()
            .filter_map(|(command, keys)| Some((command.id.to_string(), keys?)))
            .collect();
        with_registered(app, |registered, registrar| {
            registered.follow(wanted, registrar)
        });
    });
}

/// The settings screen of window `label` records a shortcut (`on`) or is done, as the menu's
/// shortcuts come off and back (`suspend_shortcuts`).
pub fn suspend(app: &AppHandle, label: &str, on: bool) {
    let label = label.to_string();
    on_main_thread(app, move |app| {
        with_registered(app, |registered, registrar| {
            if on {
                registered.suspend(&label, registrar);
            } else {
                registered.resume_if(&label, registrar);
            }
        });
    });
}

/// Window `label` lost the focus, went, or loads a page: a recording of its ends.
pub fn resume_if(app: &AppHandle, label: &str) {
    suspend(app, label, false);
}

fn with_registered(app: &AppHandle, change: impl FnOnce(&mut Registered, &mut Plugin<'_>)) {
    let Some(keys) = app.try_state::<GlobalKeys>() else {
        return;
    };
    let manager = app.global_shortcut();
    change(&mut lock(&keys.0), &mut Plugin(&manager));
}

/// Runs `job` on the main thread and waits for it; at once when this is the main thread. Jobs run
/// one after another, so two settings changes at once cannot interleave their registrations.
pub(super) fn on_main_thread(app: &AppHandle, job: impl FnOnce(&AppHandle) + Send + 'static) {
    let (done, finished) = mpsc::channel();
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            job(&handle);
            let _ = done.send(());
        })
        .is_ok()
    {
        let _ = finished.recv();
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::app::flush::FlushGoal;
    use crate::appdata::{AppPaths, LaunchState, Machine, Settings};
    use crate::workspace::Workspace;

    fn core(dir: &Path) -> AppCore {
        let paths = AppPaths::from_parts(Some(dir.join("data")), None, None, false).unwrap();
        let machine = Machine {
            version: 1,
            device_id: "device".into(),
            device_name: "맥".into(),
        };
        AppCore::new(
            paths,
            machine,
            Settings::default(),
            LaunchState::default(),
            dir.join("bundled"),
        )
    }

    fn open(core: &AppCore, name: &str) -> String {
        let workspace = Workspace::create(&core.workspace_root(), name).unwrap();
        let label = core.next_label();
        let path = workspace.root().to_path_buf();
        assert!(core.register_window(&label, &path, Some(workspace), None));
        core.opened(&label);
        label
    }

    #[test]
    fn it_goes_to_the_window_focused_last() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        assert_eq!(target(&core), Target::Window(b.clone()));
        core.focused(&a);
        assert_eq!(target(&core), Target::Window(a.clone()));
        core.focused(&b);
        assert_eq!(target(&core), Target::Window(b));
    }

    #[test]
    fn with_no_window_it_opens_the_workspace_used_last() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        core.focused(&a);
        let used_last = core.path_of(&a).unwrap();
        core.closed(&a);
        core.closed(&b);
        assert_eq!(target(&core), Target::OpenLatest);
        // What `windows::open_latest` opens.
        assert_eq!(core.fallback_workspace(), Some(used_last));
    }

    /// A close round asking about a failed save leaves its window open for as long as the question
    /// is up: a memo made there would be left behind as an empty file once the window goes.
    #[test]
    fn a_window_being_closed_or_switched_is_passed_over_for_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        core.focused(&a);
        core.begin_flush(FlushGoal::CloseWindow(a.clone()));
        assert_eq!(target(&core), Target::Window(b.clone()));
        let c = open(&core, "다");
        core.focused(&c);
        core.closing(&c);
        assert_eq!(target(&core), Target::Window(b.clone()));
        core.focused(&b);
        core.begin_flush(FlushGoal::SwitchWorkspace {
            label: b.clone(),
            to: dir.path().join("other"),
        });
        // Every window is leaving: none takes it, and none is opened beside them.
        assert_eq!(target(&core), Target::Nothing);
    }

    #[test]
    fn nothing_is_made_while_tote_quits_or_restarts() {
        for goal in [FlushGoal::Quit, FlushGoal::Restart] {
            let dir = tempfile::tempdir().unwrap();
            let core = core(dir.path());
            open(&core, "가");
            core.begin_flush(goal.clone());
            assert_eq!(target(&core), Target::Nothing, "{goal:?}");
        }
    }

    /// Records what is registered, as macOS holds it; refuses `refusing`.
    #[derive(Default)]
    struct Keys {
        held: BTreeSet<String>,
        refusing: BTreeSet<String>,
    }

    impl Registrar for Keys {
        fn unregister_all(&mut self) -> Result<(), String> {
            self.held.clear();
            Ok(())
        }

        fn register(&mut self, keys: &str) -> Result<(), String> {
            if self.refusing.contains(keys) {
                return Err("taken".into());
            }
            self.held.insert(keys.to_string());
            Ok(())
        }
    }

    fn wanted(keys: Option<&str>) -> BTreeMap<String, String> {
        keys.map(|keys| ("quick-note".to_string(), keys.to_string()))
            .into_iter()
            .collect()
    }

    fn held(keys: &Keys) -> Vec<&str> {
        keys.held.iter().map(String::as_str).collect()
    }

    /// An old key left registered would keep taking those keys from every other app.
    #[test]
    fn a_changed_or_cleared_key_is_let_go() {
        let (mut registered, mut keys) = (Registered::default(), Keys::default());
        registered.follow(wanted(Some("Ctrl+Alt+N")), &mut keys);
        assert_eq!(held(&keys), ["Ctrl+Alt+N"]);
        registered.follow(wanted(Some("Ctrl+Alt+Shift+N")), &mut keys);
        assert_eq!(held(&keys), ["Ctrl+Alt+Shift+N"]);
        registered.follow(wanted(None), &mut keys);
        assert!(held(&keys).is_empty());
    }

    #[test]
    fn a_refused_key_is_said_and_tried_again_once_it_changes() {
        let mut keys = Keys {
            refusing: BTreeSet::from(["Ctrl+Alt+N".to_string()]),
            ..Keys::default()
        };
        let mut registered = Registered::default();
        registered.follow(wanted(Some("Ctrl+Alt+N")), &mut keys);
        assert!(registered.failed.contains("quick-note"));
        registered.follow(wanted(Some("Ctrl+Alt+M")), &mut keys);
        assert!(registered.failed.is_empty());
        assert_eq!(held(&keys), ["Ctrl+Alt+M"]);
    }

    /// While a settings screen records, the hot key would take the key before the page.
    #[test]
    fn recording_takes_the_keys_off_and_the_recording_window_puts_them_back() {
        let (mut registered, mut keys) = (Registered::default(), Keys::default());
        registered.follow(wanted(Some("Ctrl+Alt+N")), &mut keys);
        registered.suspend("ws-1", &mut keys);
        assert!(held(&keys).is_empty());
        // A key saved meanwhile waits for the end of the recording.
        registered.follow(wanted(Some("Ctrl+Alt+M")), &mut keys);
        assert!(held(&keys).is_empty());
        registered.resume_if("ws-2", &mut keys);
        assert!(held(&keys).is_empty());
        registered.resume_if("ws-1", &mut keys);
        assert_eq!(held(&keys), ["Ctrl+Alt+M"]);
    }

    /// Another app took the key while it was off: the table says so.
    #[test]
    fn a_key_taken_while_recording_is_said_once_it_is_put_back() {
        let (mut registered, mut keys) = (Registered::default(), Keys::default());
        registered.follow(wanted(Some("Ctrl+Alt+N")), &mut keys);
        registered.suspend("ws-1", &mut keys);
        keys.refusing.insert("Ctrl+Alt+N".into());
        registered.resume_if("ws-1", &mut keys);
        assert!(registered.failed.contains("quick-note"));
        assert!(held(&keys).is_empty());
    }

    #[test]
    fn the_window_is_left_a_new_memo_to_make() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        core.page_started(&a);
        leave_new_memo(&core, &a);
        assert_eq!(core.take_pending(&a), vec![PendingOpen::NewMemo]);
        assert_eq!(
            serde_json::to_value(PendingOpen::NewMemo).unwrap(),
            serde_json::json!({"kind": "newMemo"})
        );
    }
}
