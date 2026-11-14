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
}

pub fn target(core: &AppCore) -> Target {
    match core.latest_window() {
        Some(label) => Target::Window(label),
        None => Target::OpenLatest,
    }
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
    };
    leave_new_memo(&core, &label);
    let _ = app.emit_to(EventTarget::webview_window(&label), "tote://pending", ());
}

/// The global shortcuts as registered with macOS: the keys asked for last, and the commands whose
/// keys it refused.
#[derive(Default)]
pub struct GlobalKeys(Mutex<Registered>);

#[derive(Default)]
struct Registered {
    /// Command id → keys, as the settings asked for them last.
    wanted: BTreeMap<String, String>,
    failed: BTreeSet<String>,
}

impl GlobalKeys {
    pub fn table(&self, core: &AppCore) -> GlobalShortcutTable {
        let settings = core.settings();
        let failed = lock(&self.0).failed.clone();
        global_shortcuts::table(&settings.global_shortcuts, &settings.shortcuts, &failed)
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

/// Registers the global shortcuts the settings ask for, unless they are the ones asked for last
/// (a refused key is tried again only once it changes). On the main thread, in turn, and waited
/// for: the settings screen reads the table once `tote://config` comes, which must say whether
/// macOS took the new key.
pub fn follow_settings(app: &AppHandle) {
    on_main_thread(app, register);
}

/// Runs `job` on the main thread and waits for it; at once when this is the main thread. Jobs run
/// one after another, so two settings changes at once cannot interleave their registrations.
pub(super) fn on_main_thread(app: &AppHandle, job: fn(&AppHandle)) {
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

fn register(app: &AppHandle) {
    let settings = app.state::<AppCore>().settings();
    let wanted: BTreeMap<String, String> =
        global_shortcuts::effective(&settings.global_shortcuts, &settings.shortcuts)
            .into_iter()
            .filter_map(|(command, keys)| Some((command.id.to_string(), keys?)))
            .collect();
    let state = app.state::<GlobalKeys>();
    let mut registered = lock(&state.0);
    if registered.wanted == wanted {
        return;
    }
    let manager = app.global_shortcut();
    if let Err(err) = manager.unregister_all() {
        eprintln!("tote: cannot let go of the global shortcuts: {err}");
    }
    let mut failed = BTreeSet::new();
    for (id, keys) in &wanted {
        let taken = global_shortcuts::hotkey(keys)
            .ok_or_else(|| format!("unreadable keys {keys}"))
            .and_then(|shortcut| manager.register(shortcut).map_err(|e| e.to_string()));
        if let Err(err) = taken {
            eprintln!("tote: global shortcut {keys} for {id}: {err}");
            failed.insert(id.clone());
        }
    }
    *registered = Registered { wanted, failed };
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
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
