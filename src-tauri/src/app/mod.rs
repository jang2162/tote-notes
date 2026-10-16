//! The app's shared state: the workspaces open (one per folder) and the windows showing them,
//! focus order for routing, pending opens for windows still loading, and the close/quit
//! bookkeeping. No Tauri types in here, so it
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde::Serialize;

use crate::appdata::{device_name, AppPaths, LaunchState, Machine, Settings, SettingsPatch};
use crate::backup::snapshot::{self, Taken};
use crate::backup::{retention, BackupDir, SnapshotName};
use crate::extensions::registry::{self, Registry};
use crate::extensions::{ExtensionStore, Scan};
use crate::files::TokenStore;
use crate::persist::content_hash;
use crate::persist::external::{ExternalFiles, ExternalState};
use crate::session::drafts::DraftStore;
use crate::watch::{Batch, WatchTarget, Watcher};
use crate::workspace::{Change, Workspace};
use flush::{Ack, Begin, FlushCoordinator, FlushGoal};

/// A poisoned lock only means another command panicked; the data is still the best there is.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a window's frontend should open — or say — when it next asks (`take_pending_opens`): the
/// window may still be loading when a `tote` command arrives.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PendingOpen {
    Memo {
        id: String,
    },
    External {
        path: PathBuf,
    },
    /// Why a `tote` request failed, for the status bar.
    Notice {
        message: String,
    },
}

/// What `tote://outside` tells a window another app did (spec 「외부 변경」).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutsideChange {
    Workspace { changes: Vec<Change> },
    External { path: PathBuf, state: ExternalState },
}

pub struct AppCore {
    pub paths: AppPaths,
    pub machine: Machine,
    pub external: ExternalFiles,
    pub extensions: ExtensionStore,
    pub files: TokenStore,
    workspace_root: Mutex<PathBuf>,
    settings: Mutex<Settings>,
    registry: Mutex<Rescanned>,
    /// The start number of the latest `rescan_extensions`.
    rescans: AtomicU64,
    /// Window label → the number of its latest large-text search.
    searches: Mutex<HashMap<String, u64>>,
    /// Window label → the number of its latest workspace search. Apart from `searches`: the
    /// search panel and a large text viewer each run their own.
    workspace_searches: Mutex<HashMap<String, u64>>,
    /// Set once at startup by `start_watching`; without it (tests) nothing is watched.
    watcher: OnceLock<Watcher>,
    /// Wakes the backup thread with a window label (`request_backup`); unset until
    /// `start_backups` runs, so tests and early windows ask nothing.
    backup_waker: Mutex<Option<Sender<String>>>,
    /// The number of the last window label handed out (`next_label`).
    labels: AtomicU64,
    inner: Mutex<Inner>,
}

/// The registry and the start number of the scan it was built from.
struct Rescanned {
    started: u64,
    registry: Registry,
}

struct Inner {
    /// Folder → its workspace, open while a window shows it or one is being opened for it.
    workspaces: HashMap<PathBuf, OpenWorkspace>,
    /// Window label → the window.
    windows: HashMap<String, OpenWindow>,
    /// Folder → the label of the window being opened for it: claimed before `Workspace::open`,
    /// so two requests for one folder cannot both open it.
    reserved: HashMap<PathBuf, String>,
    /// Window labels, most recently focused first.
    focus: Vec<String>,
    /// The `serial` of the next window registered.
    serials: u64,
    launch: LaunchState,
    flush: FlushCoordinator,
    quitting: bool,
}

struct OpenWorkspace {
    workspace: Arc<Mutex<Workspace>>,
}

struct OpenWindow {
    path: PathBuf,
    pending: Vec<PendingOpen>,
    /// Opening order among all windows; a workspace's windows are counted in it (titles).
    serial: u64,
    /// Set by `closing`. On the window, not in a list of labels, so it goes with the window: a
    /// mark left behind would keep a window registered again under its label out of the next
    /// quit.
    closing: bool,
}

impl Inner {
    /// The labels of the windows on `path`, in opening order.
    fn windows_of(&self, path: &Path) -> Vec<String> {
        let mut windows: Vec<(&String, &OpenWindow)> = self
            .windows
            .iter()
            .filter(|(_, window)| window.path == path)
            .collect();
        windows.sort_by_key(|(_, window)| window.serial);
        windows
            .into_iter()
            .map(|(label, _)| label.clone())
            .collect()
    }

