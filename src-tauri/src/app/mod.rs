//! The app's shared state: which window shows which workspace, focus order for routing, pending
//! opens for windows still loading, and the close/quit bookkeeping. No Tauri types in here, so it
//! is tested with plain values; src/app/windows.rs and friends connect it to Tauri.

pub mod commands;
pub mod flush;
pub mod lifecycle;
pub mod menu;
pub mod requests;
pub mod windows;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;

use crate::appdata::{device_name, AppPaths, LaunchState, Machine, Settings};
use crate::extensions::registry::{self, Registry};
use crate::extensions::ExtensionStore;
use crate::files::TokenStore;
use crate::persist::content_hash;
use crate::persist::external::ExternalFiles;
use crate::session::drafts::DraftStore;
use crate::workspace::Workspace;
use flush::{Begin, FlushCoordinator, FlushGoal};

/// A poisoned lock only means another command panicked; the data is still the best there is.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a window's frontend should open when it next asks (`take_pending_opens`): the window may
/// still be loading when a `tote` command arrives.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PendingOpen {
    Memo { id: String },
    External { path: PathBuf },
}

pub struct AppCore {
    pub paths: AppPaths,
    pub machine: Machine,
    pub external: ExternalFiles,
    pub extensions: ExtensionStore,
    pub files: TokenStore,
    workspace_root: Mutex<PathBuf>,
    settings: Mutex<Settings>,
    registry: Mutex<Registry>,
    /// Window label → the number of its latest large-text search.
    searches: Mutex<HashMap<String, u64>>,
    inner: Mutex<Inner>,
}

struct Inner {
    windows: HashMap<String, OpenWindow>,
    /// Labels whose window is being opened: claimed before `Workspace::open`, so two requests
    /// for one folder cannot both open it.
    reserved: HashSet<String>,
    /// Window labels, most recently focused first.
    focus: Vec<String>,
    launch: LaunchState,
    flush: FlushCoordinator,
    quitting: bool,
}

struct OpenWindow {
    path: PathBuf,
    workspace: Arc<Mutex<Workspace>>,
    pending: Vec<PendingOpen>,
}

impl AppCore {
    /// `bundled_dir`: the extensions folder inside the app bundle's resources.
    pub fn load(bundled_dir: PathBuf) -> Result<AppCore, String> {
        let paths = AppPaths::resolve().ok_or("could not find the app data folder")?;
        let machine = Machine::load_or_create(&paths.machine_file(), device_name)
            .map_err(|err| format!("machine.json: {err}"))?;
        let settings = Settings::load(&paths.settings_file())
            .map_err(|err| format!("settings.json: {err}"))?;
        let launch =
            LaunchState::load(&paths.launch_file()).map_err(|err| format!("state.json: {err}"))?;
        Ok(AppCore::new(paths, machine, settings, launch, bundled_dir))
    }

    pub fn new(
        paths: AppPaths,
        machine: Machine,
        settings: Settings,
        launch: LaunchState,
        bundled_dir: PathBuf,
    ) -> AppCore {
        let workspace_root = settings.workspace_root(&paths);
        let external = ExternalFiles::new(DraftStore::new(paths.buffers_dir()));
        let extensions = ExtensionStore::new(bundled_dir, paths.extensions_dir());
        let registry = registry::build(&extensions.scan(), &settings.extensions);
        AppCore {
            paths,
            machine,
            external,
            extensions,
            files: TokenStore::default(),
            workspace_root: Mutex::new(workspace_root),
            settings: Mutex::new(settings),
            registry: Mutex::new(registry),
            searches: Mutex::new(HashMap::new()),
            inner: Mutex::new(Inner {
                windows: HashMap::new(),
                reserved: HashSet::new(),
                focus: Vec::new(),
                launch,
                flush: FlushCoordinator::default(),
                quitting: false,
            }),
        }
    }

    pub fn workspace_root(&self) -> PathBuf {
        lock(&self.workspace_root).clone()
    }

    pub fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    /// Saves and applies: the workspace root moves at once (open windows stay), the registry is
    /// rebuilt with the new switches.
    pub fn update_settings(&self, settings: Settings) -> io::Result<()> {
        self.modify_settings(|current| *current = settings)
    }

    /// `change` runs on the current settings under the settings lock, and the result is saved and
    /// applied before the lock is released: two commands changing settings at once cannot lose
    /// each other's change. A failed save leaves memory as it was.
    pub fn modify_settings(&self, change: impl FnOnce(&mut Settings)) -> io::Result<()> {
        {
            let mut current = lock(&self.settings);
            let mut next = current.clone();
            change(&mut next);
            next.save(&self.paths.settings_file())?;
            *lock(&self.workspace_root) = next.workspace_root(&self.paths);
            *current = next;
        }
        self.rescan_extensions();
        Ok(())
    }

