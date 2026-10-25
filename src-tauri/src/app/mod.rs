//! The app's shared state: the workspaces open (one per folder) and the windows showing them,
//! focus order for routing, pending opens for windows still loading, and the close/quit
//! bookkeeping. No Tauri types in here, so it
//! is tested with plain values; src/app/windows.rs and friends connect it to Tauri.

pub mod commands;
pub mod flush;
#[cfg(target_os = "macos")]
pub mod key_equivalents;
pub mod lifecycle;
pub mod menu;
pub mod places;
pub mod requests;
pub mod update;
pub mod windows;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde::Serialize;
use serde_json::Value;

use crate::appdata::{device_name, AppPaths, LaunchState, Machine, Settings, SettingsPatch};
use crate::backup::snapshot::{self, Taken};
use crate::backup::{retention, BackupDir, SnapshotName};
use crate::cli::CliRequest;
use crate::extensions::registry::{self, Registry};
use crate::extensions::{ExtensionStore, Scan};
use crate::files::TokenStore;
use crate::persist::content_hash;
use crate::persist::external::{ExternalFiles, ExternalState};
use crate::session::drafts::DraftStore;
use crate::session::{read_layouts, write_layouts};
use crate::watch::{Batch, WatchTarget, Watcher};
use crate::workspace::{Change, Workspace, WorkspaceError};
use flush::{Ack, Begin, FlushCoordinator, FlushGoal};
use places::{Places, TabKey, TabRef};
use update::UpdateOffer;

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
    /// A new version to ask about (`AppCore::offer_update`).
    Update(UpdateOffer),
}

/// What a window asked to switch to calls for (`AppCore::switch_target`).
#[derive(Debug, PartialEq, Eq)]
pub enum SwitchTarget {
    /// The window shows it already: nothing to do.
    Stay,
    /// Another window shows it, or is being opened for it: that one comes forward, and this one
    /// stays where it is.
    Focus(String),
    /// No window shows it: this window writes its tabs, then switches.
    Open,
}

/// Why `AppCore::prepare_switch` did not open the workspace.
#[derive(Debug)]
pub enum SwitchError {
    /// A window came to show it while this one was writing its tabs: bring that one forward.
    Shown(String),
    Open(WorkspaceError),
}

/// A window a tab dragged out of another may land on (`AppCore::drop_candidates`).
#[derive(Debug, PartialEq, Eq)]
pub struct DropCandidate {
    pub label: String,
    pub same_workspace: bool,
    pub leaving: bool,
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
    /// Which window holds each open tab: under this lock with `windows`, so a window's claims go
    /// with it.
    places: Places,
    launch: LaunchState,
    flush: FlushCoordinator,
    quitting: bool,
    /// Window label → the CLI requests `hold_request` kept for its switch. Not on the window: a
    /// window that goes mid-switch (`closed`, `release`) must not take them with it.
    held: HashMap<String, Vec<CliRequest>>,
    /// An update found while no window was open: the next window registered asks about it.
    waiting_offer: Option<UpdateOffer>,
}

struct OpenWorkspace {
    workspace: Arc<Mutex<Workspace>>,
    /// The window layouts of this device's session file, read when the workspace opened: the
    /// `k`th window reopened on it starts from `saved[k]`.
    saved: Vec<Value>,
    /// What the watcher calls this workspace (`AppCore::workspace_key`), so a batch finds it
    /// without hashing every open path.
    key: String,
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
    /// The window's layout for the session file: the latest its frontend wrote, else the one it
    /// was reopened with. A window with none is left out of the file.
    layout: Option<Value>,
    /// Set by `switch_window` until the window's new page asks for its workspace (`page_started`).
    /// Meanwhile the old page is still up and its timers may still fire; the backend finds a
    /// window's workspace by its label, so what that page writes would land in the new workspace.
    switching: bool,
    /// Set from the moment the window's round ends as a switch — by `prepare_switch`, or already
    /// by `expire_flush` — until `finish_switch`. Meanwhile its `path` is still the workspace it
    /// leaves while `reserved` already names it for the target. A CLI request for the target would
    /// land in the workspace left and be cleared by `switch_window`, so it waits in `Inner::held`.
    in_switch: bool,
    /// Set by `page_started`, the page's first command (`workspace_info`). The page listens for a
    /// tab handed to it (`tote://adopt`) before it makes that call, so from here on such a tab
    /// reaches it. False from registration, not from `opened` — the page may ask before the window
    /// is done opening — and again from `switch_window` until the new page starts.
    page_ready: bool,
}

impl OpenWindow {
    /// `AppCore::window_is_leaving`.
    fn is_leaving(&self) -> bool {
        self.in_switch || self.switching || self.closing
    }

    /// Changes to the workspace from the window's page are refused while the page is the one of
    /// the workspace it left.
    fn check_writable(&self, label: &str) -> io::Result<()> {
        if self.switching {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{label} is switching workspaces"),
            ));
        }
        Ok(())
    }
}

/// The window a tab was to leave is closing or switching its workspace (`AppCore::adopt_tab`):
/// `commands::io_code` answers it with its own code, so the page can say so in words.
#[derive(Debug)]
pub struct WindowBusy(String);

impl std::fmt::Display for WindowBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} is closing or switching", self.0)
    }
}

impl std::error::Error for WindowBusy {}

/// Another round — a close, a switch or a quit — is open: the restart waits for it to end.
#[derive(Debug, PartialEq, Eq)]
pub struct RestartBusy;

impl Inner {
    /// Whether window `label` (`window`) is to take no tab handed to it: it is leaving
    /// (`OpenWindow::is_leaving`), or a round to close it or switch its workspace is open
    /// (`FlushCoordinator::targets`). Its page answers that round by writing its tabs, so a tab
    /// that came after would go with the window. Not part of `window_is_leaving`, which tells a
    /// page answering a round too late whether its window is going.
    fn takes_no_tabs(&self, label: &str, window: &OpenWindow) -> bool {
        self.gives_no_tabs(label, window)
    }

    /// Whether window `label` (`window`) is to hand no tab to another: it is leaving, or a round to
    /// close it or switch its workspace is open. A page that answered a switch has written the tab
    /// into the session of the workspace it leaves, and the tab would be in two layouts; one that
    /// has not answered yet writes its tabs for the round all the same.
    fn gives_no_tabs(&self, label: &str, window: &OpenWindow) -> bool {
        window.is_leaving() || self.flush.targets(label)
    }

    /// The labels of the windows on `path`, in opening order.
    /// The windows a quit waits on. A window whose page is not up has nothing to write and may not
    /// answer, so it would only hold the round to its timeout: one that switched wrote its tabs
    /// before it did, and one still loading has no layout and was never focused.
    fn quit_windows(&self) -> Vec<String> {
        self.windows
            .iter()
            .filter(|(label, window)| {
                !window.closing
                    && !window.switching
                    && (window.layout.is_some() || self.focus.contains(*label))
            })
            .map(|(label, _)| label.clone())
            .collect()
    }

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

    /// The layouts of `labels` that have one, in that order: what the session file holds.
    fn layouts_of(&self, labels: &[String]) -> Vec<Value> {
        labels
            .iter()
            .filter_map(|label| self.windows.get(label)?.layout.clone())
            .collect()
    }

    fn key_for(&self, label: &str, tab: &TabRef) -> Option<TabKey> {
        Some(match tab {
            TabRef::Memo { id } => TabKey::Memo {
                workspace: self.windows.get(label)?.path.clone(),
                id: id.clone(),
            },
            TabRef::External { path } => TabKey::External { path: path.clone() },
        })
    }