    /// Closes the workspace at `path` once no window shows it and none is being opened for it.
    /// Returns its watch key when it closed.
    fn close_if_unused(&mut self, path: &Path) -> Option<String> {
        let unused = !self.reserved.contains_key(path)
            && !self.windows.values().any(|window| window.path == path);
        (unused && self.workspaces.remove(path).is_some()).then(|| AppCore::workspace_key(path))
    }
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
        let core = AppCore::new(paths, machine, settings, launch, bundled_dir);
        core.extensions.remove_leftovers();
        Ok(core)
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
            registry: Mutex::new(Rescanned {
                started: 0,
                registry,
            }),
            rescans: AtomicU64::new(0),
            searches: Mutex::new(HashMap::new()),
            workspace_searches: Mutex::new(HashMap::new()),
            watcher: OnceLock::new(),
            backup_waker: Mutex::new(None),
            labels: AtomicU64::new(0),
            inner: Mutex::new(Inner {
                workspaces: HashMap::new(),
                windows: HashMap::new(),
                reserved: HashMap::new(),
                focus: Vec::new(),
                serials: 0,
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

    /// Saves and applies the fields `patch` names: the workspace root moves at once (open windows
    /// stay), the registry is rebuilt with the new switches.
    pub fn patch_settings(&self, patch: SettingsPatch) -> io::Result<()> {
        self.modify_settings(|settings| patch.apply(settings))
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
        lock(&self.registry).registry.clone()
    }

    /// The disk is read before the settings lock is taken: a slow scan does not hold up settings
    /// reads and changes in every other window.
    pub fn rescan_extensions(&self) {
        let started = self.start_rescan();
        let scan = self.extensions.scan();
        self.apply_rescan(started, &scan);
    }

    fn start_rescan(&self) -> u64 {
        self.rescans.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Two rescans can overlap and finish in either order. One that started before the scan
    /// already in the registry read an older disk (an install in between would be missing), so
    /// it is dropped. The settings are read here, so the one kept still gets the latest switches.
    fn apply_rescan(&self, started: u64, scan: &Scan) {
        let settings = lock(&self.settings);
        let mut current = lock(&self.registry);
        if started > current.started {
            *current = Rescanned {
                started,
                registry: registry::build(scan, &settings.extensions),
            };
        }
    }

    /// The folder of an installed extension, enabled or not.
    pub fn extension_path(&self, id: &str) -> Option<PathBuf> {
        lock(&self.registry)
            .registry
            .extensions
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.path.clone())
    }

    /// A label for a new window: `ws-1`, `ws-2`, … counted from 1 in every run. A label names the
    /// window, not the workspace it shows.
    pub fn next_label(&self) -> String {
        format!("ws-{}", self.labels.fetch_add(1, Ordering::Relaxed) + 1)
    }

    /// What the watcher calls the workspace at `path`. From the folder, so two folders never share
    /// one even if a copied folder carries the same workspace ID.
    pub fn workspace_key(path: &Path) -> String {
        format!(
            "wk-{}",
            &content_hash(path.as_os_str().as_encoded_bytes())[..16]
        )
    }

    /// Claims the folder `path` for opening a window. `Ok` with the new window's label: this
    /// caller opens it, and must `register_window` or, on failure, `release` that label. `Err`
    /// with the label of the window another request is opening for the folder right now.
    ///
    /// While the claim stands, the folder's workspace stays open even if its last window closes,
    /// so a caller that found it open can still join it.
    pub fn reserve(&self, path: &Path) -> Result<String, String> {
        let mut inner = lock(&self.inner);
        if let Some(label) = inner.reserved.get(path) {
            return Err(label.clone());
        }
        let label = self.next_label();
        inner.reserved.insert(path.to_path_buf(), label.clone());
        Ok(label)
    }

    /// Undoes this caller's own `reserve` (and `register_window`) after a failed open.
    pub fn release(&self, label: &str) {
        let closed = {
            let mut inner = lock(&self.inner);
            let mut paths: Vec<PathBuf> = inner
                .reserved
                .iter()
                .filter(|(_, l)| *l == label)
                .map(|(path, _)| path.clone())
                .collect();
            inner.reserved.retain(|_, l| l != label);
            paths.extend(inner.windows.remove(label).map(|window| window.path));
            inner.focus.retain(|l| l != label);
            paths
                .iter()
                .filter_map(|path| inner.close_if_unused(path))
                .collect::<Vec<_>>()
        };
        if let Some(watcher) = self.watcher.get() {
            watcher.unwatch_window(label);
            for key in closed {
                watcher.unwatch_workspace(&key);
            }
        }
    }

    /// Registers the window `label` on the workspace at `path`. `opened` is the workspace just
    /// opened for it when it is the folder's first window; a later window brings none and joins
    /// the one already open.
    pub fn register_window(&self, label: &str, path: &Path, opened: Option<Workspace>) {
        let watch = {
            let mut inner = lock(&self.inner);
            if inner.reserved.get(path).is_some_and(|l| l == label) {
                inner.reserved.remove(path);
            }
            let watch = match opened {
                Some(workspace) if !inner.workspaces.contains_key(path) => {
                    inner.workspaces.insert(
                        path.to_path_buf(),
                        OpenWorkspace {
                            workspace: Arc::new(Mutex::new(workspace)),
                        },
                    );
                    true
                }
                _ => false,
            };
            if !inner.workspaces.contains_key(path) {
                // Nothing to show: a caller that found the folder open held its claim, so this is
                // a bug, and the window is left out rather than shown without a workspace.
                eprintln!("tote: {label}: no workspace open at {}", path.display());
                return;
            }
            inner.serials += 1;
            let serial = inner.serials;
            inner.windows.insert(
                label.to_string(),
                OpenWindow {
                    path: path.to_path_buf(),
                    pending: Vec::new(),
                    serial,
                    closing: false,
                },
            );
            watch
        };
        // An unwatched workspace still works; it only misses outside changes until reopened.
        if let (true, Some(watcher)) = (watch, self.watcher.get()) {
            if let Err(err) = watcher.watch_workspace(&AppCore::workspace_key(path), path) {
                eprintln!("tote: cannot watch {} for changes: {err}", path.display());
            }
        }
    }

    /// The windows showing the workspace at `path`, in the order they were opened.
    pub fn windows_of(&self, path: &Path) -> Vec<String> {
        lock(&self.inner).windows_of(path)
    }

    /// The window on `path` focused most recently; one not focused yet counts as newest.
    pub fn front_window_of(&self, path: &Path) -> Option<String> {
        let inner = lock(&self.inner);
        let on_path = inner.windows_of(path);
        on_path
            .iter()
            .find(|label| !inner.focus.contains(label))
            .or_else(|| inner.focus.iter().find(|label| on_path.contains(label)))
            .cloned()
    }

    /// The other windows showing the workspace of window `label`.
    pub fn siblings(&self, label: &str) -> Vec<String> {
        let inner = lock(&self.inner);
        let Some(path) = inner.windows.get(label).map(|w| w.path.clone()) else {
            return Vec::new();
        };
        let mut windows = inner.windows_of(&path);
        windows.retain(|l| l != label);
        windows
    }

    /// The title of each window on `path`, by label, in opening order (`window_title`).
    pub fn titles_of(&self, path: &Path) -> Vec<(String, String)> {
        let (labels, workspace) = {
            let inner = lock(&self.inner);
            let Some(open) = inner.workspaces.get(path) else {
                return Vec::new();
            };
            (inner.windows_of(path), open.workspace.clone())
        };
        let name = lock(&workspace).name();
        labels
            .into_iter()
            .enumerate()
            .map(|(nth, label)| (label, window_title(&name, nth)))
            .collect()
    }

    /// Starts the watcher. `on_batch` runs on the watcher's thread for every batch and hands it to
    /// `AppCore::on_batch`. Workspaces opened before this are not watched, so it runs before any
    /// window opens.
    pub fn start_watching(
        &self,
        on_batch: impl Fn(WatchTarget, Batch) + Send + 'static,
    ) -> notify::Result<()> {
        let watcher = Watcher::new(on_batch)?;
        let _ = self.watcher.set(watcher);
        Ok(())
    }

    /// The window `label` shows the external file at `path` (counted per call).
    pub fn watch_external(&self, label: &str, path: &Path) -> notify::Result<()> {
        match self.watcher.get() {
            Some(watcher) => watcher.watch_external(label, path),
            None => Ok(()),
        }
    }

    pub fn unwatch_external(&self, label: &str, path: &Path) {
        if let Some(watcher) = self.watcher.get() {
            watcher.unwatch_external(label, path);
        }
    }

    /// What a batch from the watcher means for the windows it is for, if anything: changes that
    /// are tote's own writes are dropped here. A workspace batch is applied under the workspace's
    /// lock, so it cannot interleave with a save or `list_memos`, and goes to every window of the
    /// workspace.
    pub fn on_batch(&self, target: WatchTarget, batch: Batch) -> Vec<(String, OutsideChange)> {
        match target {
            WatchTarget::Workspace(key) => {
                let found = {
                    let inner = lock(&self.inner);
                    inner
                        .workspaces
                        .iter()
                        .find(|(path, _)| AppCore::workspace_key(path) == key)
                        .map(|(path, open)| (path.clone(), open.workspace.clone()))
                };
                let Some((path, workspace)) = found else {
                    return Vec::new();
                };
                let name = |path: &PathBuf| path.file_name()?.to_str().map(str::to_string);
                let touched = batch.touched.iter().filter_map(name).collect();
                let renames: Vec<(String, String)> = batch
                    .renames
                    .iter()
                    .filter_map(|(from, to)| Some((name(from)?, name(to)?)))
                    .collect();
                let changes = match lock(&workspace).apply_fs_events(&touched, &renames) {
                    Ok(changes) => changes,
                    Err(err) => {
                        eprintln!(
                            "tote: could not take in outside changes for {}: {err}",
                            path.display()
                        );
                        return Vec::new();
                    }
                };
                if changes.is_empty() {
                    return Vec::new();
                }
                let change = OutsideChange::Workspace { changes };
                self.windows_of(&path)
                    .into_iter()
                    .map(|label| (label, change.clone()))
                    .collect()
            }
            WatchTarget::External(label, path) => match self.external.outside_state(&path) {
                Some(state) => vec![(label, OutsideChange::External { path, state })],
                None => Vec::new(),
            },
        }
    }

    pub fn workspace(&self, label: &str) -> Option<Arc<Mutex<Workspace>>> {
        let inner = lock(&self.inner);
        let path = &inner.windows.get(label)?.path;
        inner.workspaces.get(path).map(|w| w.workspace.clone())
    }

    pub fn path_of(&self, label: &str) -> Option<PathBuf> {
        lock(&self.inner).windows.get(label).map(|w| w.path.clone())
    }

    pub fn is_open_path(&self, path: &Path) -> bool {
        lock(&self.inner).workspaces.contains_key(path)
    }

    pub fn recent(&self) -> Vec<PathBuf> {
        lock(&self.inner).launch.recent.clone()
    }

    /// The workspace at `from` moved to `to`: the recent list and the windows to reopen follow it.
    pub fn relocate(&self, from: &Path, to: &Path) {
        let mut inner = lock(&self.inner);
        inner.launch.relocate(from, to);
        self.save_launch(&inner.launch);
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

    /// A new workspace search from `window`: the earlier one of that window stops at its next
    /// check.
    pub fn begin_workspace_search(&self, window: &str, request_id: u64) {
        lock(&self.workspace_searches).insert(window.to_string(), request_id);
    }

    pub fn workspace_search_is_live(&self, window: &str, request_id: u64) -> bool {
        lock(&self.workspace_searches).get(window) == Some(&request_id)
    }

    /// A window is gone; its workspace closes with its last window. Returns the flush rounds it
    /// was the last one to wait for, by id.
    pub fn closed(&self, label: &str) -> Vec<(u64, Ack)> {
        self.files.revoke_window(label);
        // A search still running for the window stops at its next check.
        lock(&self.searches).remove(label);
        lock(&self.workspace_searches).remove(label);
        if let Some(watcher) = self.watcher.get() {
            watcher.unwatch_window(label);
        }
        let (rounds, closed) = {
            let mut inner = lock(&self.inner);
            let removed = inner.windows.remove(label);
            inner.focus.retain(|l| l != label);
            let closed = removed
                .as_ref()
                .and_then(|window| inner.close_if_unused(&window.path));
            // While quitting, windows close one by one; the list to reopen was fixed by start_quit.
            if let (Some(window), false) = (removed, inner.quitting) {
                inner.launch.remove_open(&window.path);
                self.save_launch(&inner.launch);
            }
            (inner.flush.window_gone(label), closed)
        };
        if let (Some(key), Some(watcher)) = (closed, self.watcher.get()) {
            watcher.unwatch_workspace(&key);
        }
        rounds
    }

    /// The window is being closed: from now on a quit neither waits on it nor reopens it. A window
    /// already gone is not marked.
    pub fn closing(&self, label: &str) {
        if let Some(window) = lock(&self.inner).windows.get_mut(label) {
            window.closing = true;
        }
    }

    pub fn has_windows(&self) -> bool {
        !lock(&self.inner).windows.is_empty()
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
            FlushGoal::Quit => inner
                .windows
                .iter()
                .filter(|(_, window)| !window.closing)
                .map(|(label, _)| label.clone())
                .collect(),
        };
        inner.flush.begin(goal, windows)
    }

    pub fn ack_flush(&self, id: u64, label: &str, blocked: Option<String>) -> Ack {
        lock(&self.inner).flush.ack(id, label, blocked)
    }

    pub fn expire_flush(&self, id: u64) -> Ack {
        lock(&self.inner).flush.expire(id)
    }

    pub fn cancel_flush(&self, id: u64) -> bool {
        lock(&self.inner).flush.cancel(id)
    }

    /// Fixes what reopens at the next launch: every open window but those being closed, the most
    /// recently focused last so it ends up in front.
    pub fn start_quit(&self) {
        let mut inner = lock(&self.inner);
        inner.quitting = true;
        let order: Vec<PathBuf> = inner
            .focus
            .iter()
            .rev()
            .filter_map(|label| inner.windows.get(label))
            .filter(|window| !window.closing)
            .map(|window| window.path.clone())
            .collect();
        inner.launch.open_windows = order;
        self.save_launch(&inner.launch);
    }

    /// Hands the backup thread's wake-up channel to the core (`request_backup`).
    pub fn set_backup_waker(&self, waker: Sender<String>) {
        *lock(&self.backup_waker) = Some(waker);
    }

    /// Asks the backup thread to snapshot the workspace of window `label` now rather than at the
    /// next regular round — a workspace just opened is marked changed (`Workspace::open`). Does
    /// nothing without a waker, or when the thread is gone.
    pub fn request_backup(&self, label: &str) {
        if let Some(waker) = lock(&self.backup_waker).as_ref() {
            let _ = waker.send(label.to_string());
        }
    }

    /// The labels of the open windows.
    pub fn window_labels(&self) -> HashSet<String> {
        lock(&self.inner).windows.keys().cloned().collect()
    }

    /// One backup round (spec 「백업」): each open workspace that changed since the last round is
    /// snapshotted under `now` — once, however many windows show it — then its old snapshots are
    /// pruned. With `only`, just the workspaces of the windows with those labels are looked at;
    /// the others keep their marks. Returns what each snapshotted workspace got, with the labels of
    /// its windows: the new folder, `None` when there was nothing to put in, or why the round
    /// failed for it.
    ///
    /// The workspace lock is held only to read the mark, not while copying: saves go on during a
    /// snapshot, which skips a file changed under it (`SkipReason::Changed`). A failed round, or one
    /// that skipped such a file, leaves the workspace marked so the next round takes it.
    pub fn backup_tick(
        &self,
        now: SnapshotName,
        only: Option<&HashSet<String>>,
    ) -> Vec<(Vec<String>, io::Result<Option<PathBuf>>)> {
        let workspaces: Vec<(Vec<String>, Arc<Mutex<Workspace>>)> = {
            let inner = lock(&self.inner);
            inner
                .workspaces
                .iter()
                .map(|(path, open)| (inner.windows_of(path), open.workspace.clone()))
                .filter(|(labels, _)| {
                    only.is_none_or(|only| labels.iter().any(|label| only.contains(label)))
                })
                .collect()
        };
        let mut ticked = Vec::new();
        for (labels, workspace) in workspaces {
            let (root, id) = {
                let mut workspace = lock(&workspace);
                if !workspace.take_changed() {
                    continue;
                }
                (workspace.root().to_path_buf(), workspace.id().to_string())
            };
            let dir = BackupDir::new(&self.paths.backups_dir(), &id);
            // Left by an app that died mid-snapshot; this thread is the only one making them.
            if let Err(err) = dir.remove_leftovers() {
                eprintln!("tote: could not remove a half-made snapshot of {id}: {err}");
            }
            let result = snapshot::take(&root, &dir, now);
            if !matches!(result, Ok(Taken { deferred: 0, .. })) {
                lock(&workspace).mark_changed();
            }
            if let Ok(Taken {
                folder: Some(_), ..
            }) = result
            {
                // The snapshot stands either way; what will not go now goes next round.
                if let Err(err) = retention::prune(&dir, now) {
                    eprintln!("tote: could not prune the backups of {id}: {err}");
                }
            }
            ticked.push((labels, result.map(|taken| taken.folder)));
        }
        ticked
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

/// The title of the `nth` window (from 0) on the workspace `name`: the second one on is numbered.
pub fn window_title(name: &str, nth: usize) -> String {
    match nth {
        0 => name.to_string(),
        _ => format!("{name} — {}", nth + 1),
    }
}

fn bring_to_front(focus: &mut Vec<String>, label: &str) {
    focus.retain(|l| l != label);
    focus.insert(0, label.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appdata::Precedence;

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
        core.register_window(&label, &path, Some(workspace));
        core.opened(&label);
        label
    }

    /// Another window on the workspace at `path`, already open.
    fn attach(core: &AppCore, path: &Path) -> String {
        let label = core.next_label();
        core.register_window(&label, path, None);
        core.opened(&label);
        label
    }

    fn saved(core: &AppCore) -> LaunchState {
        LaunchState::load(&core.paths.launch_file()).unwrap()
    }

    #[test]
    fn a_tick_snapshots_only_changed_workspaces_and_prunes() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        let a_ws = core.workspace(&a).unwrap();
        let a_id = lock(&a_ws).id().to_string();
        let b_id = lock(&core.workspace(&b).unwrap()).id().to_string();
        lock(&a_ws).create_memo("md", "메모".as_bytes()).unwrap();
        // Over a month old: the round's pruning removes it.
        let a_backups = BackupDir::new(&core.paths.backups_dir(), &a_id);
        let old = SnapshotName::parse("20260901-120000").unwrap();
        fs::create_dir_all(a_backups.path_of(old)).unwrap();
        let b_backups = BackupDir::new(&core.paths.backups_dir(), &b_id);
        fs::write(
            core.path_of(&b).unwrap().join("나.md"),
            "나의 메모".as_bytes(),
        )
        .unwrap();

        // Both were opened just now, so the first round takes both.
        let now = SnapshotName::parse("20261012-120000").unwrap();
        let ticked = core.backup_tick(now, None);
        assert_eq!(ticked.len(), 2, "a window just opened is changed");
        assert_eq!(a_backups.snapshots().unwrap(), vec![now]);
        assert_eq!(b_backups.snapshots().unwrap(), vec![now]);

        // Then only the one written to is taken.
        lock(&a_ws).create_memo("md", "또 메모".as_bytes()).unwrap();
        let later = SnapshotName::parse("20261012-121000").unwrap();
        let ticked = core.backup_tick(later, None);
        assert_eq!(ticked.len(), 1, "only the changed workspace");
        assert_eq!(ticked[0].0, vec![a]);
        assert_eq!(
            ticked[0].1.as_ref().unwrap().as_deref(),
            Some(a_backups.path_of(later).as_path())
        );
        assert_eq!(a_backups.snapshots().unwrap(), vec![now, later]);
        assert_eq!(b_backups.snapshots().unwrap(), vec![now]);

        let last = SnapshotName::parse("20261012-122000").unwrap();
        assert!(
            core.backup_tick(last, None).is_empty(),
            "nothing changed since"
        );
    }

    #[test]
    fn a_wake_snapshots_only_the_woken_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        let a_ws = core.workspace(&a).unwrap();
        let b_ws = core.workspace(&b).unwrap();
        let a_id = lock(&a_ws).id().to_string();
        let b_id = lock(&b_ws).id().to_string();
        let first = SnapshotName::parse("20261012-120000").unwrap();
        core.backup_tick(first, None);

        lock(&a_ws)
            .create_memo("md", "가의 메모".as_bytes())
            .unwrap();
        lock(&b_ws)
            .create_memo("md", "나의 메모".as_bytes())
            .unwrap();
        let a_backups = BackupDir::new(&core.paths.backups_dir(), &a_id);
        let b_backups = BackupDir::new(&core.paths.backups_dir(), &b_id);

        let wake = SnapshotName::parse("20261012-120500").unwrap();
        let ticked = core.backup_tick(wake, Some(&HashSet::from([a.clone()])));
        assert_eq!(ticked.len(), 1);
        assert_eq!(ticked[0].0, vec![a]);
        assert_eq!(a_backups.snapshots().unwrap().last(), Some(&wake));
        assert!(b_backups
            .snapshots()
            .unwrap()
            .iter()
            .all(|&name| name < wake));

        // 나 stays marked: the next regular round takes it.
        let regular = SnapshotName::parse("20261012-121000").unwrap();
        let ticked = core.backup_tick(regular, None);
        assert_eq!(ticked.len(), 1);
        assert_eq!(ticked[0].0, vec![b]);
        assert_eq!(b_backups.snapshots().unwrap().last(), Some(&regular));
    }

    #[test]
    fn request_backup_without_a_waker_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.request_backup("any-label");
    }

    #[test]
    fn request_backup_sends_the_label_to_the_waker() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let (waker, woken) = std::sync::mpsc::channel();
        core.set_backup_waker(waker);
        core.request_backup("w-1");
        assert_eq!(woken.try_recv().unwrap(), "w-1");
    }