    pub fn registry(&self) -> Registry {
        lock(&self.registry).clone()
    }

    pub fn rescan_extensions(&self) {
        let settings = lock(&self.settings);
        *lock(&self.registry) = registry::build(&self.extensions.scan(), &settings.extensions);
    }

    /// The folder of an installed extension, enabled or not.
    pub fn extension_path(&self, id: &str) -> Option<PathBuf> {
        lock(&self.registry)
            .extensions
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.path.clone())
    }

    /// One window per workspace folder. The label comes from the folder, so opening the same
    /// workspace again finds its window; two folders never share one even if a copied folder
    /// carries the same workspace ID.
    pub fn label_for(path: &Path) -> String {
        format!(
            "ws-{}",
            &content_hash(path.as_os_str().as_encoded_bytes())[..16]
        )
    }

    /// Claims `label` for opening. False when it is registered or another request is opening it;
    /// only the caller that got true may `register` and, on failure, `release` it.
    pub fn reserve(&self, label: &str) -> bool {
        let mut inner = lock(&self.inner);
        if inner.windows.contains_key(label) {
            return false;
        }
        inner.reserved.insert(label.to_string())
    }

    /// Undoes this caller's own `reserve` (and `register`) after a failed open.
    pub fn release(&self, label: &str) {
        let mut inner = lock(&self.inner);
        inner.reserved.remove(label);
        inner.windows.remove(label);
    }

    pub fn register(&self, label: &str, workspace: Workspace) {
        let window = OpenWindow {
            path: workspace.root().to_path_buf(),
            workspace: Arc::new(Mutex::new(workspace)),
            pending: Vec::new(),
        };
        let mut inner = lock(&self.inner);
        inner.reserved.remove(label);
        inner.windows.insert(label.to_string(), window);
    }

    pub fn workspace(&self, label: &str) -> Option<Arc<Mutex<Workspace>>> {
        lock(&self.inner)
            .windows
            .get(label)
            .map(|w| w.workspace.clone())
    }

    pub fn path_of(&self, label: &str) -> Option<PathBuf> {
        lock(&self.inner).windows.get(label).map(|w| w.path.clone())
    }

    pub fn is_open_path(&self, path: &Path) -> bool {
        lock(&self.inner).windows.values().any(|w| w.path == path)
    }

    pub fn recent(&self) -> Vec<PathBuf> {
        lock(&self.inner).launch.recent.clone()
    }

    /// A window finished opening: it is the newest, and it reopens at the next launch.
    pub fn opened(&self, label: &str) {
        let mut inner = lock(&self.inner);
        let Some(path) = inner.windows.get(label).map(|w| w.path.clone()) else {
            return;
        };
        inner.launch.add_open(&path);
        inner.launch.touch(&path);
        bring_to_front(&mut inner.focus, label);
        self.save_launch(&inner.launch);
    }

    pub fn focused(&self, label: &str) {
        let mut inner = lock(&self.inner);
        let Some(path) = inner.windows.get(label).map(|w| w.path.clone()) else {
            return;
        };
        inner.launch.touch(&path);
        bring_to_front(&mut inner.focus, label);
        self.save_launch(&inner.launch);
    }

    /// A new search from `window`: earlier ones of that window stop at their next check.
    pub fn begin_search(&self, window: &str, request_id: u64) {
        lock(&self.searches).insert(window.to_string(), request_id);
    }

    pub fn search_is_live(&self, window: &str, request_id: u64) -> bool {
        lock(&self.searches).get(window) == Some(&request_id)
    }

    /// A window is gone. Returns the flush rounds it was the last one to wait for.
    pub fn closed(&self, label: &str) -> Vec<FlushGoal> {
        self.files.revoke_window(label);
        // A search still running for the window stops at its next check.
        lock(&self.searches).remove(label);
        let mut inner = lock(&self.inner);
        let removed = inner.windows.remove(label);
        inner.focus.retain(|l| l != label);
        // While quitting, windows close one by one; the list to reopen was fixed by start_quit.
        if let (Some(window), false) = (removed, inner.quitting) {
            inner.launch.remove_open(&window.path);
            self.save_launch(&inner.launch);
        }
        inner.flush.window_gone(label)
    }

    pub fn latest_window(&self) -> Option<String> {
        lock(&self.inner).focus.first().cloned()
    }

    pub fn push_pending(&self, label: &str, open: PendingOpen) {
        if let Some(window) = lock(&self.inner).windows.get_mut(label) {
            window.pending.push(open);
        }
    }

    pub fn take_pending(&self, label: &str) -> Vec<PendingOpen> {
        lock(&self.inner)
            .windows
            .get_mut(label)
            .map(|w| std::mem::take(&mut w.pending))
            .unwrap_or_default()
    }

    /// The windows to reopen at launch. They are listed again as each one opens.
    pub fn take_open_windows(&self) -> Vec<PathBuf> {
        std::mem::take(&mut lock(&self.inner).launch.open_windows)
    }

    /// The workspace to show when nothing says which: the most recently used one that still
    /// exists, else the first under the workspace root.
    pub fn fallback_workspace(&self) -> Option<PathBuf> {
        let recent = self.recent();
        recent
            .into_iter()
            .find(|path| Workspace::is_workspace(path))
            .or_else(|| {
                let first = Workspace::list(&self.workspace_root()).into_iter().next()?;
                Some(fs::canonicalize(&first.path).unwrap_or(first.path))
            })
    }

    pub fn begin_flush(&self, goal: FlushGoal) -> Begin {
        let mut inner = lock(&self.inner);
        let windows = match &goal {
            // A window that is not registered answers nothing, so a round for it would only end
            // at the timeout.
            FlushGoal::CloseWindow(label) if !inner.windows.contains_key(label) => vec![],
            FlushGoal::CloseWindow(label) => vec![label.clone()],
            FlushGoal::Quit => inner.windows.keys().cloned().collect(),
        };
        inner.flush.begin(goal, windows)
    }

    pub fn ack_flush(&self, id: u64, label: &str) -> Option<FlushGoal> {
        lock(&self.inner).flush.ack(id, label)
    }

    pub fn expire_flush(&self, id: u64) -> Option<FlushGoal> {
        lock(&self.inner).flush.expire(id)
    }

    /// Fixes what reopens at the next launch: every open window, the most recently focused last
    /// so it ends up in front.
    pub fn start_quit(&self) {
        let mut inner = lock(&self.inner);
        inner.quitting = true;
        let order: Vec<PathBuf> = inner
            .focus
            .iter()
            .rev()
            .filter_map(|label| inner.windows.get(label).map(|w| w.path.clone()))
            .collect();
        inner.launch.open_windows = order;
        self.save_launch(&inner.launch);
    }

    pub fn is_quitting(&self) -> bool {
        lock(&self.inner).quitting
    }

    fn save_launch(&self, launch: &LaunchState) {
        if let Err(err) = launch.save(&self.paths.launch_file()) {
            eprintln!("tote: could not save state.json: {err}");
        }
    }
}