    /// Adds the window `label` on the workspace open at `path`, the newest in opening order.
    fn add_window(&mut self, label: &str, path: &Path, layout: Option<Value>) {
        self.serials += 1;
        let serial = self.serials;
        // Its page takes this with its first `take_pending_opens`.
        let pending = self
            .waiting_offer
            .take()
            .map(PendingOpen::Update)
            .into_iter()
            .collect();
        self.windows.insert(
            label.to_string(),
            OpenWindow {
                path: path.to_path_buf(),
                pending,
                serial,
                closing: false,
                layout,
                switching: false,
                in_switch: false,
                page_ready: false,
            },
        );
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
                places: Places::default(),
                launch,
                flush: FlushCoordinator::default(),
                quitting: false,
                held: HashMap::new(),
                waiting_offer: None,
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
    /// stay), the registry is rebuilt with the new switches. A patch with a value the settings
    /// refuse fails as `InvalidInput` and changes nothing, on disk or in memory.
    pub fn patch_settings(&self, patch: SettingsPatch) -> io::Result<()> {
        self.try_modify_settings(|settings| {
            patch
                .apply(settings)
                .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))
        })
    }

    pub fn modify_settings(&self, change: impl FnOnce(&mut Settings)) -> io::Result<()> {
        self.try_modify_settings(|settings| {
            change(settings);
            Ok(())
        })
    }

    /// `change` runs on the current settings under the settings lock, and the result is saved and
    /// applied before the lock is released: two commands changing settings at once cannot lose
    /// each other's change. A failed change or save leaves memory as it was.
    pub fn try_modify_settings(
        &self,
        change: impl FnOnce(&mut Settings) -> io::Result<()>,
    ) -> io::Result<()> {
        {
            let mut current = lock(&self.settings);
            let mut next = current.clone();
            change(&mut next)?;
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
    /// the one already open. `restored`: the window reopens the `k`th saved layout
    /// (`saved_layout`); `None` for a window of its own, which starts with no layout. Returns
    /// `false`, registering nothing, when no workspace is open at `path` for it to show.
    #[must_use]
    pub fn register_window(
        &self,
        label: &str,
        path: &Path,
        opened: Option<Workspace>,
        restored: Option<usize>,
    ) -> bool {
        let watch = {
            let mut inner = lock(&self.inner);
            if inner.reserved.get(path).is_some_and(|l| l == label) {
                inner.reserved.remove(path);
            }
            let watch = match opened {
                Some(workspace) if !inner.workspaces.contains_key(path) => {
                    // A session that cannot be read starts the windows with no tabs.
                    let saved = read_layouts(path, &self.machine.device_id).unwrap_or_else(|err| {
                        eprintln!("tote: cannot read the session of {}: {err}", path.display());
                        Vec::new()
                    });
                    inner.workspaces.insert(
                        path.to_path_buf(),
                        OpenWorkspace {
                            workspace: Arc::new(Mutex::new(workspace)),
                            saved,
                            key: AppCore::workspace_key(path),
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
                return false;
            }
            let layout = restored.and_then(|k| inner.workspaces[path].saved.get(k).cloned());
            inner.add_window(label, path, layout);
            watch
        };
        // An unwatched workspace still works; it only misses outside changes until reopened.
        if let (true, Some(watcher)) = (watch, self.watcher.get()) {
            if let Err(err) = watcher.watch_workspace(&AppCore::workspace_key(path), path) {
                eprintln!("tote: cannot watch {} for changes: {err}", path.display());
            }
        }
        true
    }

    /// Registers a new window of its own on the workspace open at `path` — ⌥⌘N, a torn-off tab —
    /// and returns its label; `None` when no window shows the workspace. Always a new window, even
    /// while a request is opening another on the folder (`reserve`), whose label would be the
    /// answer there.
    pub fn join(&self, path: &Path) -> Option<String> {
        let mut inner = lock(&self.inner);
        if !inner.workspaces.contains_key(path) {
            return None;
        }
        let label = self.next_label();
        inner.add_window(&label, path, None);
        Some(label)
    }

    /// Window `from` hands the tab `key` (`tab`, its session entry) to the window `new_label`,
    /// registered and not made yet: that window's layout becomes the one tab, the session file is
    /// written with it, and the place is that window's. Called before the window is made, so a
    /// quit or a crash while it loads keeps the tab. `Err`, changing nothing, when `from` does not
    /// hold the tab or gives none (`Inner::gives_no_tabs`), `new_label` is not registered, the app
    /// is quitting or the file cannot be written.
    pub fn adopt_tab(
        &self,
        new_label: &str,
        from: &str,
        tab: Value,
        key: TabKey,
    ) -> io::Result<()> {
        let mut inner = lock(&self.inner);
        if inner.quitting {
            return Err(io::Error::other("the app is quitting"));
        }
        let Some(path) = inner.windows.get(new_label).map(|w| w.path.clone()) else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("{new_label} is not open"),
            ));
        };
        if inner
            .windows
            .get(from)
            .is_some_and(|w| inner.gives_no_tabs(from, w))
        {
            return Err(io::Error::other(WindowBusy(from.to_string())));
        }
        if !inner.places.transfer(&key, from, new_label) {
            return Err(io::Error::other(format!("{from} does not hold the tab")));
        }
        let layout = serde_json::json!({
            "panes": [{ "tabs": [tab], "activeTab": 0, "width": 1 }],
            "focusedPane": 0,
        });
        set_window_layout(&mut inner, new_label, Some(layout));
        if let Err(err) = self.write_session(&inner, &path) {
            inner.places.transfer(&key, new_label, from);
            set_window_layout(&mut inner, new_label, None);
            return Err(err);
        }
        Ok(())
    }

    /// Undoes `adopt_tab` when the window `new_label` could not be made: the place goes back to
    /// `from`, the window is forgotten, and the session file is written without it.
    pub fn give_back(&self, new_label: &str, from: &str, key: &TabKey) {
        let closed = {
            let mut inner = lock(&self.inner);
            inner.places.transfer(key, new_label, from);
            let Some(window) = inner.windows.remove(new_label) else {
                return;
            };
            inner.focus.retain(|l| l != new_label);
            if !inner.quitting {
                if let Err(err) = self.write_session(&inner, &window.path) {
                    eprintln!(
                        "tote: could not save the session of {}: {err}",
                        window.path.display()
                    );
                }
            }
            inner.close_if_unused(&window.path)
        };
        if let (Some(key), Some(watcher)) = (closed, self.watcher.get()) {
            watcher.unwatch_workspace(&key);
        }
    }

    /// Writes the session file of the workspace at `path`: its open windows' layouts, in opening
    /// order.
    fn write_session(&self, inner: &Inner, path: &Path) -> io::Result<()> {
        let labels = inner.windows_of(path);
        write_layouts(path, &self.machine.device_id, &inner.layouts_of(&labels))
    }

    /// The windows showing the workspace at `path`, in the order they were opened.
    pub fn windows_of(&self, path: &Path) -> Vec<String> {
        lock(&self.inner).windows_of(path)
    }

    /// The `k`th window layout of the session file of the workspace at `path`, as read when the
    /// workspace opened.
    pub fn saved_layout(&self, path: &Path, k: usize) -> Option<Value> {
        lock(&self.inner)
            .workspaces
            .get(path)?
            .saved
            .get(k)
            .cloned()
    }

    pub fn layout_of(&self, label: &str) -> Option<Value> {
        lock(&self.inner).windows.get(label)?.layout.clone()
    }

    /// Window `label`'s page begins to load (`PageLoadEvent::Started`), a reload among others: the
    /// new page hears a tab handed to it only once it listens, so the window takes none until it
    /// starts (`page_started`). Should the event come after the page has started on a real
    /// machine, the window is left 「not ready」 until its next load; a tab let go over it then
    /// gets a window of its own, so none is lost — the safe way to be wrong.
    pub fn page_loading(&self, label: &str) {
        if let Some(window) = lock(&self.inner).windows.get_mut(label) {
            window.page_ready = false;
        }
    }

    /// Window `label`'s page asks for its workspace (`workspace_info`), the first thing a page
    /// does as it starts: after a switch that is the new page, so its writes go through from now
    /// on. The old page cannot be the one asking: a switch starts only once the page has its
    /// workspace, while a later request such as `read_window_layout` may still be on its way.
    pub fn page_started(&self, label: &str) {
        if let Some(window) = lock(&self.inner).windows.get_mut(label) {
            window.switching = false;
            window.page_ready = true;
        }
    }

    /// The workspace of window `label`, for a command that changes it. `NotFound` when the window
    /// shows none, `InvalidInput` while it switches workspaces (`page_started`). Under one lock
    /// with the check, so a switch cannot come in between.
    pub fn workspace_to_change(&self, label: &str) -> io::Result<Arc<Mutex<Workspace>>> {
        let inner = lock(&self.inner);
        let not_found = || {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("{label} shows no workspace"),
            )
        };
        let window = inner.windows.get(label).ok_or_else(not_found)?;
        window.check_writable(label)?;
        let open = inner.workspaces.get(&window.path).ok_or_else(not_found)?;
        Ok(open.workspace.clone())
    }

    /// `InvalidInput` while window `label` switches workspaces (`page_started`); for the commands
    /// that bind a window to something of its workspace without changing the workspace itself.
    /// Only as of the call: a switch that begins after it does not undo what it bound, which the
    /// switch drops for the window (`switch_window` revokes its tokens and watches).
    pub fn ensure_writable(&self, label: &str) -> io::Result<()> {
        match lock(&self.inner).windows.get(label) {
            Some(window) => window.check_writable(label),
            None => Ok(()),
        }
    }

    /// What window `label` asking to show the workspace at `to` calls for.
    pub fn switch_target(&self, label: &str, to: &Path) -> SwitchTarget {
        let shown = {
            let inner = lock(&self.inner);
            if inner.windows.get(label).is_some_and(|w| w.path == to) {
                return SwitchTarget::Stay;
            }
            inner.reserved.get(to).cloned()
        };
        match shown.or_else(|| self.front_window_of(to)) {
            Some(window) => SwitchTarget::Focus(window),
            None => SwitchTarget::Open,
        }
    }

    /// Opens the workspace at `to` for window `label` to switch to (`switch_window`), the folder
    /// claimed for it meanwhile as `reserve` does. `Shown` when a window shows it or is being
    /// opened for it — it may have come while this window wrote its tabs — and `Open` when it
    /// cannot be opened; either way nothing changes.
    pub fn prepare_switch(&self, label: &str, to: &Path) -> Result<Workspace, SwitchError> {
        {
            let mut inner = lock(&self.inner);
            if let Some(opening) = inner.reserved.get(to) {
                return Err(SwitchError::Shown(opening.clone()));
            }
            if let Some(window) = inner.windows_of(to).first() {
                return Err(SwitchError::Shown(window.clone()));
            }
            inner.reserved.insert(to.to_path_buf(), label.to_string());
            if let Some(window) = inner.windows.get_mut(label) {
                window.in_switch = true;
            }
        }
        Workspace::open(to).map_err(|err| {
            let mut inner = lock(&self.inner);
            if inner.reserved.get(to).is_some_and(|l| l == label) {
                inner.reserved.remove(to);
            }
            if let Some(window) = inner.windows.get_mut(label) {
                window.in_switch = false;
            }
            SwitchError::Open(err)
        })
    }

    /// Window `label` shows `opened`, the workspace at `to` (`prepare_switch`), instead of its
    /// own. The workspace it leaves keeps the session rule of a closed window — its layout stays
    /// in the file if it was the last window there, else leaves it — and closes with its last
    /// window; the window's places, file tokens, searches and watched files go. It takes the
    /// first saved layout of `to`, keeps its spot among the windows to reopen, and refuses changes
    /// from its page until the new page is up (`page_started`). `NotFound` for a window not
    /// registered, changing nothing.
    pub fn switch_window(&self, label: &str, to: &Path, opened: Workspace) -> io::Result<()> {
        let (fresh, closed) = {
            let mut inner = lock(&self.inner);
            // Before the lookup: a window gone must not leave its claim on `to` behind.
            if inner.reserved.get(to).is_some_and(|l| l == label) {
                inner.reserved.remove(to);
            }
            let Some(from) = inner.windows.get(label).map(|w| w.path.clone()) else {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("{label} is not open"),
                ));
            };
            let fresh = !inner.workspaces.contains_key(to);
            if fresh {
                let saved = read_layouts(to, &self.machine.device_id).unwrap_or_else(|err| {
                    eprintln!("tote: cannot read the session of {}: {err}", to.display());
                    Vec::new()
                });
                inner.workspaces.insert(
                    to.to_path_buf(),
                    OpenWorkspace {
                        workspace: Arc::new(Mutex::new(opened)),
                        saved,
                        key: AppCore::workspace_key(to),
                    },
                );
            }
            let layout = inner.workspaces[to].saved.first().cloned();
            inner.places.release_window(label);
            if let Some(window) = inner.windows.get_mut(label) {
                window.path = to.to_path_buf();
                window.layout = layout;
                window.pending.clear();
                window.switching = true;
                window.page_ready = false;
            }
            // As in `closed`: the last window's layout is already all the file holds.
            let left = inner.windows_of(&from);
            if !left.is_empty() {
                let layouts = inner.layouts_of(&left);
                if let Err(err) = write_layouts(&from, &self.machine.device_id, &layouts) {
                    eprintln!(
                        "tote: could not save the session of {}: {err}",
                        from.display()
                    );
                }
            }
            inner.launch.switch_open(&from, to);
            inner.launch.touch(to);
            self.save_launch(&inner.launch);
            (fresh, inner.close_if_unused(&from))
        };
        self.files.revoke_window(label);
        lock(&self.searches).remove(label);
        lock(&self.workspace_searches).remove(label);
        if let Some(watcher) = self.watcher.get() {
            watcher.unwatch_window(label);
            if let Some(key) = closed {
                watcher.unwatch_workspace(&key);
            }
            // An unwatched workspace still works; it only misses outside changes until reopened.
            if fresh {
                if let Err(err) = watcher.watch_workspace(&AppCore::workspace_key(to), to) {
                    eprintln!("tote: cannot watch {} for changes: {err}", to.display());
                }
            }
        }
        Ok(())
    }

    /// The window `label` wrote its layout: the session file of its workspace is written again
    /// with it. While quitting only memory changes — `start_quit` wrote the file, and a late write
    /// from a window still open would drop the windows already gone from it.
    pub fn set_layout(&self, label: &str, layout: Value) -> io::Result<()> {
        let mut inner = lock(&self.inner);
        let Some(window) = inner.windows.get_mut(label) else {
            return Ok(());
        };
        window.check_writable(label)?;
        window.layout = Some(layout);
        let path = window.path.clone();
        if inner.quitting {
            return Ok(());
        }
        // Written under the lock, so two windows' writes reach the file in the order they came.
        self.write_session(&inner, &path)
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
                        .find(|(_, open)| open.key == key)
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
            inner.places.release_window(label);
            let closed = removed
                .as_ref()
                .and_then(|window| inner.close_if_unused(&window.path));
            // While quitting, windows close one by one; the list to reopen and the session files
            // were fixed by start_quit.
            if let (Some(window), false) = (removed, inner.quitting) {
                inner.launch.remove_open(&window.path);
                self.save_launch(&inner.launch);
                // The last window's layout is already all the file holds, and stays for next time.
                let left = inner.windows_of(&window.path);
                if !left.is_empty() {
                    let layouts = inner.layouts_of(&left);
                    if let Err(err) = write_layouts(&window.path, &self.machine.device_id, &layouts)
                    {
                        eprintln!(
                            "tote: could not save the session of {}: {err}",
                            window.path.display()
                        );
                    }
                }
            }
            (inner.flush.window_gone(label), closed)
        };
        if let (Some(key), Some(watcher)) = (closed, self.watcher.get()) {
            watcher.unwatch_workspace(&key);
        }
        rounds
    }

    /// The key of `tab` as window `label` names it; `None` for a memo of a window not registered.
    pub fn key_for(&self, label: &str, tab: &TabRef) -> Option<TabKey> {
        lock(&self.inner).key_for(label, tab)
    }

    /// Claims `tabs` for window `label`, each `Err(owner)` when another window holds it. A window
    /// not registered (closed meanwhile) gets every one and holds none: a claim it left behind
    /// would never be freed. `Err` while the window switches workspaces (`page_started`).
    pub fn claim_tabs(&self, label: &str, tabs: &[TabRef]) -> io::Result<Vec<Result<(), String>>> {
        let mut inner = lock(&self.inner);
        let Some(window) = inner.windows.get(label) else {
            return Ok(tabs.iter().map(|_| Ok(())).collect());
        };
        window.check_writable(label)?;
        Ok(tabs
            .iter()
            .map(|tab| match inner.key_for(label, tab) {
                Some(key) => inner.places.claim(label, key),
                None => Ok(()),
            })
            .collect())
    }

    /// Window `label` closed the tab: another window may open it now. Nothing while the window
    /// switches workspaces: its places went with the workspace it left.
    pub fn release_tab(&self, label: &str, tab: &TabRef) {
        let mut inner = lock(&self.inner);
        if inner.windows.get(label).is_some_and(|w| w.switching) {
            return;
        }
        if let Some(key) = inner.key_for(label, tab) {
            inner.places.release(label, &key);
        }
    }

    /// The window is being closed: from now on a quit neither waits on it nor reopens it. A window
    /// already gone is not marked.
    pub fn closing(&self, label: &str) {
        if let Some(window) = lock(&self.inner).windows.get_mut(label) {
            window.closing = true;
        }
    }

    /// The window could not be closed after all (`closing` was set for it): it stays, so the next
    /// quit waits on it and reopens it again.
    pub fn close_failed(&self, label: &str) {
        if let Some(window) = lock(&self.inner).windows.get_mut(label) {
            window.closing = false;
        }
    }

    pub fn has_windows(&self) -> bool {
        !lock(&self.inner).windows.is_empty()
    }

    pub fn latest_window(&self) -> Option<String> {
        lock(&self.inner).focus.first().cloned()
    }

    /// Puts a found update to one window — so however many are open, the person is asked once
    /// (spec 2026-10-25 「제약」): `prefer` when it is open (the window the menu's check was picked
    /// in), else the one focused last, else the first opened. With no window at all it waits for
    /// the next one registered. Returns the window to tell (`tote://pending`).
    pub fn offer_update(&self, offer: UpdateOffer, prefer: Option<&str>) -> Option<String> {
        let mut inner = lock(&self.inner);
        let label = prefer
            .filter(|label| inner.windows.contains_key(*label))
            .map(str::to_string)
            .or_else(|| inner.focus.first().cloned())
            .or_else(|| {
                inner
                    .windows
                    .iter()
                    .min_by_key(|(_, window)| window.serial)
                    .map(|(label, _)| label.clone())
            });
        match label {
            Some(label) => {
                if let Some(window) = inner.windows.get_mut(&label) {
                    window.pending.push(PendingOpen::Update(offer));
                }
                Some(label)
            }
            None => {
                inner.waiting_offer = Some(offer);
                None
            }
        }
    }

    pub fn push_pending(&self, label: &str, open: PendingOpen) {
        if let Some(window) = lock(&self.inner).windows.get_mut(label) {
            window.pending.push(open);
        }
    }

    /// What the window should open now. Nothing while it switches (`in_switch`, `switching`): the
    /// page asking is the old one, and the reload would lose what it took.
    pub fn take_pending(&self, label: &str) -> Vec<PendingOpen> {
        lock(&self.inner)
            .windows
            .get_mut(label)
            .filter(|w| !w.in_switch && !w.switching)
            .map(|w| std::mem::take(&mut w.pending))
            .unwrap_or_default()
    }

    /// The windows a tab dragged out of window `from` may land on, most recently focused first:
    /// whether each shows `from`'s workspace and whether it is leaving (`Inner::takes_no_tabs`).
    /// `from` is among them. A window not up yet (`opened`) is not. One whose page has not started
    /// (`page_ready`) counts as leaving: it would not hear the tab, and a tab let go over it must not
    /// go to a window it hides either.
    pub fn drop_candidates(&self, from: &str) -> Vec<DropCandidate> {
        let inner = lock(&self.inner);
        let path = inner.windows.get(from).map(|w| &w.path);
        inner
            .focus
            .iter()
            .filter_map(|label| {
                let window = inner.windows.get(label)?;
                Some(DropCandidate {
                    label: label.clone(),
                    same_workspace: path == Some(&window.path),
                    leaving: inner.takes_no_tabs(label, window) || !window.page_ready,
                })
            })
            .collect()
    }

    /// Hands the tab `key` from window `from` to window `to`, which shows the same workspace,
    /// neither of them leaving, checked under the lock the transfer takes: a window that began to
    /// close or switch since `drop_candidates` — its round only begun — or whose page began to load
    /// again takes nothing (`Inner::takes_no_tabs`, `page_ready`), and one switching away or in a
    /// round of its own gives nothing (`Inner::gives_no_tabs`). False, changing nothing, then, when
    /// `from` does not hold the tab, or while quitting. The session file is left to the two
    /// windows' next layouts.
    pub fn move_tab(&self, from: &str, to: &str, key: &TabKey) -> bool {
        let mut inner = lock(&self.inner);
        if inner.quitting {
            return false;
        }
        let (Some(source), Some(target)) = (inner.windows.get(from), inner.windows.get(to)) else {
            return false;
        };
        if inner.gives_no_tabs(from, source)
            || source.path != target.path
            || inner.takes_no_tabs(to, target)
            || !target.page_ready
        {
            return false;
        }
        inner.places.transfer(key, from, to)
    }

    /// Whether window `label` is going: it switches workspaces (`in_switch`, then `switching`
    /// until its new page is up) or is being closed. A page that answered a round too late keeps
    /// its panes empty then (`lifecycle::ack`).
    pub fn window_is_leaving(&self, label: &str) -> bool {
        lock(&self.inner)
            .windows
            .get(label)
            .is_some_and(OpenWindow::is_leaving)
    }

    /// `OpenWindow::page_ready`. `drop_candidates` cannot tell it apart after a switch: the
    /// page-side `switching` is set and cleared at the same two places.
    #[cfg(test)]
    fn is_page_ready(&self, label: &str) -> bool {
        lock(&self.inner)
            .windows
            .get(label)
            .is_some_and(|w| w.page_ready)
    }

    /// Whether the window is between its round ending as a switch and `finish_switch`. Not the
    /// page-side `switching` (`page_started`), which outlasts it.
    #[cfg(test)]
    fn is_switching(&self, label: &str) -> bool {
        lock(&self.inner)
            .windows
            .get(label)
            .is_some_and(|w| w.in_switch)
    }

    /// Keeps `request`, meant for window `label`, until its switch ends. Gives it back when the
    /// window is not switching (the check and the hold are one step, so the end cannot slip
    /// between): the caller handles the request itself.
    pub fn hold_request(&self, label: &str, request: CliRequest) -> Result<(), CliRequest> {
        let mut inner = lock(&self.inner);
        if inner.windows.get(label).is_some_and(|w| w.in_switch) {
            inner
                .held
                .entry(label.to_string())
                .or_default()
                .push(request);
            Ok(())
        } else {
            Err(request)
        }
    }

    /// The switch of window `label` is over, whichever way it ended: the requests
    /// `hold_request` kept come back, in the order they came, to be handled as if they came now.
    /// They are kept even when the window is gone meanwhile.
    pub fn finish_switch(&self, label: &str) -> Vec<CliRequest> {
        let mut inner = lock(&self.inner);
        if let Some(window) = inner.windows.get_mut(label) {
            window.in_switch = false;
        }
        inner.held.remove(label).unwrap_or_default()
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
            FlushGoal::CloseWindow(label) | FlushGoal::SwitchWorkspace { label, .. }
                if !inner.windows.contains_key(label) =>
            {
                vec![]
            }
            FlushGoal::CloseWindow(label) | FlushGoal::SwitchWorkspace { label, .. } => {
                vec![label.clone()]
            }
            FlushGoal::Quit | FlushGoal::Restart => inner.quit_windows(),
        };
        inner.flush.begin(goal, windows)
    }

    /// Starts the write-then-restart round, on the windows a quit would wait on. Under the same
    /// lock as the check: only when no other round is open, so a restart never joins a close's
    /// or a switch's question the way a quit does (`Ack::DoneThenQuit`).
    pub fn begin_restart(&self) -> Result<Begin, RestartBusy> {
        let mut inner = lock(&self.inner);
        if !inner.flush.is_idle() {
            return Err(RestartBusy);
        }
        let windows = inner.quit_windows();
        Ok(inner.flush.begin(FlushGoal::Restart, windows))
    }

    pub fn ack_flush(&self, id: u64, label: &str, blocked: Option<String>) -> Ack {
        lock(&self.inner).flush.ack(id, label, blocked)
    }

    /// Round `id` ran out of time. A window it ends as a switch or a close is marked going under
    /// the same lock: an answer coming before `lifecycle::finish` marks it would find the window
    /// staying and take its panes back, just before it reloads or goes (`lifecycle::ack`).
    pub fn expire_flush(&self, id: u64) -> Ack {
        let mut inner = lock(&self.inner);
        let ack = inner.flush.expire(id);
        if let Ack::Done(goal) | Ack::DoneThenQuit(goal) = &ack {
            match goal {
                FlushGoal::SwitchWorkspace { label, .. } => {
                    if let Some(window) = inner.windows.get_mut(label) {
                        window.in_switch = true;
                    }
                }
                FlushGoal::CloseWindow(label) => {
                    if let Some(window) = inner.windows.get_mut(label) {
                        window.closing = true;
                    }
                }
                FlushGoal::Quit | FlushGoal::Restart => {}
            }
        }
        ack
    }

    pub fn cancel_flush(&self, id: u64) -> bool {
        lock(&self.inner).flush.cancel(id)
    }

    pub fn asking_close(&self) -> bool {
        lock(&self.inner).flush.asking_close()
    }

    /// Fixes what reopens at the next launch: every open window but those being closed, the most
    /// recently focused last so it ends up in front, and a window still being made (never focused:
    /// a torn-off tab's) first. Each workspace's session file is written in the same order, so the
    /// `k`th window reopened on a folder gets the `k`th layout. A workspace whose every window is
    /// being closed keeps its file: the last layout written stays.
    pub fn start_quit(&self) {
        let mut inner = lock(&self.inner);
        inner.quitting = true;
        let mut loading: Vec<(&String, &OpenWindow)> = inner
            .windows
            .iter()
            .filter(|(label, window)| window.layout.is_some() && !inner.focus.contains(*label))
            .collect();
        loading.sort_by_key(|(_, window)| window.serial);
        let order: Vec<(String, PathBuf)> = loading
            .into_iter()
            .map(|(label, _)| label)
            .chain(inner.focus.iter().rev())
            .filter_map(|label| Some((label, inner.windows.get(label)?)))
            .filter(|(_, window)| !window.closing)
            .map(|(label, window)| (label.clone(), window.path.clone()))
            .collect();
        inner.launch.open_windows = order.iter().map(|(_, path)| path.clone()).collect();
        self.save_launch(&inner.launch);
        let mut written = HashSet::new();
        for (_, path) in &order {
            if !written.insert(path) {
                continue;
            }
            let labels: Vec<String> = order
                .iter()
                .filter(|(_, p)| p == path)
                .map(|(label, _)| label.clone())
                .collect();
            let layouts = inner.layouts_of(&labels);
            if let Err(err) = write_layouts(path, &self.machine.device_id, &layouts) {
                eprintln!(
                    "tote: could not save the session of {}: {err}",
                    path.display()
                );
            }
        }
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

fn set_window_layout(inner: &mut Inner, label: &str, layout: Option<Value>) {
    if let Some(window) = inner.windows.get_mut(label) {
        window.layout = layout;
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
    use serde_json::json;

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

    /// Another window on the workspace at `path`, already open.
    fn attach(core: &AppCore, path: &Path) -> String {
        let label = core.next_label();
        assert!(core.register_window(&label, path, None, None));
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
    fn a_refused_patch_saves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.patch_settings(SettingsPatch {
            editor_font_size: Some(18),
            ..Default::default()
        })
        .unwrap();
        let saved = std::fs::read_to_string(core.paths.settings_file()).unwrap();
        let error = core
            .patch_settings(SettingsPatch {
                editor_font_size: Some(20),
                shortcuts: Some(std::collections::BTreeMap::from([(
                    "save".into(),
                    Some("Cmd+++".into()),
                )])),
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(core.settings().editor.font_size, 18);
        assert_eq!(
            std::fs::read_to_string(core.paths.settings_file()).unwrap(),
            saved
        );
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
        assert!(core.register_window(&label, &path, Some(workspace), None));
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
        assert!(core.register_window(&w2, &path, None, None));
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
        assert_eq!(core.ack_flush(id, &a, None), Ack::Stale);
        // A window that is not registered has nothing to write: closing it needs no round.
        assert_eq!(
            core.begin_flush(FlushGoal::CloseWindow("gone".into())),
            Begin::Done(FlushGoal::CloseWindow("gone".into()))
        );
    }

    fn layouts(core: &AppCore, path: &Path) -> Vec<serde_json::Value> {
        crate::session::read_layouts(path, &core.machine.device_id).unwrap()
    }

    #[test]
    fn each_window_writes_into_the_shared_file() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &path);
        let (a, b) = (json!({"focusedPane": 0}), json!({"focusedPane": 1}));
        core.set_layout(&w1, a.clone()).unwrap();
        core.set_layout(&w2, b.clone()).unwrap();
        assert_eq!(layouts(&core, &path), vec![a.clone(), b.clone()]);
        assert_eq!(core.layout_of(&w1), Some(a));
        assert_eq!(core.layout_of("ws-없음"), None);
    }

    #[test]
    fn closing_one_of_two_windows_drops_its_layout() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &path);
        let (a, b) = (json!({"focusedPane": 0}), json!({"focusedPane": 1}));
        core.set_layout(&w1, a).unwrap();
        core.set_layout(&w2, b.clone()).unwrap();
        core.closed(&w1);
        assert_eq!(layouts(&core, &path), vec![b]);
    }

    #[test]
    fn closing_the_last_window_keeps_its_layout() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &path);
        let (a, b) = (json!({"focusedPane": 0}), json!({"focusedPane": 1}));
        core.set_layout(&w1, a).unwrap();
        core.set_layout(&w2, b.clone()).unwrap();
        core.closed(&w1);
        core.closed(&w2);
        assert_eq!(layouts(&core, &path), vec![b]);
    }

    #[test]
    fn a_window_that_never_wrote_keeps_its_restored_layout() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let workspace = Workspace::create(&core.workspace_root(), "가").unwrap();
        let path = workspace.root().to_path_buf();
        let (a, b, a2) = (
            json!({"focusedPane": 0}),
            json!({"focusedPane": 1}),
            json!({"focusedPane": 2}),
        );
        crate::session::write_layouts(&path, &core.machine.device_id, &[a.clone(), b.clone()])
            .unwrap();
        let w1 = core.next_label();
        assert!(core.register_window(&w1, &path, Some(workspace), Some(0)));
        let w2 = core.next_label();
        assert!(core.register_window(&w2, &path, None, Some(1)));
        assert_eq!(core.saved_layout(&path, 0), Some(a.clone()));
        assert_eq!(core.saved_layout(&path, 2), None);
        assert_eq!(core.layout_of(&w2), Some(b.clone()));
        core.set_layout(&w1, a2.clone()).unwrap();
        assert_eq!(layouts(&core, &path), vec![a2, b]);
    }

    #[test]
    fn a_quit_keeps_every_layout_in_the_order_it_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &path);
        let (a, b) = (json!({"focusedPane": 0}), json!({"focusedPane": 1}));
        core.set_layout(&w1, a.clone()).unwrap();
        core.set_layout(&w2, b.clone()).unwrap();
        core.focused(&w1);
        core.start_quit();
        assert_eq!(saved(&core).open_windows, vec![path.clone(), path.clone()]);
        assert_eq!(layouts(&core, &path), vec![b.clone(), a.clone()]);
        core.closed(&w1);
        core.closed(&w2);
        assert_eq!(layouts(&core, &path), vec![b, a]);
    }

    #[test]
    fn a_quit_while_the_last_window_closes_keeps_its_layout() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let a = json!({"focusedPane": 0});
        core.set_layout(&w1, a.clone()).unwrap();
        core.closing(&w1);
        core.start_quit();
        assert_eq!(layouts(&core, &path), vec![a]);
    }

    #[test]
    fn a_layout_written_while_quitting_leaves_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &path);
        let (a, b, b2) = (
            json!({"focusedPane": 0}),
            json!({"focusedPane": 1}),
            json!({"focusedPane": 2}),
        );
        core.set_layout(&w1, a.clone()).unwrap();
        core.set_layout(&w2, b.clone()).unwrap();
        core.focused(&w2);
        core.start_quit();
        core.closed(&w1);
        // w2's session timer fires after w1 is gone: the file still lists both.
        core.set_layout(&w2, b2.clone()).unwrap();
        assert_eq!(layouts(&core, &path), vec![a, b]);
        assert_eq!(core.layout_of(&w2), Some(b2));
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
    fn a_window_that_fails_to_close_stays_in_the_quit() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let path = core.path_of(&a).unwrap();
        core.set_layout(&a, json!({"focusedPane": 0})).unwrap();
        core.closing(&a);
        core.close_failed(&a);
        assert!(matches!(
            core.begin_flush(FlushGoal::Quit),
            Begin::Started { windows, .. } if windows == vec![a.clone()]
        ));
        core.start_quit();
        assert_eq!(saved(&core).open_windows, vec![path]);
    }

    #[test]
    fn registering_a_window_without_its_workspace_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let label = core.next_label();
        let path = dir.path().join("없음");
        assert!(!core.register_window(&label, &path, None, None));
        assert!(core.window_labels().is_empty());
    }

    #[test]
    fn a_window_still_loading_is_left_out_of_the_quit() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let path = core.path_of(&a).unwrap();
        core.set_layout(&a, json!({"focusedPane": 0})).unwrap();
        // A second window of the folder, registered but its page has not come up: no layout,
        // never focused.
        let loading = core.next_label();
        assert!(core.register_window(&loading, &path, None, None));
        assert!(matches!(
            core.begin_flush(FlushGoal::Quit),
            Begin::Started { windows, .. } if windows == vec![a.clone()]
        ));
        core.start_quit();
        assert_eq!(saved(&core).open_windows, vec![path.clone()]);
        assert_eq!(layouts(&core, &path), vec![json!({"focusedPane": 0})]);
    }

    #[test]
    fn a_focused_window_without_a_layout_joins_the_quit() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        assert_eq!(core.layout_of(&a), None);
        assert!(matches!(
            core.begin_flush(FlushGoal::Quit),
            Begin::Started { windows, .. } if windows == vec![a.clone()]
        ));
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
        assert!(core.register_window(&a, &path, Some(Workspace::open(&path).unwrap()), None));
        core.opened(&a);
        assert!(matches!(
            core.begin_flush(FlushGoal::Quit),
            Begin::Started { windows, .. } if windows == vec![a.clone()]
        ));
    }

    fn offer() -> UpdateOffer {
        UpdateOffer {
            version: "0.2.0".into(),
            current: "0.1.0".into(),
            notes: None,
        }
    }

    fn offers(core: &AppCore, label: &str) -> usize {
        core.take_pending(label)
            .iter()
            .filter(|open| matches!(open, PendingOpen::Update(_)))
            .count()
    }

    #[test]
    fn an_update_offer_goes_to_one_window() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        core.focused(&a);
        assert_eq!(core.offer_update(offer(), None), Some(a.clone()));
        assert_eq!(offers(&core, &a), 1);
        assert_eq!(offers(&core, &b), 0);
        // Handed over once: a window that registers later gets nothing.
        let c = open(&core, "다");
        assert_eq!(offers(&core, &c), 0);
        // The menu's check asks in the window it was picked in.
        assert_eq!(core.offer_update(offer(), Some(&b)), Some(b.clone()));
        assert_eq!(offers(&core, &b), 1);
        assert_eq!(offers(&core, &a), 0);
        // A window that is gone by now is not one to ask in: the latest one is (c, just opened).
        assert_eq!(core.offer_update(offer(), Some("gone")), Some(c.clone()));
    }

    #[test]
    fn an_offer_with_no_window_waits_for_the_first_one() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        assert_eq!(core.offer_update(offer(), None), None);
        let a = open(&core, "가");
        assert_eq!(core.take_pending(&a), vec![PendingOpen::Update(offer())]);
        let b = open(&core, "나");
        assert_eq!(offers(&core, &b), 0);
    }

    #[test]
    fn a_pending_update_tells_the_page_its_kind() {
        assert_eq!(
            serde_json::to_value(PendingOpen::Update(offer())).unwrap(),
            json!({"kind": "update", "version": "0.2.0", "current": "0.1.0", "notes": null})
        );
    }

    #[test]
    fn a_restart_never_starts_beside_another_round() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let Begin::Started { id, .. } = core.begin_flush(FlushGoal::CloseWindow(a.clone())) else {
            panic!("expected a close round")
        };
        assert_eq!(core.begin_restart(), Err(RestartBusy));
        assert!(matches!(
            core.ack_flush(id, &a, None),
            Ack::Done(FlushGoal::CloseWindow(_))
        ));
        let b = open(&core, "나");
        assert!(matches!(
            core.begin_restart(),
            Ok(Begin::Started { windows, .. }) if windows.contains(&b)
        ));
    }

    #[test]
    fn a_restart_waits_on_the_windows_a_quit_would() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let up = open(&core, "가");
        let path = core.path_of(&up).unwrap();
        core.set_layout(&up, json!({"focusedPane": 0})).unwrap();
        // Registered, its page not up yet: no layout, never focused.
        let loading = core.next_label();
        assert!(core.register_window(&loading, &path, None, None));
        let going = open(&core, "나");
        core.closing(&going);
        let also_up = open(&core, "다");

        let Ok(Begin::Started {
            id,
            windows: restart,
        }) = core.begin_restart()
        else {
            panic!("expected a restart round")
        };
        core.cancel_flush(id);
        let Begin::Started { windows: quit, .. } = core.begin_flush(FlushGoal::Quit) else {
            panic!("expected a quit round")
        };
        assert_eq!(restart, quit);
        let mut sorted = restart.clone();
        sorted.sort();
        let mut want = vec![up, also_up];
        want.sort();
        assert_eq!(sorted, want);
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

    #[test]
    fn closing_a_window_frees_its_places() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let w2 = attach(&core, &core.path_of(&w1).unwrap());
        let tabs = [
            TabRef::Memo { id: "a".into() },
            TabRef::External {
                path: PathBuf::from("/tmp/a.sh"),
            },
        ];
        assert_eq!(core.claim_tabs(&w1, &tabs).unwrap(), vec![Ok(()), Ok(())]);
        assert_eq!(
            core.claim_tabs(&w2, &tabs).unwrap(),
            vec![Err(w1.clone()), Err(w1.clone())]
        );
        core.closed(&w1);
        assert_eq!(core.claim_tabs(&w2, &tabs).unwrap(), vec![Ok(()), Ok(())]);
        // The closed window is not registered: its claims all pass and leave no record.
        assert_eq!(core.claim_tabs(&w1, &tabs).unwrap(), vec![Ok(()), Ok(())]);
        assert_eq!(core.claim_tabs(&w2, &tabs).unwrap(), vec![Ok(()), Ok(())]);
    }

    /// A window `w1` on 「가」 whose layout holds the memo tabs `a` and `b`, both claimed by it.
    fn two_tabs(core: &AppCore) -> (String, PathBuf, serde_json::Value) {
        let w1 = open(core, "가");
        let path = core.path_of(&w1).unwrap();
        let layout = json!({
            "panes": [{ "tabs": [{ "kind": "memo", "memoId": "a" }, { "kind": "memo", "memoId": "b" }],
                        "activeTab": 1, "width": 1 }],
            "focusedPane": 0,
        });
        core.set_layout(&w1, layout.clone()).unwrap();
        let tabs = [
            TabRef::Memo { id: "a".into() },
            TabRef::Memo { id: "b".into() },
        ];
        assert_eq!(core.claim_tabs(&w1, &tabs).unwrap(), vec![Ok(()), Ok(())]);
        (w1, path, layout)
    }

    fn memo_b() -> TabRef {
        TabRef::Memo { id: "b".into() }
    }

    #[test]
    fn a_new_window_joins_its_workspace_even_while_another_is_being_opened() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        // A `tote` request is opening a window on the folder right now: ⌥⌘N still gets its own.
        let opening = core.reserve(&path).unwrap();
        let w2 = core.join(&path).unwrap();
        assert_ne!(w2, opening);
        assert_eq!(core.windows_of(&path), vec![w1, w2.clone()]);
        assert_eq!(core.layout_of(&w2), None);
        assert_eq!(core.join(&dir.path().join("없음")), None);
    }

    #[test]
    fn a_torn_off_tab_is_in_the_session_before_its_window_loads() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let (w1, path, layout) = two_tabs(&core);
        let key = core.key_for(&w1, &memo_b()).unwrap();
        let w2 = core.join(&path).unwrap();
        let tab = json!({ "kind": "memo", "memoId": "b" });
        core.adopt_tab(&w2, &w1, tab.clone(), key).unwrap();
        // The new window has written nothing yet.
        let alone = json!({
            "panes": [{ "tabs": [tab], "activeTab": 0, "width": 1 }],
            "focusedPane": 0,
        });
        assert_eq!(layouts(&core, &path), vec![layout.clone(), alone.clone()]);
        assert_eq!(
            core.claim_tabs(&w1, &[memo_b()]).unwrap(),
            vec![Err(w2.clone())]
        );
        // The app quits before the window is up: it reopens all the same.
        core.start_quit();
        assert_eq!(saved(&core).open_windows, vec![path.clone(), path.clone()]);
        assert_eq!(layouts(&core, &path), vec![alone, layout]);
    }

    #[test]
    fn a_tear_off_of_a_tab_the_window_does_not_own_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let (w1, path, layout) = two_tabs(&core);
        let other = attach(&core, &path);
        let key = core.key_for(&other, &memo_b()).unwrap();
        let w3 = core.join(&path).unwrap();
        let tab = json!({ "kind": "memo", "memoId": "b" });
        assert!(core.adopt_tab(&w3, &other, tab, key).is_err());
        assert_eq!(layouts(&core, &path), vec![layout]);
        assert_eq!(core.layout_of(&w3), None);
        assert_eq!(core.claim_tabs(&other, &[memo_b()]).unwrap(), vec![Err(w1)]);
    }

    #[test]
    fn a_tear_off_whose_window_fails_gives_the_tab_back() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let (w1, path, layout) = two_tabs(&core);
        let key = core.key_for(&w1, &memo_b()).unwrap();
        let w2 = core.join(&path).unwrap();
        let tab = json!({ "kind": "memo", "memoId": "b" });
        core.adopt_tab(&w2, &w1, tab, key.clone()).unwrap();
        core.give_back(&w2, &w1, &key);
        assert_eq!(layouts(&core, &path), vec![layout]);
        assert_eq!(core.windows_of(&path), vec![w1.clone()]);
        assert_eq!(core.claim_tabs(&w1, &[memo_b()]).unwrap(), vec![Ok(())]);
        let other = attach(&core, &path);
        assert_eq!(core.claim_tabs(&other, &[memo_b()]).unwrap(), vec![Err(w1)]);
    }

    #[test]
    fn a_tab_moved_to_another_window_belongs_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let (w1, path, _) = two_tabs(&core);
        let w2 = attach(&core, &path);
        core.page_started(&w2);
        let key = core.key_for(&w1, &memo_b()).unwrap();
        assert!(core.move_tab(&w1, &w2, &key));
        assert_eq!(core.key_for(&w2, &memo_b()), Some(key.clone()));
        assert_eq!(
            core.claim_tabs(&w1, &[memo_b()]).unwrap(),
            vec![Err(w2.clone())]
        );
        // The tab is no longer the first window's to give.
        let w3 = attach(&core, &path);
        core.page_started(&w3);
        assert!(!core.move_tab(&w1, &w3, &key));
        // A window that is leaving, or shows another workspace, takes nothing.
        core.closing(&w3);
        assert!(!core.move_tab(&w2, &w3, &key));
        let other = open(&core, "나");
        core.page_started(&other);
        assert!(!core.move_tab(&w2, &other, &key));
        assert_eq!(
            core.claim_tabs(&w1, &[memo_b()]).unwrap(),
            vec![Err(w2.clone())]
        );
        // Nothing moves once the app is quitting.
        let w4 = attach(&core, &path);
        core.page_started(&w4);
        core.start_quit();
        assert!(!core.move_tab(&w2, &w4, &key));
        assert_eq!(core.key_for(&w2, &memo_b()), Some(key));
    }

    #[test]
    fn a_tab_is_not_moved_into_a_window_switching_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let (w1, path, _) = two_tabs(&core);
        let w2 = attach(&core, &path);
        core.page_started(&w2);
        let na = closed_workspace(&core, "나", &[]);
        core.prepare_switch(&w2, &na).unwrap();
        let key = core.key_for(&w1, &memo_b()).unwrap();
        assert!(!core.move_tab(&w1, &w2, &key));
        assert_eq!(core.claim_tabs(&w1, &[memo_b()]).unwrap(), vec![Ok(())]);
    }

    #[test]
    fn a_tab_is_not_moved_out_of_a_window_switching_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let (w1, path, _) = two_tabs(&core);
        let w2 = attach(&core, &path);
        core.page_started(&w2);
        let na = closed_workspace(&core, "나", &[]);
        let key = core.key_for(&w1, &memo_b()).unwrap();
        core.prepare_switch(&w1, &na).unwrap();
        assert!(!core.move_tab(&w1, &w2, &key));
        assert_eq!(
            core.claim_tabs(&w2, &[memo_b()]).unwrap(),
            vec![Err(w1.clone())]
        );
    }

    #[test]
    fn drop_candidates_follow_focus_and_say_what_each_window_is() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let other = open(&core, "나");
        let w2 = attach(&core, &path);
        let w3 = attach(&core, &path);
        for label in [&w1, &other, &w2, &w3] {
            core.page_started(label);
        }
        core.closing(&w3);
        core.focused(&w2);
        let candidate = |label: &str, same_workspace: bool, leaving: bool| DropCandidate {
            label: label.to_string(),
            same_workspace,
            leaving,
        };
        assert_eq!(
            core.drop_candidates(&w1),
            vec![
                candidate(&w2, true, false),
                candidate(&w3, true, true),
                candidate(&other, false, false),
                candidate(&w1, true, false),
            ]
        );
    }

    /// Whether window `label` is among `from`'s drop candidates as one a tab may land on.
    fn takes_drops(core: &AppCore, from: &str, label: &str) -> bool {
        core.drop_candidates(from)
            .iter()
            .any(|candidate| candidate.label == label && !candidate.leaving)
    }

    #[test]
    fn a_window_not_yet_started_is_not_a_drop_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        core.page_started(&w1);
        let w2 = attach(&core, &core.path_of(&w1).unwrap());
        // Up on the screen but its page not yet started: it may not listen yet, and a tab handed to
        // it would be lost.
        assert!(core.drop_candidates(&w1).iter().any(|c| c.label == w2));
        assert!(!takes_drops(&core, &w1, &w2));
        core.page_started(&w2);
        assert!(takes_drops(&core, &w1, &w2));
    }

    #[test]
    fn a_page_started_before_its_window_finished_opening_takes_drops() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        core.page_started(&w1);
        let w2 = core.next_label();
        assert!(core.register_window(&w2, &core.path_of(&w1).unwrap(), None, None));
        core.page_started(&w2);
        core.opened(&w2);
        assert!(takes_drops(&core, &w1, &w2));
    }

    #[test]
    fn a_window_back_from_a_switch_is_a_drop_candidate_again() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let ga = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &ga);
        let w3 = attach(&core, &ga);
        for label in [&w1, &w2, &w3] {
            core.page_started(label);
        }
        let na = closed_workspace(&core, "나", &[]);
        switch(&core, &w2, &na);
        core.finish_switch(&w2);
        // The old page is still up until the new one starts.
        assert!(!takes_drops(&core, &w3, &w2));
        core.page_started(&w2);
        assert!(takes_drops(&core, &w3, &w2));
    }

    #[test]
    fn a_switch_takes_the_page_ready_mark_until_the_new_page_starts() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        core.page_started(&w1);
        assert!(core.is_page_ready(&w1));
        let na = closed_workspace(&core, "나", &[]);
        switch(&core, &w1, &na);
        assert!(!core.is_page_ready(&w1));
        core.finish_switch(&w1);
        assert!(!core.is_page_ready(&w1));
        core.page_started(&w1);
        assert!(core.is_page_ready(&w1));
    }

    #[test]
    fn a_reloading_page_is_not_a_drop_candidate_until_it_starts_again() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let w2 = attach(&core, &core.path_of(&w1).unwrap());
        core.page_started(&w1);
        core.page_started(&w2);
        assert!(takes_drops(&core, &w1, &w2));
        // A reload — the web content process restarting, say — makes a page that listens for a tab
        // handed to it only once it starts.
        core.page_loading(&w2);
        assert!(!takes_drops(&core, &w1, &w2));
        // Nor one picked before it began to load: the transfer checks again.
        let tabs = [TabRef::Memo { id: "a".into() }];
        assert_eq!(core.claim_tabs(&w1, &tabs).unwrap(), vec![Ok(())]);
        let key = core.key_for(&w1, &tabs[0]).unwrap();
        assert!(!core.move_tab(&w1, &w2, &key));
        assert_eq!(core.claim_tabs(&w2, &tabs).unwrap(), vec![Err(w1.clone())]);
        core.page_started(&w2);
        assert!(takes_drops(&core, &w1, &w2));
        assert!(core.move_tab(&w1, &w2, &key));
    }

    #[test]
    fn a_window_in_a_close_round_is_not_a_drop_target() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let (w1, path, _) = two_tabs(&core);
        let w2 = attach(&core, &path);
        core.page_started(&w1);
        core.page_started(&w2);
        let key = core.key_for(&w1, &memo_b()).unwrap();
        let still_w1s = |core: &AppCore| {
            assert_eq!(
                core.claim_tabs(&w2, &[memo_b()]).unwrap(),
                vec![Err(w1.clone())]
            );
        };
        // Its page may answer the round before the tab arrives: it would write its tabs without
        // it, and the tab would go with the window.
        let Begin::Started { id, .. } = core.begin_flush(FlushGoal::CloseWindow(w2.clone())) else {
            panic!("expected a round")
        };
        assert!(!takes_drops(&core, &w1, &w2));
        assert!(!core.move_tab(&w1, &w2, &key));
        still_w1s(&core);
        // 「취소」: the window stays and takes tabs again.
        core.cancel_flush(id);
        assert!(takes_drops(&core, &w1, &w2));
        let na = closed_workspace(&core, "나", &[]);
        let switch = FlushGoal::SwitchWorkspace {
            label: w2.clone(),
            to: na,
        };
        let Begin::Started { id, .. } = core.begin_flush(switch) else {
            panic!("expected a round")
        };
        assert!(!takes_drops(&core, &w1, &w2));
        assert!(!core.move_tab(&w1, &w2, &key));
        still_w1s(&core);
        core.cancel_flush(id);
        // A quit round leaves every window where it is.
        assert!(matches!(
            core.begin_flush(FlushGoal::Quit),
            Begin::Started { .. }
        ));
        assert!(takes_drops(&core, &w1, &w2));
        assert!(core.move_tab(&w1, &w2, &key));
    }

    #[test]
    fn a_window_in_a_switch_gives_no_tab_to_a_new_window() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let (w1, path, layout) = two_tabs(&core);
        core.page_started(&w1);
        let key = core.key_for(&w1, &memo_b()).unwrap();
        let na = closed_workspace(&core, "나", &[]);
        // `prepare_switch` marks the window before any round is open (`in_switch`).
        core.prepare_switch(&w1, &na).unwrap();
        let w3 = core.join(&path).unwrap();
        let tab = json!({ "kind": "memo", "memoId": "b" });
        let refused = core.adopt_tab(&w3, &w1, tab, key).unwrap_err();
        assert_eq!(commands::CommandError::from(refused).code, "window-busy");
        assert_eq!(layouts(&core, &path), vec![layout]);
    }

    #[test]
    fn a_window_in_a_close_round_gives_no_tab_away() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let (w1, path, layout) = two_tabs(&core);
        let w2 = attach(&core, &path);
        core.page_started(&w1);
        core.page_started(&w2);
        let key = core.key_for(&w1, &memo_b()).unwrap();
        let Begin::Started { id, .. } = core.begin_flush(FlushGoal::CloseWindow(w1.clone())) else {
            panic!("expected a round")
        };
        // Neither to a window there nor to a new one: the tab stays where it is.
        assert!(!core.move_tab(&w1, &w2, &key));
        let w3 = core.join(&path).unwrap();
        let tab = json!({ "kind": "memo", "memoId": "b" });
        let refused = core
            .adopt_tab(&w3, &w1, tab.clone(), key.clone())
            .unwrap_err();
        // The page says so in words: a code of its own, not the message.
        assert_eq!(commands::CommandError::from(refused).code, "window-busy");
        assert_eq!(layouts(&core, &path), vec![layout]);
        assert_eq!(
            core.claim_tabs(&w2, &[memo_b()]).unwrap(),
            vec![Err(w1.clone())]
        );
        core.cancel_flush(id);
        assert!(core.move_tab(&w1, &w2, &key));
    }

    #[test]
    fn a_tab_let_go_over_a_window_not_yet_started_gets_a_window_of_its_own() {
        use crate::app::windows::{window_at, ScreenPoint, WindowSpot};
        use crate::session::WindowFrame;
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let path = core.path_of(&w1).unwrap();
        let behind = attach(&core, &path);
        core.page_started(&w1);
        core.page_started(&behind);
        // In front of `behind`, the most recently opened: the tab must not go through it.
        let front = attach(&core, &path);
        let frame = WindowFrame {
            x: 100.0,
            y: 100.0,
            width: 900.0,
            height: 600.0,
        };
        let candidates = core.drop_candidates(&w1);
        let spots: Vec<WindowSpot> = candidates
            .iter()
            .map(|candidate| WindowSpot {
                label: &candidate.label,
                frame,
                same_workspace: candidate.same_workspace,
                leaving: candidate.leaving,
            })
            .collect();
        assert_eq!(spots[0].label, front);
        assert_eq!(
            window_at(&spots, ScreenPoint { x: 500.0, y: 400.0 }, &w1),
            None
        );
    }

    /// A workspace named `name` beside the open ones, not open, its session file holding
    /// `layouts`.
    fn closed_workspace(core: &AppCore, name: &str, layouts: &[serde_json::Value]) -> PathBuf {
        let workspace = Workspace::create(&core.workspace_root(), name).unwrap();
        let path = workspace.root().to_path_buf();
        crate::session::write_layouts(&path, &core.machine.device_id, layouts).unwrap();
        path
    }

    fn a_sh() -> TabRef {
        TabRef::External {
            path: PathBuf::from("/tmp/a.sh"),
        }
    }

    fn switch(core: &AppCore, label: &str, to: &Path) {
        let opened = core.prepare_switch(label, to).unwrap();
        core.switch_window(label, to, opened).unwrap();
    }

    #[test]
    fn switching_the_last_window_keeps_the_left_layout() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let ga = core.path_of(&w1).unwrap();
        let other = open(&core, "다");
        let da = core.path_of(&other).unwrap();
        let (a1, b0) = (json!({"focusedPane": 1}), json!({"focusedPane": 0}));
        core.set_layout(&w1, a1.clone()).unwrap();
        assert_eq!(core.claim_tabs(&w1, &[a_sh()]).unwrap(), vec![Ok(())]);
        let na = closed_workspace(&core, "나", std::slice::from_ref(&b0));

        switch(&core, &w1, &na);
        assert_eq!(layouts(&core, &ga), vec![a1]);
        let shown = core.workspace(&w1).unwrap();
        assert_eq!(lock(&shown).root(), na.as_path());
        assert_eq!(core.layout_of(&w1), Some(b0));
        assert!(!core.is_open_path(&ga));
        // In place: the window keeps its spot among the windows to reopen.
        assert_eq!(saved(&core).open_windows, vec![na.clone(), da]);
        assert_eq!(core.claim_tabs(&other, &[a_sh()]).unwrap(), vec![Ok(())]);
    }

    #[test]
    fn switching_away_from_a_shared_workspace_drops_the_left_layout() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let ga = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &ga);
        let (a, b) = (json!({"focusedPane": 0}), json!({"focusedPane": 1}));
        core.set_layout(&w1, a).unwrap();
        core.set_layout(&w2, b.clone()).unwrap();
        let na = closed_workspace(&core, "나", &[]);

        switch(&core, &w1, &na);
        assert_eq!(layouts(&core, &ga), vec![b]);
        assert!(core.is_open_path(&ga));
        assert_eq!(core.windows_of(&ga), vec![w2]);
        assert_eq!(core.windows_of(&na), vec![w1.clone()]);
        assert_eq!(core.layout_of(&w1), None);
    }

    #[test]
    fn switching_to_a_vanished_workspace_leaves_the_window_where_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let ga = core.path_of(&w1).unwrap();
        let a1 = json!({"focusedPane": 1});
        core.set_layout(&w1, a1.clone()).unwrap();
        assert_eq!(core.claim_tabs(&w1, &[a_sh()]).unwrap(), vec![Ok(())]);
        let na = closed_workspace(&core, "나", &[]);
        fs::remove_dir_all(&na).unwrap();

        assert!(matches!(
            core.prepare_switch(&w1, &na),
            Err(SwitchError::Open(_))
        ));
        assert_eq!(core.path_of(&w1), Some(ga.clone()));
        assert_eq!(core.layout_of(&w1), Some(a1.clone()));
        assert_eq!(layouts(&core, &ga), vec![a1]);
        assert_eq!(saved(&core).open_windows, vec![ga.clone()]);
        let w2 = attach(&core, &ga);
        assert_eq!(core.claim_tabs(&w2, &[a_sh()]).unwrap(), vec![Err(w1)]);
        // Nothing is left claimed for the folder.
        assert!(core.reserve(&na).is_ok());
    }

    #[test]
    fn a_switch_to_a_workspace_opened_meanwhile_focuses_it() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let ga = core.path_of(&w1).unwrap();
        // While w1 wrote its tabs, a `tote` request opened 나 in a window of its own.
        let w2 = open(&core, "나");
        let na = core.path_of(&w2).unwrap();
        assert!(matches!(
            core.prepare_switch(&w1, &na),
            Err(SwitchError::Shown(label)) if label == w2
        ));
        // Or is opening one right now.
        let da = closed_workspace(&core, "다", &[]);
        let opening = core.reserve(&da).unwrap();
        assert!(matches!(
            core.prepare_switch(&w1, &da),
            Err(SwitchError::Shown(label)) if label == opening
        ));
        assert_eq!(core.path_of(&w1), Some(ga));
        assert_eq!(core.windows_of(&na), vec![w2]);
    }

    #[test]
    fn a_switch_to_a_workspace_shown_elsewhere_targets_that_window() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let ga = core.path_of(&w1).unwrap();
        let w2 = attach(&core, &ga);
        let w3 = open(&core, "나");
        let na = core.path_of(&w3).unwrap();
        let da = closed_workspace(&core, "다", &[]);
        // Its own workspace: nothing to do, though another window shows it too.
        assert_eq!(core.switch_target(&w1, &ga), SwitchTarget::Stay);
        assert_eq!(
            core.switch_target(&w1, &na),
            SwitchTarget::Focus(w3.clone())
        );
        assert_eq!(core.switch_target(&w3, &ga), SwitchTarget::Focus(w2));
        assert_eq!(core.switch_target(&w1, &da), SwitchTarget::Open);
    }

    fn request_for(name: &str) -> CliRequest {
        CliRequest {
            workspace: Some(name.into()),
            files: vec![PathBuf::from("/tmp/a.md")],
            import: true,
            stdin_file: None,
        }
    }

    #[test]
    fn a_request_during_a_switch_waits_for_its_end() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let w2 = closed_workspace(&core, "나", &[]);
        let opened = core.prepare_switch(&a, &w2).unwrap();

        // `handle` finds the switching window as the label of the target (`reserve` names it).
        assert!(core.is_switching(&a));
        assert_eq!(core.hold_request(&a, request_for("나")), Ok(()));
        let mut second = request_for("나");
        second.files = vec![PathBuf::from("/tmp/b.md")];
        assert_eq!(core.hold_request(&a, second.clone()), Ok(()));
        core.switch_window(&a, &w2, opened).unwrap();

        let held = core.finish_switch(&a);
        assert_eq!(held, vec![request_for("나"), second]);
        assert!(!core.is_switching(&a));
        assert!(core.finish_switch(&a).is_empty());
        // Handled again, the window shows the target: nothing holds them, and each lands there.
        assert_eq!(core.path_of(&a), Some(w2));
        for request in held {
            let request = core.hold_request(&a, request).unwrap_err();
            for path in request.files {
                core.push_pending(&a, PendingOpen::External { path });
            }
        }
        core.page_started(&a);
        assert_eq!(
            core.take_pending(&a),
            vec![
                PendingOpen::External {
                    path: "/tmp/a.md".into()
                },
                PendingOpen::External {
                    path: "/tmp/b.md".into()
                }
            ]
        );
    }

    #[test]
    fn a_request_held_for_a_window_that_goes_is_not_lost() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "다");
        let na = closed_workspace(&core, "나", &[]);
        core.prepare_switch(&a, &na).unwrap();
        assert_eq!(core.hold_request(&a, request_for("나")), Ok(()));

        core.closed(&a);

        // The switch ends for a window gone: what it held comes back for `handle` to place by
        // its own rules (another window, or none at all).
        assert_eq!(core.finish_switch(&a), vec![request_for("나")]);
        assert_eq!(core.latest_window(), Some(b));
        assert_eq!(
            core.hold_request(&a, request_for("나")),
            Err(request_for("나"))
        );
    }

    #[test]
    fn a_failed_open_ends_the_switch_and_frees_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let ga = core.path_of(&a).unwrap();
        let gone = closed_workspace(&core, "나", &[]);
        fs::remove_dir_all(&gone).unwrap();
        let opening = core.prepare_switch(&a, &gone);
        assert!(matches!(opening, Err(SwitchError::Open(_))));

        // A request that came now is the window's own to handle again, by the usual rules.
        assert!(!core.is_switching(&a));
        assert_eq!(
            core.hold_request(&a, request_for("나")),
            Err(request_for("나"))
        );
        assert_eq!(core.path_of(&a), Some(ga));
        assert!(core.reserve(&gone).is_ok());
    }

    #[test]
    fn a_window_is_leaving_while_it_switches_or_closes() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let na = closed_workspace(&core, "나", &[]);
        assert!(!core.window_is_leaving(&a));

        let opened = core.prepare_switch(&a, &na).unwrap();
        assert!(core.window_is_leaving(&a));
        core.switch_window(&a, &na, opened).unwrap();
        // The old page is still up until the new one asks for its workspace.
        core.finish_switch(&a);
        assert!(core.window_is_leaving(&a));
        core.page_started(&a);
        assert!(!core.window_is_leaving(&a));

        core.closing(&a);
        assert!(core.window_is_leaving(&a));
        core.close_failed(&a);
        assert!(!core.window_is_leaving(&a));
    }

    #[test]
    fn a_window_round_that_times_out_marks_its_window_leaving_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let na = closed_workspace(&core, "나", &[]);
        let switch = FlushGoal::SwitchWorkspace {
            label: a.clone(),
            to: na.clone(),
        };

        // Before `finish` marks the window itself, a late answer must find it going.
        let Begin::Started { id, .. } = core.begin_flush(switch.clone()) else {
            panic!("expected a round")
        };
        assert_eq!(core.expire_flush(id), Ack::Done(switch.clone()));
        assert!(core.window_is_leaving(&a));
        // The switch ends without `prepare_switch` — another window shows the target.
        core.finish_switch(&a);
        assert!(!core.window_is_leaving(&a));

        // A quit joined to it: the switch is carried out first.
        let Begin::Started { id, .. } = core.begin_flush(switch.clone()) else {
            panic!("expected a round")
        };
        assert_eq!(core.begin_flush(FlushGoal::Quit), Begin::AlreadyRunning);
        assert_eq!(core.expire_flush(id), Ack::DoneThenQuit(switch));
        assert!(core.window_is_leaving(&a));
        core.finish_switch(&a);
        assert!(!core.window_is_leaving(&a));

        let close = FlushGoal::CloseWindow(a.clone());
        let Begin::Started { id, .. } = core.begin_flush(close.clone()) else {
            panic!("expected a round")
        };
        assert_eq!(core.expire_flush(id), Ack::Done(close));
        assert!(core.window_is_leaving(&a));
        core.close_failed(&a);
        assert!(!core.window_is_leaving(&a));
    }

    #[test]
    fn pending_opens_wait_while_the_window_switches() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let na = closed_workspace(&core, "나", &[]);
        let opened = core.prepare_switch(&a, &na).unwrap();
        let memo = PendingOpen::Memo { id: "m".into() };
        core.push_pending(&a, memo.clone());
        assert!(core.take_pending(&a).is_empty());

        // After the core switch, until the new page asks for its workspace.
        core.switch_window(&a, &na, opened).unwrap();
        core.finish_switch(&a);
        core.push_pending(&a, memo.clone());
        assert!(core.take_pending(&a).is_empty());
        core.page_started(&a);
        assert_eq!(core.take_pending(&a), vec![memo]);
    }

    #[test]
    fn a_switch_to_a_window_gone_frees_its_reservation() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let na = closed_workspace(&core, "나", &[]);
        let opened = core.prepare_switch(&a, &na).unwrap();
        core.closed(&a);

        let err = core.switch_window(&a, &na, opened).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(core.reserve(&na).is_ok());
    }

    #[test]
    fn watching_and_tokens_are_refused_while_switching() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let na = closed_workspace(&core, "나", &[]);
        assert!(core.ensure_writable(&a).is_ok());
        switch(&core, &a, &na);

        // `watch_external` and `issue_file_token` ask this before they bind the old page.
        let err = core.ensure_writable(&a).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        core.page_started(&a);
        assert!(core.ensure_writable(&a).is_ok());
    }

    #[test]
    fn a_switched_window_refuses_writes_until_its_page_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let b0 = json!({"focusedPane": 0});
        let na = closed_workspace(&core, "나", std::slice::from_ref(&b0));
        switch(&core, &w1, &na);

        // The page of 가 is still up until the reload: what it writes is not 나's.
        assert!(core.workspace_to_change(&w1).is_err());
        assert!(core.set_layout(&w1, json!({"focusedPane": 9})).is_err());
        assert!(core.claim_tabs(&w1, &[a_sh()]).is_err());
        assert_eq!(layouts(&core, &na), vec![b0.clone()]);
        // Reads still go: the old page lists what it lists, harmlessly.
        assert!(core.workspace(&w1).is_some());

        // A late `read_window_layout` from the old page — still restoring when the switch began —
        // does not let it write.
        assert_eq!(core.layout_of(&w1), Some(b0.clone()));
        assert!(core.workspace_to_change(&w1).is_err());
        assert_eq!(layouts(&core, &na), vec![b0]);

        // The new page asks for its workspace first thing (`workspace_info`).
        core.page_started(&w1);
        assert!(core.workspace_to_change(&w1).is_ok());
        assert_eq!(core.claim_tabs(&w1, &[a_sh()]).unwrap(), vec![Ok(())]);
        let b1 = json!({"focusedPane": 1});
        core.set_layout(&w1, b1.clone()).unwrap();
        assert_eq!(layouts(&core, &na), vec![b1]);
    }

    #[test]
    fn a_quit_cancelled_after_a_switch_leaves_the_window_writable_once_its_page_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let w2 = open(&core, "다");
        let na = closed_workspace(&core, "나", &[]);
        // The switch round ended with a quit joined to it: the switch is carried out, then the
        // quit begins while the switched page reloads.
        switch(&core, &w1, &na);
        let Begin::Started { id, windows } = core.begin_flush(FlushGoal::Quit) else {
            panic!("expected a quit round")
        };
        assert_eq!(windows, vec![w2.clone()]);
        // Another window's save failed, and the person cancels the quit.
        let blocked = Some("저장하지 못한 메모 1개".to_string());
        assert!(matches!(
            core.ack_flush(id, &w2, blocked),
            Ack::Blocked { .. }
        ));
        core.cancel_flush(id);
        assert!(!core.is_quitting());
        // The reloaded page of 나 comes up and writes into 나.
        core.page_started(&w1);
        let b1 = json!({"focusedPane": 1});
        core.set_layout(&w1, b1.clone()).unwrap();
        assert_eq!(layouts(&core, &na), vec![b1]);
    }

    #[test]
    fn a_quit_while_a_switched_page_loads_reopens_it_on_its_new_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let w1 = open(&core, "가");
        let ga = core.path_of(&w1).unwrap();
        let a1 = json!({"focusedPane": 1});
        core.set_layout(&w1, a1.clone()).unwrap();
        let b0 = json!({"focusedPane": 0});
        let na = closed_workspace(&core, "나", std::slice::from_ref(&b0));
        switch(&core, &w1, &na);
        // Its page has nothing to write and may not answer: the quit does not wait on it.
        assert_eq!(
            core.begin_flush(FlushGoal::Quit),
            Begin::Done(FlushGoal::Quit)
        );
        core.start_quit();
        assert_eq!(saved(&core).open_windows, vec![na.clone()]);
        assert_eq!(layouts(&core, &na), vec![b0]);
        assert_eq!(layouts(&core, &ga), vec![a1]);
    }
}