    #[test]
    fn a_failed_tick_keeps_the_workspace_marked_for_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let a_ws = core.workspace(&a).unwrap();
        lock(&a_ws).create_memo("md", "메모".as_bytes()).unwrap();
        let a_backups = BackupDir::new(&core.paths.backups_dir(), lock(&a_ws).id());
        // The name is taken (the same second twice): this round makes nothing.
        let now = SnapshotName::parse("20261012-120000").unwrap();
        fs::create_dir_all(a_backups.path_of(now)).unwrap();
        let ticked = core.backup_tick(now, None);
        assert_eq!(ticked.len(), 1);
        assert_eq!(
            ticked[0].1.as_ref().unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );

        let later = SnapshotName::parse("20261012-121000").unwrap();
        let ticked = core.backup_tick(later, None);
        assert_eq!(
            ticked[0].1.as_ref().unwrap().as_deref(),
            Some(a_backups.path_of(later).as_path())
        );
    }

    #[test]
    fn outside_changes_are_reported_unless_they_are_our_own() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let label = open(&core, "가");
        let memo = lock(&core.workspace(&label).unwrap())
            .create_memo("md", b"ours")
            .unwrap();
        let file = core.path_of(&label).unwrap().join(&memo.file);
        let ours = || Batch {
            touched: [file.clone()].into(),
            renames: vec![],
        };
        let target = WatchTarget::Workspace(AppCore::workspace_key(&core.path_of(&label).unwrap()));
        assert_eq!(core.on_batch(target.clone(), ours()), vec![]);
        fs::write(&file, "theirs").unwrap();
        let reached = core.on_batch(target.clone(), ours());
        assert_eq!(reached.len(), 1);
        let (to, change) = &reached[0];
        assert_eq!(*to, label);
        assert_eq!(
            serde_json::to_value(change).unwrap(),
            serde_json::json!({"kind": "workspace", "changes": [{"kind": "modified", "id": memo.id}]})
        );
        assert_eq!(
            core.on_batch(WatchTarget::Workspace("gone".into()), ours()),
            vec![]
        );

        let path = dir.path().join("밖.txt");
        fs::write(&path, "disk").unwrap();
        core.external.open(&path).unwrap();
        core.external.save(&path, b"saved").unwrap();
        let outside = WatchTarget::External(label.clone(), path.clone());
        let seen = || Batch {
            touched: [path.clone()].into(),
            renames: vec![],
        };
        assert_eq!(
            core.on_batch(outside.clone(), seen()),
            vec![],
            "our own save"
        );
        fs::write(&path, "elsewhere").unwrap();
        let reached = core.on_batch(outside.clone(), seen());
        assert_eq!(reached.len(), 1);
        assert_eq!(
            serde_json::to_value(&reached[0].1).unwrap(),
            serde_json::json!({"kind": "external", "path": path, "state": "modified"})
        );
        fs::remove_file(&path).unwrap();
        assert_eq!(
            core.on_batch(outside, seen()),
            vec![(
                label,
                OutsideChange::External {
                    path,
                    state: ExternalState::Removed
                }
            )]
        );
    }

    #[test]
    fn labels_are_new_for_every_window() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let labels = [core.next_label(), core.next_label(), core.next_label()];
        assert_eq!(labels, ["ws-1", "ws-2", "ws-3"]);
        assert!(labels.iter().all(|label| label.starts_with("ws-")));
    }

    #[test]
    fn workspace_keys_are_stable_per_folder() {
        let a = AppCore::workspace_key(Path::new("/w/업무"));
        assert_eq!(a, AppCore::workspace_key(Path::new("/w/업무")));
        assert_ne!(a, AppCore::workspace_key(Path::new("/w/개인")));
        assert!(a.starts_with("wk-") && a.len() == 19);
    }

    #[test]
    fn two_windows_share_one_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let w2 = attach(&core, &core.path_of(&w1).unwrap());
        assert!(Arc::ptr_eq(
            &core.workspace(&w1).unwrap(),
            &core.workspace(&w2).unwrap()
        ));
    }

    #[test]
    fn the_workspace_closes_with_its_last_window() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &path);
        core.closed(&w1);
        assert!(core.is_open_path(&path));
        core.closed(&w2);
        assert!(!core.is_open_path(&path));
        assert!(core.workspace(&w2).is_none());
    }

    #[test]
    fn a_backup_round_takes_a_shared_workspace_once() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let a_path = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &a_path);
        let w3 = open(&core, "나");
        let a_id = lock(&core.workspace(&w1).unwrap()).id().to_string();
        let b_id = lock(&core.workspace(&w3).unwrap()).id().to_string();
        // An empty workspace makes no snapshot folder.
        for label in [&w1, &w3] {
            lock(&core.workspace(label).unwrap())
                .create_memo("md", "메모".as_bytes())
                .unwrap();
        }

        let now = SnapshotName::parse("20261012-120000").unwrap();
        let ticked = core.backup_tick(now, None);
        assert_eq!(ticked.len(), 2, "one entry per workspace");
        let a_entry = ticked
            .iter()
            .find(|(labels, _)| labels.contains(&w1))
            .unwrap();
        assert_eq!(a_entry.0, vec![w1.clone(), w2.clone()]);
        let b_entry = ticked
            .iter()
            .find(|(labels, _)| labels.contains(&w3))
            .unwrap();
        assert_eq!(b_entry.0, vec![w3.clone()]);
        let snapshots = fs::read_dir(core.paths.backups_dir()).unwrap().count();
        assert_eq!(snapshots, 2, "a folder per workspace");
        let a_backups = BackupDir::new(&core.paths.backups_dir(), &a_id);
        let b_backups = BackupDir::new(&core.paths.backups_dir(), &b_id);
        assert_eq!(a_backups.snapshots().unwrap(), vec![now]);
        assert_eq!(b_backups.snapshots().unwrap(), vec![now]);
    }

    #[test]
    fn a_wake_takes_the_workspace_of_the_woken_window() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let w2 = attach(&core, &core.path_of(&w1).unwrap());
        let w3 = open(&core, "나");
        let wake = SnapshotName::parse("20261012-120500").unwrap();
        let ticked = core.backup_tick(wake, Some(&HashSet::from([w2.clone()])));
        assert_eq!(ticked.len(), 1);
        assert_eq!(ticked[0].0, vec![w1, w2]);
        // 나 stays marked: the next regular round takes it.
        let regular = SnapshotName::parse("20261012-121000").unwrap();
        let ticked = core.backup_tick(regular, None);
        assert_eq!(ticked.len(), 1);
        assert_eq!(ticked[0].0, vec![w3]);
    }

    #[test]
    fn a_watch_batch_reaches_every_window_of_its_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &path);
        open(&core, "나");
        let file = path.join("밖에서.md");
        fs::write(&file, "theirs").unwrap();
        let batch = Batch {
            touched: [file].into(),
            renames: vec![],
        };
        let reached = core.on_batch(WatchTarget::Workspace(AppCore::workspace_key(&path)), batch);
        let labels: Vec<&String> = reached.iter().map(|(label, _)| label).collect();
        assert_eq!(labels, vec![&w1, &w2]);
        assert_eq!(reached[0].1, reached[1].1);
    }

    #[test]
    fn siblings_are_the_other_windows_of_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let w2 = attach(&core, &core.path_of(&w1).unwrap());
        let w3 = open(&core, "나");
        assert_eq!(core.siblings(&w1), vec![w2.clone()]);
        assert_eq!(core.siblings(&w2), vec![w1.clone()]);
        assert_eq!(core.siblings(&w3), Vec::<String>::new());
        assert_eq!(core.siblings("gone"), Vec::<String>::new());
    }

    #[test]
    fn windows_of_a_workspace_are_in_opening_order_and_the_front_one_follows_focus() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &path);
        open(&core, "나");
        assert_eq!(core.windows_of(&path), vec![w1.clone(), w2.clone()]);
        assert_eq!(core.front_window_of(&path), Some(w2.clone()));
        core.focused(&w1);
        assert_eq!(core.front_window_of(&path), Some(w1.clone()));
        assert_eq!(core.windows_of(&path), vec![w1, w2]);
        assert_eq!(core.front_window_of(Path::new("/없음")), None);
    }

    #[test]
    fn a_quit_waits_for_every_window_of_a_shared_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let w2 = attach(&core, &core.path_of(&w1).unwrap());
        let w3 = open(&core, "나");
        let Begin::Started { mut windows, .. } = core.begin_flush(FlushGoal::Quit) else {
            panic!("expected a round")
        };
        windows.sort();
        let mut expected = vec![w1, w2, w3];
        expected.sort();
        assert_eq!(windows, expected);
    }

    #[test]
    fn window_titles_number_the_second_window_on() {
        assert_eq!(window_title("업무", 0), "업무");
        assert_eq!(window_title("업무", 1), "업무 — 2");
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &path);
        assert_eq!(
            core.titles_of(&path),
            vec![
                (w1.clone(), "가".to_string()),
                (w2.clone(), "가 — 2".to_string())
            ]
        );
        core.closed(&w1);
        assert_eq!(core.titles_of(&path), vec![(w2, "가".to_string())]);
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
    fn has_windows_follows_register_and_closed() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        assert!(!core.has_windows());
        let a = open(&core, "가");
        let b = open(&core, "나");
        assert!(core.has_windows());
        core.closed(&a);
        assert!(core.has_windows());
        core.closed(&b);
        assert!(!core.has_windows());
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
        core.modify_settings(|current| *current = settings.clone())
            .unwrap();
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
    fn an_installed_extension_is_found_once_rescanned() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let installed = crate::extensions::install::install(
            &core.extensions,
            &crate::extensions::manifest::tests::fixture_vsix(),
            false,
        )
        .unwrap();
        core.rescan_extensions();
        assert_eq!(
            core.extension_path("tote-test.test-theme"),
            Some(installed.path)
        );
    }

    #[test]
    fn an_older_rescan_finishing_last_does_not_undo_a_newer_one() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let older = core.start_rescan();
        let before_install = core.extensions.scan();
        crate::extensions::tests::write_extension(
            &core.paths.extensions_dir(),
            "someone.ext@1",
            r#"{"name": "ext", "publisher": "someone", "version": "1"}"#,
        );
        let newer = core.start_rescan();
        core.apply_rescan(newer, &core.extensions.scan());
        core.apply_rescan(older, &before_install);
        assert_eq!(
            core.extension_path("someone.ext"),
            Some(core.paths.extensions_dir().join("someone.ext@1"))
        );
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
    fn two_windows_patching_different_fields_keep_both() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let root = dir.path().join("elsewhere");
        std::thread::scope(|scope| {
            let core = &core;
            let root = root.clone();
            scope.spawn(move || {
                core.patch_settings(SettingsPatch {
                    workspace_root: Some(Some(root)),
                    ..Default::default()
                })
                .unwrap();
            });
            scope.spawn(move || {
                core.patch_settings(SettingsPatch {
                    precedence: Some(Precedence::Bundled),
                    ..Default::default()
                })
                .unwrap();
            });
        });
        for settings in [
            core.settings(),
            Settings::load(&core.paths.settings_file()).unwrap(),
        ] {
            assert_eq!(settings.workspace_root, Some(root.clone()));
            assert_eq!(settings.extensions.precedence, Precedence::Bundled);
        }
    }

    #[test]
    fn a_path_is_reserved_once() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let workspace = Workspace::create(&core.workspace_root(), "가").unwrap();
        let path = workspace.root().to_path_buf();
        let label = core.reserve(&path).unwrap();
        // The second request is told which window is opening the folder, and cleans up nothing.
        assert_eq!(core.reserve(&path), Err(label.clone()));
        core.register_window(&label, &path, Some(workspace));
        assert!(core.workspace(&label).is_some());
        core.release(&label);
        assert!(core.workspace(&label).is_none());
        assert!(!core.is_open_path(&path));
        let again = core.reserve(&path).unwrap();
        assert_ne!(again, label);
    }

    #[test]
    fn a_reserved_folder_stays_open_when_its_last_window_closes() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        // A second window is on its way: it found the workspace open, so it brings none.
        let w2 = core.reserve(&path).unwrap();
        core.closed(&w1);
        assert!(core.is_open_path(&path));
        core.register_window(&w2, &path, None);
        assert!(core.workspace(&w2).is_some());
        // Had it failed instead, its release would have closed the workspace.
        let w3 = core.reserve(&path).unwrap();
        core.closed(&w2);
        core.release(&w3);
        assert!(!core.is_open_path(&path));
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
        assert_eq!(
            serde_json::to_string(&PendingOpen::Notice {
                message: "워크스페이스가 없습니다: 없는곳".into()
            })
            .unwrap(),
            r#"{"kind":"notice","message":"워크스페이스가 없습니다: 없는곳"}"#
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
        assert_eq!(core.closed(&a), vec![(id, Ack::Done(FlushGoal::Quit))]);
        assert_eq!(core.ack_flush(id, &a, None), Ack::Pending);
        // A window that is not registered has nothing to write: closing it needs no round.
        assert_eq!(
            core.begin_flush(FlushGoal::CloseWindow("gone".into())),
            Begin::Done(FlushGoal::CloseWindow("gone".into()))
        );
    }

    #[test]
    fn a_window_being_closed_is_left_out_of_a_quit() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        core.closing(&a);
        assert!(matches!(
            core.begin_flush(FlushGoal::Quit),
            Begin::Started { windows, .. } if windows == vec![b.clone()]
        ));
        core.start_quit();
        assert_eq!(saved(&core).open_windows, vec![core.path_of(&b).unwrap()]);
    }

    #[test]
    fn closing_a_window_already_gone_marks_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let path = core.path_of(&a).unwrap();
        core.closed(&a);
        core.closing(&a);
        // Even a window registered again under the same label is not marked.
        core.register_window(&a, &path, Some(Workspace::open(&path).unwrap()));
        core.opened(&a);
        assert!(matches!(
            core.begin_flush(FlushGoal::Quit),
            Begin::Started { windows, .. } if windows == vec![a.clone()]
        ));
    }

    #[test]
    fn a_cancelled_quit_round_lets_the_next_quit_start() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let Begin::Started { id, .. } = core.begin_flush(FlushGoal::Quit) else {
            panic!("expected a round")
        };
        let blocked = Some("저장하지 못한 메모 1개".to_string());
        assert!(matches!(
            core.ack_flush(id, &a, blocked),
            Ack::Blocked { .. }
        ));
        assert_eq!(core.begin_flush(FlushGoal::Quit), Begin::AlreadyRunning);
        core.cancel_flush(id);
        assert!(!core.is_quitting());
        assert!(matches!(
            core.begin_flush(FlushGoal::Quit),
            Begin::Started { .. }
        ));
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

    #[test]
    fn workspace_searches_are_separate_from_text_searches() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.begin_workspace_search("ws-1", 1);
        core.begin_search("ws-1", 7);
        // A large-text search does not cancel the panel's, nor the other way round.
        assert!(core.workspace_search_is_live("ws-1", 1));
        core.begin_workspace_search("ws-1", 2);
        assert!(core.search_is_live("ws-1", 7));
        assert!(!core.workspace_search_is_live("ws-1", 1));
        assert!(core.workspace_search_is_live("ws-1", 2));
        // The panel's cancel: 0, a number the frontend never uses.
        core.begin_workspace_search("ws-1", 0);
        assert!(!core.workspace_search_is_live("ws-1", 2));
        core.begin_workspace_search("ws-2", 1);
        core.closed("ws-2");
        assert!(!core.workspace_search_is_live("ws-2", 1));
    }
}