fn bring_to_front(focus: &mut Vec<String>, label: &str) {
    focus.retain(|l| l != label);
    focus.insert(0, label.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let label = AppCore::label_for(workspace.root());
        core.register(&label, workspace);
        core.opened(&label);
        label
    }

    fn saved(core: &AppCore) -> LaunchState {
        LaunchState::load(&core.paths.launch_file()).unwrap()
    }

    #[test]
    fn labels_are_stable_per_folder() {
        let a = AppCore::label_for(Path::new("/w/업무"));
        assert_eq!(a, AppCore::label_for(Path::new("/w/업무")));
        assert_ne!(a, AppCore::label_for(Path::new("/w/개인")));
        assert!(a.starts_with("ws-") && a.len() == 19);
    }

    #[test]
    fn the_latest_window_follows_focus_and_is_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        assert_eq!(core.latest_window(), Some(b.clone()));
        core.focused(&a);
        assert_eq!(core.latest_window(), Some(a.clone()));
        assert_eq!(saved(&core).recent[0], core.path_of(&a).unwrap());
        assert_eq!(saved(&core).open_windows.len(), 2);
    }

    #[test]
    fn closing_a_window_forgets_it_unless_quitting() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        let b_path = core.path_of(&b).unwrap();
        core.closed(&a);
        assert_eq!(saved(&core).open_windows, vec![b_path.clone()]);
        core.start_quit();
        core.closed(&b);
        assert_eq!(saved(&core).open_windows, vec![b_path]);
    }

    #[test]
    fn quitting_reopens_the_latest_window_last() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        core.focused(&a);
        core.start_quit();
        assert_eq!(
            saved(&core).open_windows,
            vec![core.path_of(&b).unwrap(), core.path_of(&a).unwrap()]
        );
        assert!(core.is_quitting());
    }

    #[test]
    fn settings_changes_move_the_workspace_root_and_rebuild_the_registry() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        assert_eq!(core.workspace_root(), core.paths.default_workspace_root);
        let mut settings = core.settings();
        settings.workspace_root = Some(dir.path().join("elsewhere"));
        settings.extensions.disabled = vec!["someone.ext".into()];
        core.update_settings(settings.clone()).unwrap();
        assert_eq!(core.workspace_root(), dir.path().join("elsewhere"));
        assert_eq!(
            Settings::load(&core.paths.settings_file()).unwrap(),
            settings
        );
        crate::extensions::tests::write_extension(
            &core.paths.extensions_dir(),
            "someone.ext@1",
            r#"{"name": "ext", "publisher": "someone", "version": "1",
                "contributes": {"themes": [{"label": "T", "uiTheme": "vs", "path": "t.json"}]}}"#,
        );
        core.rescan_extensions();
        let registry = core.registry();
        assert_eq!(registry.extensions.len(), 1);
        assert!(!registry.extensions[0].enabled);
        assert!(registry.themes.is_empty());
        assert_eq!(
            core.extension_path("someone.ext"),
            Some(core.paths.extensions_dir().join("someone.ext@1"))
        );
        assert_eq!(core.extension_path("nobody.ext"), None);
    }

    #[test]
    fn concurrent_settings_changes_do_not_lose_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        std::thread::scope(|scope| {
            for n in 0..16 {
                let core = &core;
                scope.spawn(move || {
                    core.modify_settings(|s| s.extensions.disabled.push(format!("p.e{n}")))
                        .unwrap();
                });
            }
        });
        let mut expected: Vec<String> = (0..16).map(|n| format!("p.e{n}")).collect();
        expected.sort();
        let mut in_memory = core.settings().extensions.disabled;
        in_memory.sort();
        assert_eq!(in_memory, expected);
        let mut on_disk = Settings::load(&core.paths.settings_file())
            .unwrap()
            .extensions
            .disabled;
        on_disk.sort();
        assert_eq!(on_disk, expected);
    }

    #[test]
    fn a_label_is_reserved_once() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let workspace = Workspace::create(&core.workspace_root(), "가").unwrap();
        let label = AppCore::label_for(workspace.root());
        assert!(core.reserve(&label));
        assert!(!core.reserve(&label));
        core.register(&label, workspace);
        // The second request lost the reservation, so it cleans up nothing.
        assert!(!core.reserve(&label));
        assert!(core.workspace(&label).is_some());
        core.release(&label);
        assert!(core.workspace(&label).is_none());
        assert!(core.reserve(&label));
    }

    #[test]
    fn pending_opens_are_taken_once() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        core.push_pending(
            &a,
            PendingOpen::External {
                path: "/x.sh".into(),
            },
        );
        assert_eq!(
            core.take_pending(&a),
            vec![PendingOpen::External {
                path: "/x.sh".into()
            }]
        );
        assert!(core.take_pending(&a).is_empty());
        assert_eq!(
            serde_json::to_string(&PendingOpen::Memo { id: "m".into() }).unwrap(),
            r#"{"kind":"memo","id":"m"}"#
        );
    }

    #[test]
    fn the_fallback_is_the_latest_workspace_that_still_exists() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        assert_eq!(core.fallback_workspace(), None);
        let a = open(&core, "가");
        let a_path = core.path_of(&a).unwrap();
        core.closed(&a);
        assert_eq!(core.fallback_workspace(), Some(a_path.clone()));
        std::fs::rename(&a_path, dir.path().join("옮김")).unwrap();
        let other = Workspace::create(&core.workspace_root(), "다른").unwrap();
        assert_eq!(core.fallback_workspace(), Some(other.root().to_path_buf()));
    }

    #[test]
    fn a_window_closing_mid_quit_completes_the_round() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let Begin::Started { id, windows } = core.begin_flush(FlushGoal::Quit) else {
            panic!("expected a round")
        };
        assert_eq!(windows, vec![a.clone()]);
        assert_eq!(core.closed(&a), vec![FlushGoal::Quit]);
        assert_eq!(core.ack_flush(id, &a), None);
        // A window that is not registered has nothing to write: closing it needs no round.
        assert_eq!(
            core.begin_flush(FlushGoal::CloseWindow("gone".into())),
            Begin::Done(FlushGoal::CloseWindow("gone".into()))
        );
    }

    #[test]
    fn closing_a_window_revokes_its_file_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let token = core.files.issue(&a, "tab:primary", "/x.png".into());
        core.closed(&a);
        assert_eq!(core.files.resolve(&token), None);
    }

    #[test]
    fn only_the_latest_search_of_a_window_is_live() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.begin_search("ws-1", 1);
        assert!(core.search_is_live("ws-1", 1));
        core.begin_search("ws-1", 2);
        assert!(!core.search_is_live("ws-1", 1));
        assert!(core.search_is_live("ws-1", 2));
        core.begin_search("ws-2", 1);
        assert!(core.search_is_live("ws-2", 1) && core.search_is_live("ws-1", 2));
    }
}
