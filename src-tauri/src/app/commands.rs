//! The commands the frontend invokes (src/backend/tauri.ts). File contents travel as raw bytes
//! (Tauri's binary IPC); names and paths go in percent-encoded headers, never inside JSON strings.

use std::borrow::Cow;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow};

use super::places::TabRef;
use super::{lifecycle, lock, menu, update, windows, AppCore, PendingOpen};
use crate::appdata::{shown_from_home, Settings, SettingsPatch};
use crate::backup::versions::{self, Version};
use crate::backup::BackupDir;
use crate::extensions::file_inside;
use crate::extensions::install::{self, InstallError};
use crate::extensions::registry::{ExtensionSummary, Registry};
use crate::files::text::{self, SearchError, TextQuery, TextScan, TextSearch};
use crate::files::{self, FileSource};
use crate::perf::{self, PerfConfig};
use crate::persist::external::ExternalInfo;
use crate::search::{self, SearchEvent, SearchQuery};
use crate::shortcuts::{self, ShortcutTable};
use crate::workspace::order::{self, Arranged, Entry, WorkspaceOrder};
use crate::workspace::{MemoInfo, Workspace, WorkspaceError};

/// What a rejected command returns. `code` is what the frontend branches on (`BackendError`).
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> CommandError {
        CommandError {
            code,
            message: message.into(),
        }
    }
}

impl From<WorkspaceError> for CommandError {
    fn from(err: WorkspaceError) -> CommandError {
        let code = match &err {
            WorkspaceError::NotAWorkspace(_) => "not-a-workspace",
            WorkspaceError::AlreadyExists(_) => "already-exists",
            WorkspaceError::InvalidName(_) => "invalid-name",
            WorkspaceError::UnknownMemo(_) => "unknown-memo",
            WorkspaceError::Io(io) => io_code(io),
        };
        CommandError::new(code, err.to_string())
    }
}

impl From<io::Error> for CommandError {
    fn from(err: io::Error) -> CommandError {
        CommandError::new(io_code(&err), err.to_string())
    }
}

impl From<notify::Error> for CommandError {
    fn from(err: notify::Error) -> CommandError {
        let code = match &err.kind {
            notify::ErrorKind::Io(io) => io_code(io),
            notify::ErrorKind::PathNotFound => "not-found",
            _ => "io",
        };
        CommandError::new(code, err.to_string())
    }
}

impl From<tauri::Error> for CommandError {
    fn from(err: tauri::Error) -> CommandError {
        CommandError::new("app", err.to_string())
    }
}

fn io_code(err: &io::Error) -> &'static str {
    if err
        .get_ref()
        .is_some_and(|inner| inner.is::<super::WindowBusy>())
    {
        return "window-busy";
    }
    if crate::persist::is_not_text(err) {
        return "not-text";
    }
    match err.kind() {
        io::ErrorKind::NotFound => "not-found",
        io::ErrorKind::InvalidData | io::ErrorKind::InvalidInput => "bad-request",
        _ => "io",
    }
}

type CmdResult<T> = Result<T, CommandError>;

fn workspace_of(core: &AppCore, window: &WebviewWindow) -> CmdResult<Arc<Mutex<Workspace>>> {
    core.workspace(window.label()).ok_or_else(|| {
        CommandError::new(
            "no-workspace",
            format!("{} shows no workspace", window.label()),
        )
    })
}

/// `workspace_of` for a command that changes the workspace: `bad-request` while the window switches
/// workspaces and its page is still the old one (`AppCore::page_started`).
fn workspace_to_change(core: &AppCore, window: &WebviewWindow) -> CmdResult<Arc<Mutex<Workspace>>> {
    core.workspace_to_change(window.label())
        .map_err(|err| match err.kind() {
            io::ErrorKind::NotFound => CommandError::new("no-workspace", err.to_string()),
            _ => err.into(),
        })
}

/// The memo list of window `label`'s workspace changed: its other windows read it again
/// (`tote://memos`, gathered for 300ms on their side).
pub fn memos_changed(app: &AppHandle, label: &str) {
    for sibling in app.state::<AppCore>().siblings(label) {
        let _ = app.emit_to(EventTarget::webview_window(&sibling), "tote://memos", ());
    }
}

fn header(request: &Request<'_>, name: &str) -> CmdResult<String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| CommandError::new("bad-request", format!("missing header {name}")))?;
    percent_decode_str(raw)
        .decode_utf8()
        .map(Cow::into_owned)
        .map_err(|_| CommandError::new("bad-request", format!("header {name} is not UTF-8")))
}

fn body<'a>(request: &'a Request<'_>) -> CmdResult<&'a [u8]> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        // An empty Uint8Array may arrive as an empty JSON payload.
        InvokeBody::Json(value)
            if value.is_null() || value.as_object().is_some_and(|o| o.is_empty()) =>
        {
            Ok(&[])
        }
        InvokeBody::Json(_) => Err(CommandError::new("bad-request", "expected raw bytes")),
    }
}

/// External paths come from the person (dialog, drop, `tote`); a relative one is a bug.
fn absolute_path(path: &str) -> CmdResult<PathBuf> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(CommandError::new(
            "bad-request",
            format!("not an absolute path: {}", path.display()),
        ))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    id: String,
    name: String,
    /// The window's title: the name, numbered from the workspace's second window on.
    title: String,
    path: PathBuf,
    device_id: String,
}

#[tauri::command]
pub fn workspace_info(core: State<'_, AppCore>, window: WebviewWindow) -> CmdResult<WorkspaceInfo> {
    let workspace = workspace_of(&core, &window)?;
    // A page asks for this first: after a switch, the new page is up and may write.
    core.page_started(window.label());
    // Before the workspace lock: `titles_of` takes it too.
    let title = core
        .path_of(window.label())
        .and_then(|path| {
            core.titles_of(&path)
                .into_iter()
                .find(|(label, _)| label == window.label())
        })
        .map(|(_, title)| title);
    let workspace = lock(&workspace);
    Ok(WorkspaceInfo {
        id: workspace.id().to_string(),
        title: title.unwrap_or_else(|| workspace.name()),
        name: workspace.name(),
        path: workspace.root().to_path_buf(),
        device_id: core.machine.device_id.clone(),
    })
}

// File I/O commands are async so they run off the main thread; a sync command would block the
// event loop while a large memo is written.

#[tauri::command]
pub async fn list_memos(
    core: State<'_, AppCore>,
    window: WebviewWindow,
) -> CmdResult<Vec<MemoInfo>> {
    let workspace = workspace_of(&core, &window)?;
    let list = lock(&workspace).list_memos()?;
    Ok(list)
}

#[tauri::command]
pub async fn create_memo(core: State<'_, AppCore>, window: WebviewWindow) -> CmdResult<MemoInfo> {
    let workspace = workspace_to_change(&core, &window)?;
    let info = lock(&workspace).create_memo("md", &[])?;
    memos_changed(window.app_handle(), window.label());
    Ok(info)
}

#[tauri::command]
pub async fn read_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
) -> CmdResult<Response> {
    let workspace = workspace_of(&core, &window)?;
    let bytes = lock(&workspace).read_memo(&id)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn write_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    request: Request<'_>,
) -> CmdResult<MemoInfo> {
    let id = header(&request, "x-memo-id")?;
    let workspace = workspace_to_change(&core, &window)?;
    let info = lock(&workspace).write_memo(&id, body(&request)?)?;
    memos_changed(window.app_handle(), window.label());
    Ok(info)
}

#[tauri::command]
pub async fn retitle_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
    stem: String,
) -> CmdResult<MemoInfo> {
    let workspace = workspace_to_change(&core, &window)?;
    let info = lock(&workspace).retitle_memo(&id, &stem)?;
    memos_changed(window.app_handle(), window.label());
    Ok(info)
}

#[tauri::command]
pub async fn rename_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
    file: String,
) -> CmdResult<MemoInfo> {
    let workspace = workspace_to_change(&core, &window)?;
    let info = lock(&workspace).rename_memo(&id, &file)?;
    memos_changed(window.app_handle(), window.label());
    Ok(info)
}

#[tauri::command]
pub async fn set_memo_language(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
    language: String,
    ext: String,
) -> CmdResult<MemoInfo> {
    let workspace = workspace_to_change(&core, &window)?;
    let info = lock(&workspace).set_language(&id, &language, &ext)?;
    memos_changed(window.app_handle(), window.label());
    Ok(info)
}

#[tauri::command]
pub async fn delete_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
) -> CmdResult<()> {
    let workspace = workspace_to_change(&core, &window)?;
    lock(&workspace).delete_memo(&id)?;
    memos_changed(window.app_handle(), window.label());
    Ok(())
}

#[tauri::command]
pub async fn import_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    request: Request<'_>,
) -> CmdResult<MemoInfo> {
    let name = header(&request, "x-file-name")?;
    let workspace = workspace_to_change(&core, &window)?;
    let info = lock(&workspace).import_memo(&name, body(&request)?)?;
    memos_changed(window.app_handle(), window.label());
    Ok(info)
}

#[tauri::command]
pub async fn import_file(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    path: String,
) -> CmdResult<MemoInfo> {
    let path = absolute_path(&path)?;
    let workspace = workspace_to_change(&core, &window)?;
    let info = lock(&workspace).import_file(&path)?;
    memos_changed(window.app_handle(), window.label());
    Ok(info)
}

/// The backups of the window's workspace (`backups/<workspace id>/`).
fn backup_dir(core: &AppCore, window: &WebviewWindow) -> CmdResult<BackupDir> {
    let workspace = workspace_of(core, window)?;
    let id = lock(&workspace).id().to_string();
    Ok(BackupDir::new(&core.paths.backups_dir(), &id))
}

#[tauri::command]
pub async fn list_versions(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
) -> CmdResult<Vec<Version>> {
    let dir = backup_dir(&core, &window)?;
    blocking(move || Ok(versions::list(&dir, &id)?)).await
}

#[tauri::command]
pub async fn read_version(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    snapshot: String,
    file: String,
) -> CmdResult<Response> {
    let dir = backup_dir(&core, &window)?;
    Ok(Response::new(versions::read(&dir, &snapshot, &file)?))
}

#[tauri::command]
pub async fn reveal_backups(core: State<'_, AppCore>, window: WebviewWindow) -> CmdResult<()> {
    let dir = backup_dir(&core, &window)?;
    Ok(versions::reveal(&dir)?)
}

/// This window's layout for the session (`WindowSession`), or `None` for a window that starts with
/// no tabs: one of its own, or one the session had no layout for.
#[tauri::command]
pub fn read_window_layout(core: State<'_, AppCore>, window: WebviewWindow) -> Option<String> {
    core.layout_of(window.label())
        .map(|layout| layout.to_string())
}

/// Writes this window's layout into its workspace's session file, with the other windows' layouts.
/// `bad-request` when `json` is not a JSON object, or while the window switches workspaces.
#[tauri::command]
pub async fn write_window_layout(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    json: String,
) -> CmdResult<()> {
    workspace_of(&core, &window)?;
    core.set_layout(window.label(), layout_from_json(&json)?)?;
    Ok(())
}

fn layout_from_json(json: &str) -> CmdResult<serde_json::Value> {
    match serde_json::from_str(json) {
        Ok(layout @ serde_json::Value::Object(_)) => Ok(layout),
        _ => Err(CommandError::new(
            "bad-request",
            "a window layout is a JSON object",
        )),
    }
}

/// Claims `tabs` for this window before it shows them, one answer each: false when another
/// window has the tab. With `reveal`, that window comes forward and shows the tab
/// (`tote://reveal`). `bad-request` while the window switches workspaces.
#[tauri::command]
pub fn claim_tabs(
    app: AppHandle,
    core: State<'_, AppCore>,
    window: WebviewWindow,
    tabs: Vec<TabRef>,
    reveal: bool,
) -> CmdResult<Vec<bool>> {
    let claims = core.claim_tabs(window.label(), &tabs)?;
    for (tab, claim) in tabs.iter().zip(&claims) {
        if let (Err(owner), true) = (claim, reveal) {
            windows::focus(&app, owner);
            let _ = app.emit_to(EventTarget::webview_window(owner), "tote://reveal", tab);
        }
    }
    Ok(claims.iter().map(Result::is_ok).collect())
}

/// This window closed the tab: another may open it.
#[tauri::command]
pub fn release_tab(core: State<'_, AppCore>, window: WebviewWindow, tab: TabRef) {
    core.release_tab(window.label(), &tab);
}

/// Where `tear_off_tab` put the tab.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TornOff {
    /// Into the window of this workspace it was let go on, which gets `tote://adopt`.
    Moved,
    /// Into a new window.
    Window,
}

/// What `tote://adopt` hands the window a tab was let go on: the tab's session entry, as the JSON
/// the page sent, and where it was let go, from the window's top-left corner
/// (`windows::to_window_point`).
#[derive(Clone, Serialize)]
struct Adopt {
    tab: String,
    x: f64,
    y: f64,
}

/// Moves this window's tab `tab_ref` out of it. `tab` is its session entry (`SessionTab`), what the
/// window taking it opens; `bad-request` when it is not a JSON object.
///
/// Without `at` the tab goes into a new window of the workspace, a little off this one. With `at`,
/// the screen point it was let go on outside this window, it joins the window of this workspace
/// there (`windows::drop_target`), else a new window opens with its corner there. Before the new
/// window is made the tab is in the session and its place is the window's; when it cannot be made
/// the tab stays here.
#[tauri::command]
pub async fn tear_off_tab(
    app: AppHandle,
    core: State<'_, AppCore>,
    window: WebviewWindow,
    tab: String,
    tab_ref: TabRef,
    at: Option<windows::ScreenPoint>,
) -> CmdResult<TornOff> {
    let entry = match serde_json::from_str(&tab) {
        Ok(entry @ serde_json::Value::Object(_)) => entry,
        _ => return Err(CommandError::new("bad-request", "a tab is a JSON object")),
    };
    let label = window.label();
    let (Some(path), Some(key)) = (core.path_of(label), core.key_for(label, &tab_ref)) else {
        return Err(CommandError::new(
            "no-workspace",
            format!("{label} shows no workspace"),
        ));
    };
    let source = windows::frame_of(&window);
    let near = match at {
        None => source.map(|f| windows::cascade(f, &windows::monitor_rects(&app))),
        Some(at) => {
            let at = windows::screen_point(at);
            // A target that began to leave since it was picked takes nothing (`move_tab`): the tab
            // gets a window of its own instead.
            if let Some((target, frame)) = windows::drop_target(&app, label, at) {
                if core.move_tab(label, &target, &key) {
                    let (x, y) = windows::to_window_point(at, frame);
                    // As a tab dragged to another browser window: that window comes forward, the
                    // tab shown in it.
                    windows::focus(&app, &target);
                    let _ = app.emit_to(
                        EventTarget::webview_window(&target),
                        "tote://adopt",
                        Adopt { tab, x, y },
                    );
                    return Ok(TornOff::Moved);
                }
            }
            source.map(|f| windows::frame_at(at, f))
        }
    };
    let plan = windows::WindowPlan::Tab {
        tab: entry,
        near,
        from: label.to_string(),
        key,
    };
    windows::open_window(&app, &path, plan)?;
    Ok(TornOff::Window)
}

/// Shows a tab's context menu at the pointer: the id of the item picked, `None` when it closed
/// without a pick.
#[tauri::command]
pub async fn show_tab_menu(
    app: AppHandle,
    window: WebviewWindow,
    items: Vec<menu::TabMenuItem>,
) -> CmdResult<Option<String>> {
    // The menu blocks its thread while it is open; not one of the async runtime's.
    let picked =
        tauri::async_runtime::spawn_blocking(move || menu::show_tab_menu(&app, &window, &items))
            .await
            .map_err(|err| CommandError::new("app", err.to_string()))??;
    Ok(picked)
}

#[tauri::command]
pub fn take_pending_opens(core: State<'_, AppCore>, window: WebviewWindow) -> Vec<PendingOpen> {
    core.take_pending(window.label())
}

#[tauri::command]
pub async fn open_external(core: State<'_, AppCore>, path: String) -> CmdResult<ExternalInfo> {
    Ok(core.external.open(&absolute_path(&path)?)?)
}

#[tauri::command]
pub async fn read_external(core: State<'_, AppCore>, path: String) -> CmdResult<Response> {
    Ok(Response::new(core.external.read(&absolute_path(&path)?)?))
}

#[tauri::command]
pub async fn read_external_draft(core: State<'_, AppCore>, path: String) -> CmdResult<Response> {
    Ok(Response::new(
        core.external.read_draft(&absolute_path(&path)?)?,
    ))
}

#[tauri::command]
pub async fn keep_external_draft(core: State<'_, AppCore>, request: Request<'_>) -> CmdResult<()> {
    let path = absolute_path(&header(&request, "x-path")?)?;
    core.external.keep_draft(&path, body(&request)?)?;
    Ok(())
}

#[tauri::command]
pub async fn discard_external_draft(core: State<'_, AppCore>, path: String) -> CmdResult<()> {
    core.external.discard_draft(&absolute_path(&path)?)?;
    Ok(())
}

#[tauri::command]
pub async fn save_external(core: State<'_, AppCore>, request: Request<'_>) -> CmdResult<u64> {
    let path = absolute_path(&header(&request, "x-path")?)?;
    Ok(core.external.save(&path, body(&request)?)?)
}

/// The window shows the external file at `path`: what other apps do to it comes as
/// `tote://outside`. Each call needs an `unwatch_external`.
#[tauri::command]
pub async fn watch_external(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    path: String,
) -> CmdResult<()> {
    core.ensure_writable(window.label())?;
    core.watch_external(window.label(), &absolute_path(&path)?)?;
    Ok(())
}

#[tauri::command]
pub async fn unwatch_external(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    path: String,
) -> CmdResult<()> {
    core.unwatch_external(window.label(), &absolute_path(&path)?);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListItem {
    name: String,
    path: PathBuf,
    open: bool,
    /// How many windows show it.
    windows: usize,
    /// In the recent list, but its folder or `.tote/workspace.json` is gone.
    missing: bool,
    /// Its place in the set order, from 0, the hidden ones counted too, so not its ⌃ number.
    /// `None` when `missing`.
    order: Option<usize>,
    hidden: bool,
    /// Its ID can be read, so the order file can name it.
    orderable: bool,
}

/// The workspaces under `root` (`arranged`, in their places), most recently used first, then the
/// recent ones that vanished. Recent order is what 「워크스페이스 열기…」 shows; the switcher
/// sorts by `order`. `windows` counts the windows showing a workspace.
fn workspace_items(
    arranged: Vec<Arranged>,
    recent: &[PathBuf],
    windows: impl Fn(&Path) -> usize,
) -> Vec<WorkspaceListItem> {
    let mut list: Vec<WorkspaceListItem> = arranged
        .into_iter()
        .enumerate()
        .map(|(place, a)| {
            let path = std::fs::canonicalize(&a.summary.path).unwrap_or(a.summary.path);
            let windows = windows(&path);
            WorkspaceListItem {
                open: windows > 0,
                windows,
                name: a.summary.name,
                path,
                missing: false,
                order: Some(place),
                hidden: a.hidden,
                orderable: a.id.is_some(),
            }
        })
        .collect();
    // `arranged` comes in switcher order; this list keeps its own: most recently used first, the
    // rest by name (both sorts are stable).
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list.sort_by_key(|item| {
        recent
            .iter()
            .position(|p| *p == item.path)
            .unwrap_or(usize::MAX)
    });
    let gone = recent
        .iter()
        .filter(|path| !Workspace::is_workspace(path) && !list.iter().any(|i| i.path == **path))
        .map(|path| WorkspaceListItem {
            name: path
                .file_name()
                .map_or_else(|| path.to_string_lossy(), |n| n.to_string_lossy())
                .into_owned(),
            path: path.clone(),
            open: false,
            windows: 0,
            missing: true,
            order: None,
            hidden: false,
            orderable: false,
        })
        .collect::<Vec<_>>();
    list.extend(gone);
    list
}

#[tauri::command]
pub async fn list_workspaces(core: State<'_, AppCore>) -> CmdResult<Vec<WorkspaceListItem>> {
    Ok(workspace_items(
        order::arranged(&core.workspace_root()),
        &core.recent(),
        |path| core.windows_of(path).len(),
    ))
}

/// What the order file says of each of `paths`: its ID with its folder name. A path whose ID cannot
/// be read (not a workspace, or its `workspace.json` is unreadable) is left out.
fn entries(paths: &[PathBuf]) -> Vec<Entry> {
    paths
        .iter()
        .filter_map(|path| {
            Some(Entry {
                id: Workspace::read_id(path)?,
                name: path.file_name()?.to_str()?.to_owned(),
            })
        })
        .collect()
}

/// Saves where each workspace under the root sits in the switcher and which are hidden; every
/// window's switcher follows.
#[tauri::command]
pub async fn set_workspace_order(
    app: AppHandle,
    core: State<'_, AppCore>,
    order: Vec<PathBuf>,
    hidden: Vec<PathBuf>,
) -> CmdResult<()> {
    order::save(
        &core.workspace_root(),
        &WorkspaceOrder {
            order: entries(&order),
            hidden: entries(&hidden),
        },
    )?;
    let _ = app.emit("tote://workspaces", ());
    Ok(())
}

/// The workspace that was at `from` is now at `to`: the recent list and the windows to reopen
/// follow it, and it opens.
#[tauri::command]
pub async fn relocate_workspace(
    app: AppHandle,
    core: State<'_, AppCore>,
    from: String,
    to: String,
) -> CmdResult<()> {
    let from = absolute_path(&from)?;
    let to = std::fs::canonicalize(absolute_path(&to)?)?;
    if !Workspace::is_workspace(&to) {
        return Err(CommandError::new(
            "not-a-workspace",
            format!("{} is not a tote workspace", to.display()),
        ));
    }
    core.relocate(&from, &to);
    windows::show(&app, &to)?;
    Ok(())
}

/// Makes a workspace under the workspace root and returns its folder; no window opens on it (the
/// window that asked switches to it).
#[tauri::command]
pub async fn create_workspace(
    app: AppHandle,
    core: State<'_, AppCore>,
    name: String,
) -> CmdResult<PathBuf> {
    let workspace = Workspace::create(&core.workspace_root(), &name)?;
    let path = std::fs::canonicalize(workspace.root())?;
    // The other windows' rails list it.
    let _ = app.emit("tote://workspaces", ());
    Ok(path)
}

/// This window shows the workspace at `path` (`windows::switch`): `"focused"` when it shows it
/// already or another window showing it came forward, `"switching"` when this window writes its
/// tabs and then reloads on it.
#[tauri::command]
pub async fn switch_workspace(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
) -> CmdResult<&'static str> {
    let switched = windows::switch(&app, window.label(), &absolute_path(&path)?)?;
    Ok(match switched {
        windows::Switched::Focused => "focused",
        windows::Switched::Switching => "switching",
    })
}

#[tauri::command]
pub async fn open_workspace(app: AppHandle, path: String) -> CmdResult<()> {
    windows::show(&app, &absolute_path(&path)?)?;
    Ok(())
}

#[tauri::command]
pub async fn flush_done(
    app: AppHandle,
    window: WebviewWindow,
    id: u64,
    blocked: Option<String>,
) -> CmdResult<bool> {
    Ok(lifecycle::ack(&app, id, window.label(), blocked))
}

/// How far `install_update` is, for the page's progress line.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateProgress {
    Progress { done: u64, total: Option<u64> },
    Installing,
}

/// Downloads and installs the update the page was offered — only ever after the person said
/// 「업데이트하고 다시 시작」 there. The running tote stays as it is until `restart_for_update`.
#[tauri::command]
pub async fn install_update(app: AppHandle, on_progress: Channel<UpdateProgress>) -> CmdResult<()> {
    let updates = app.state::<update::Updates>();
    let found = updates.begin_install().map_err(|code| {
        let message = match code {
            "installing" => "다른 창에서 업데이트를 받는 중입니다",
            _ => "설치할 업데이트가 없습니다",
        };
        CommandError::new(code, message)
    })?;
    // Installed in this run already: nothing to download, the restart is next.
    let Some(found) = found else {
        return Ok(());
    };
    let mut done = 0u64;
    let installed = found
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                let _ = on_progress.send(UpdateProgress::Progress { done, total });
            },
            || {
                let _ = on_progress.send(UpdateProgress::Installing);
            },
        )
        .await;
    updates.end_install(installed.is_ok());
    installed.map_err(|err| CommandError::new("update-failed", err.to_string()))
}

/// The update found and how far it is now, for the sidebar's button as it is pressed: another
/// window may have begun downloading it, or installed it, since the button went up. `None`
/// before one is found.
#[tauri::command]
pub fn current_update(app: AppHandle) -> Option<update::UpdateOffer> {
    update::current_offer(&app)
}

/// Writes every window, then starts the installed version (`lifecycle::begin_restart`).
#[tauri::command]
pub fn restart_for_update(app: AppHandle) -> CmdResult<()> {
    let installed = app.state::<update::Updates>().installed();
    update::try_restart(installed, || lifecycle::begin_restart(&app)).map_err(|code| {
        let message = match code {
            "busy" => "다른 창이 저장하는 중입니다",
            _ => "이번 실행에서 설치한 업데이트가 없습니다",
        };
        CommandError::new(code, message)
    })
}

#[tauri::command]
pub async fn close_window(window: WebviewWindow) -> CmdResult<()> {
    window.close()?;
    Ok(())
}

impl From<InstallError> for CommandError {
    fn from(err: InstallError) -> CommandError {
        let code = match &err {
            InstallError::AlreadyInstalled { .. } => "already-installed",
            InstallError::Invalid(_) => "invalid-extension",
            InstallError::NotInstalled(_) => "not-found",
            InstallError::Io(io) => io_code(io),
        };
        CommandError::new(code, err.to_string())
    }
}

/// Settings or the extension set changed: every window re-reads both.
fn broadcast_config(app: &AppHandle) {
    let _ = app.emit("tote://config", ());
}

#[tauri::command]
pub fn extension_registry(core: State<'_, AppCore>) -> Registry {
    core.registry()
}

#[tauri::command]
pub async fn read_extension_file(
    core: State<'_, AppCore>,
    extension_id: String,
    path: String,
) -> CmdResult<Response> {
    let root = core
        .extension_path(&extension_id)
        .ok_or_else(|| CommandError::new("not-found", format!("no extension {extension_id}")))?;
    let file = file_inside(&root, &path)
        .ok_or_else(|| CommandError::new("not-found", format!("{extension_id}: {path}")))?;
    Ok(Response::new(std::fs::read(file)?))
}

#[tauri::command]
pub async fn install_extension(
    app: AppHandle,
    core: State<'_, AppCore>,
    path: String,
    replace: bool,
) -> CmdResult<ExtensionSummary> {
    let installed = install::install(&core.extensions, &absolute_path(&path)?, replace)?;
    core.rescan_extensions();
    broadcast_config(&app);
    let id = installed.manifest.id();
    core.registry()
        .extensions
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| CommandError::new("app", "installed extension did not register"))
}

#[tauri::command]
pub async fn remove_extension(
    app: AppHandle,
    core: State<'_, AppCore>,
    id: String,
) -> CmdResult<()> {
    install::remove(&core.extensions, &id)?;
    // The folders are gone: the registry and the windows learn it even if saving fails.
    core.rescan_extensions();
    broadcast_config(&app);
    core.modify_settings(|settings| settings.extensions.disabled.retain(|d| *d != id))?;
    broadcast_config(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_extension_enabled(
    app: AppHandle,
    core: State<'_, AppCore>,
    id: String,
    enabled: bool,
) -> CmdResult<()> {
    core.modify_settings(|settings| {
        settings.extensions.disabled.retain(|d| *d != id);
        if !enabled {
            settings.extensions.disabled.push(id);
        }
    })?;
    broadcast_config(&app);
    Ok(())
}

#[tauri::command]
pub fn get_settings(core: State<'_, AppCore>) -> Settings {
    core.settings()
}

/// The workspace root in use and the one an unset `workspaceRoot` means, for the settings screen:
/// the default as its placeholder, the root in use as where its folder dialog opens.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoots {
    current: PathBuf,
    default: PathBuf,
    default_shown: String,
}

#[tauri::command]
pub fn workspace_roots(core: State<'_, AppCore>) -> WorkspaceRoots {
    let default = core.paths.default_workspace_root.clone();
    WorkspaceRoots {
        current: core.workspace_root(),
        default_shown: shown_from_home(&default, dirs::home_dir().as_deref()),
        default,
    }
}

#[tauri::command]
pub async fn patch_settings(
    app: AppHandle,
    core: State<'_, AppCore>,
    patch: SettingsPatch,
) -> CmdResult<()> {
    let shortcuts_changed = patch.shortcuts.is_some();
    let root_changed = patch.workspace_root.is_some();
    core.patch_settings(patch)?;
    if shortcuts_changed {
        menu::follow_settings(&app);
    }
    broadcast_config(&app);
    if root_changed {
        // Each root has its own order file: the switchers list the new root's workspaces.
        let _ = app.emit("tote://workspaces", ());
    }
    Ok(())
}

#[tauri::command]
pub fn shortcut_table(core: State<'_, AppCore>) -> ShortcutTable {
    shortcuts::table(&core.settings().shortcuts)
}

/// The settings screen of `window` records a shortcut (`on`) or is done: the menu's shortcuts come
/// off meanwhile. Done from another window leaves them off for the one recording.
#[tauri::command]
pub fn suspend_shortcuts(app: AppHandle, window: WebviewWindow, on: bool) {
    let label = window.label().to_string();
    menu::change_shortcuts(&app, move |menu| {
        if on {
            menu.suspend(&label);
        } else {
            menu.resume_if(&label);
        }
    });
}

/// App command `id` pressed as a key the editor of `window` has too: it runs as the menu item
/// would (spec 「무엇을 바꿀 수 있나」, its 편집기 단축키 item). `bad-request` for an id that is
/// no app command.
#[tauri::command]
pub fn run_menu_command(app: AppHandle, window: WebviewWindow, id: String) -> CmdResult<()> {
    if menu::run_command(&app, &id, window) {
        Ok(())
    } else {
        Err(CommandError::new(
            "bad-request",
            format!("no app command {id}"),
        ))
    }
}

/// The path a source names, for this window's workspace.
fn source_path(core: &AppCore, window: &WebviewWindow, source: &FileSource) -> CmdResult<PathBuf> {
    match source {
        FileSource::Memo { id } => {
            let workspace = workspace_of(core, window)?;
            let path = lock(&workspace).memo_path(id)?;
            Ok(path)
        }
        FileSource::External { path } => absolute_path(&path.to_string_lossy()),
    }
}

#[tauri::command]
pub fn issue_file_token(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    source: FileSource,
    owner: String,
) -> CmdResult<String> {
    core.ensure_writable(window.label())?;
    let path = source_path(&core, &window, &source)?;
    Ok(files::token_url(&core.files.issue(
        window.label(),
        &owner,
        path,
    )))
}

#[tauri::command]
pub fn revoke_file_tokens(core: State<'_, AppCore>, window: WebviewWindow, owner: String) {
    core.files.revoke(window.label(), &owner);
}

#[tauri::command]
pub fn resolve_relative(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    source: FileSource,
    relative: String,
    owner: String,
) -> CmdResult<Option<String>> {
    let path = source_path(&core, &window, &source)?;
    let Some(dir) = path.parent() else {
        return Ok(None);
    };
    Ok(files::resolve_relative(dir, &relative)
        .map(|file| files::token_url(&core.files.issue(window.label(), &owner, file))))
}

impl From<SearchError> for CommandError {
    fn from(err: SearchError) -> CommandError {
        match err {
            SearchError::BadPattern(message) => CommandError::new("bad-request", message),
            SearchError::Io(io) => io.into(),
        }
    }
}

/// Runs `f` on the blocking pool. A scan or a search reads a file of up to gigabytes; on the
/// async runtime's own threads it would hold up every other async command meanwhile.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await?
}

#[tauri::command]
pub async fn scan_text(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    source: FileSource,
) -> CmdResult<TextScan> {
    let path = source_path(&core, &window, &source)?;
    blocking(move || Ok(text::scan(&path)?)).await
}

#[tauri::command]
pub async fn search_text(
    core: State<'_, AppCore>,
    app: AppHandle,
    window: WebviewWindow,
    source: FileSource,
    query: TextQuery,
    from_line: u64,
    request_id: u64,
) -> CmdResult<TextSearch> {
    let path = source_path(&core, &window, &source)?;
    let label = window.label().to_string();
    // Before the blocking pool, in the order the searches came: one that waited there for a
    // thread must not make itself live over a newer one.
    core.begin_search(&label, request_id);
    blocking(move || {
        let core = app.state::<AppCore>();
        let live = || core.search_is_live(&label, request_id);
        Ok(text::search(
            &path,
            &query,
            from_line,
            text::SEARCH_PAGE,
            &|| !live(),
        )?)
    })
    .await
}

/// The window's large text viewer closed: its search, if one is running, stops at its next
/// check. The frontend numbers searches from 1, so 0 is live for no search.
#[tauri::command]
pub fn cancel_text_search(core: State<'_, AppCore>, window: WebviewWindow) {
    core.begin_search(window.label(), 0);
}

/// Searches the window's workspace (spec 「워크스페이스 검색」), each file's matches sent on
/// `on_event` as soon as it is done, then `Done`. A newer `request_id` from the window, or
/// `cancel_workspace_search`, stops this one at its next file. `bad-request`: not a valid regex.
#[tauri::command]
pub async fn search_workspace(
    core: State<'_, AppCore>,
    app: AppHandle,
    window: WebviewWindow,
    query: SearchQuery,
    request_id: u64,
    on_event: Channel<SearchEvent>,
) -> CmdResult<()> {
    let workspace = workspace_of(&core, &window)?;
    let label = window.label().to_string();
    // Before the blocking pool, as in `search_text`.
    core.begin_workspace_search(&label, request_id);
    blocking(move || {
        let core = app.state::<AppCore>();
        // Only the list under the lock: a save or a watch batch waits for that, not the search.
        let (root, files) = {
            let mut workspace = lock(&workspace);
            let files = search::text_candidates(workspace.list_memos()?);
            (workspace.root().to_path_buf(), files)
        };
        let cancelled = || !core.workspace_search_is_live(&label, request_id);
        // A send fails only once the window's page is gone; the search ends with it anyway.
        let emit = |event| drop(on_event.send(event));
        Ok(search::search(&root, &files, &query, &cancelled, &emit)?)
    })
    .await
}

/// The search panel closed: its search, if one is running, stops at its next file. The
/// frontend numbers searches from 1, so 0 is live for no search.
#[tauri::command]
pub fn cancel_workspace_search(core: State<'_, AppCore>, window: WebviewWindow) {
    core.begin_workspace_search(window.label(), 0);
}

/// A timing mark of the frontend's (src/perf.rs); nothing unless the app runs with `TOTE_PERF=1`.
#[tauri::command]
pub fn perf_mark(name: String) {
    perf::mark(&name);
}

/// Whether the window sends timing marks, and the workspace search a measurement run asks it to
/// run once it is ready, if any.
#[tauri::command]
pub fn perf_config() -> PerfConfig {
    perf::config()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::order::{arranged, save};
    use crate::workspace::TOTE_DIR;
    use serde_json::json;

    #[test]
    fn a_tear_off_answers_in_the_words_the_page_reads() {
        assert_eq!(
            serde_json::to_value(TornOff::Moved).unwrap(),
            json!("moved")
        );
        assert_eq!(
            serde_json::to_value(TornOff::Window).unwrap(),
            json!("window")
        );
    }

    #[test]
    fn an_adopted_tab_reaches_the_page_as_its_json_and_the_point() {
        let adopt = Adopt {
            tab: r#"{"kind":"memo","memoId":"b"}"#.to_string(),
            x: 400.0,
            y: -20.5,
        };
        assert_eq!(
            serde_json::to_value(adopt).unwrap(),
            json!({ "tab": r#"{"kind":"memo","memoId":"b"}"#, "x": 400.0, "y": -20.5 })
        );
    }

    /// The page tells a file that is not text by `not-text` (「텍스트로 열 수 없음」), whether it is
    /// an outside file or a memo whose error comes wrapped in `WorkspaceError::Io`.
    #[test]
    fn a_file_that_is_not_text_reaches_the_page_as_not_text() {
        use crate::persist::external::ExternalFiles;
        use crate::session::drafts::DraftStore;
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("녹화.ts");
        std::fs::write(&video, b"G\0\x11\x10").unwrap();
        let external = ExternalFiles::new(DraftStore::new(dir.path().join("buffers")));
        let err = CommandError::from(external.read(&video).unwrap_err());
        assert_eq!(err.code, "not-text", "{}", err.message);

        let mut workspace = Workspace::create(dir.path(), "메모").unwrap();
        let memo = workspace.import_memo("녹화.ts", b"G\0\x11\x10").unwrap();
        let err = CommandError::from(workspace.read_memo(&memo.id).unwrap_err());
        assert_eq!(err.code, "not-text", "{}", err.message);

        // Other refusals keep their own codes.
        let gone = crate::persist::read_text(&dir.path().join("없음")).unwrap_err();
        assert_eq!(CommandError::from(gone).code, "not-found");
        let bad = io::Error::new(io::ErrorKind::InvalidData, "broken");
        assert_eq!(CommandError::from(bad).code, "bad-request");
    }

    #[test]
    fn a_recent_workspace_whose_folder_is_gone_is_listed_as_missing() {
        let root = tempfile::tempdir().unwrap();
        let kept = Workspace::create(root.path(), "있는 곳").unwrap();
        let kept_path = std::fs::canonicalize(kept.root()).unwrap();
        // A folder without `.tote/workspace.json` is as gone as one that does not exist.
        let hollow = root.path().join("텅 빈");
        std::fs::create_dir(&hollow).unwrap();
        // A workspace that lives outside the root is fine, not missing.
        let elsewhere = tempfile::tempdir().unwrap();
        let outside = Workspace::create(elsewhere.path(), "밖").unwrap();
        let recent = vec![
            outside.root().to_path_buf(),
            PathBuf::from("/gone/옛"),
            kept_path.clone(),
            hollow.clone(),
        ];
        let items = workspace_items(arranged(root.path()), &recent, |p| {
            usize::from(p == kept_path)
        });
        let view: Vec<_> = items
            .iter()
            .map(|i| (i.name.as_str(), i.open, i.missing, i.order, i.hidden))
            .collect();
        assert_eq!(
            view,
            vec![
                ("있는 곳", true, false, Some(0), false),
                ("옛", false, true, None, false),
                ("텅 빈", false, true, None, false)
            ]
        );
        assert_eq!(items[1].path, PathBuf::from("/gone/옛"));
    }

    #[test]
    fn a_window_layout_must_be_a_json_object() {
        assert_eq!(
            layout_from_json(r#"{"panes":[]}"#).unwrap(),
            serde_json::json!({"panes": []})
        );
        for json in ["[1,2]", "3", "{ broken"] {
            assert_eq!(layout_from_json(json).unwrap_err().code, "bad-request");
        }
    }

    #[test]
    fn the_list_counts_each_workspaces_windows() {
        let root = tempfile::tempdir().unwrap();
        let a = Workspace::create(root.path(), "가").unwrap();
        let a_path = std::fs::canonicalize(a.root()).unwrap();
        Workspace::create(root.path(), "나").unwrap();
        let recent = vec![PathBuf::from("/gone/옛")];
        let items = workspace_items(arranged(root.path()), &recent, |p| {
            if p == a_path {
                2
            } else {
                0
            }
        });
        let view: Vec<_> = items
            .iter()
            .map(|i| (i.name.as_str(), i.windows, i.open, i.order, i.hidden))
            .collect();
        assert_eq!(
            view,
            vec![
                ("가", 2, true, Some(0), false),
                ("나", 0, false, Some(1), false),
                ("옛", 0, false, None, false)
            ]
        );
    }

    fn entry(root: &Path, name: &str) -> Entry {
        Entry {
            id: Workspace::read_id(&root.join(name)).unwrap(),
            name: name.into(),
        }
    }

    #[test]
    fn items_carry_their_place_and_flag_but_keep_recent_order() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        for name in ["가", "나", "다"] {
            Workspace::create(r, name).unwrap();
        }
        save(
            r,
            &WorkspaceOrder {
                order: vec![entry(r, "다"), entry(r, "나"), entry(r, "가")],
                hidden: vec![entry(r, "나")],
            },
        )
        .unwrap();
        let recent = vec![std::fs::canonicalize(r.join("나")).unwrap()];
        let items = workspace_items(arranged(r), &recent, |_| 0);
        let view: Vec<_> = items
            .iter()
            .map(|i| (i.name.as_str(), i.order, i.hidden, i.orderable))
            .collect();
        assert_eq!(
            view,
            vec![
                ("나", Some(1), true, true),
                ("가", Some(2), false, true),
                ("다", Some(0), false, true)
            ]
        );
        let json = serde_json::to_value(&items[0]).unwrap();
        assert_eq!(json["order"], 1);
        assert_eq!(json["hidden"], true);
        assert_eq!(json["orderable"], true);
    }

    #[test]
    fn a_missing_recent_workspace_has_no_place() {
        let root = tempfile::tempdir().unwrap();
        Workspace::create(root.path(), "가").unwrap();
        let recent = vec![PathBuf::from("/gone/옛")];
        let items = workspace_items(arranged(root.path()), &recent, |_| 0);
        assert_eq!(items.len(), 2);
        let gone = &items[1];
        assert!(gone.missing);
        assert_eq!(gone.order, None);
        assert!(!gone.hidden);
        assert!(!gone.orderable);
        let json = serde_json::to_value(gone).unwrap();
        assert_eq!(json["order"], serde_json::Value::Null);
    }

    #[test]
    fn a_workspace_without_a_readable_id_is_not_orderable() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        Workspace::create(r, "가").unwrap();
        Workspace::create(r, "나").unwrap();
        std::fs::write(r.join("가").join(TOTE_DIR).join("workspace.json"), "nope").unwrap();
        let items = workspace_items(arranged(r), &[], |_| 0);
        let view: Vec<_> = items
            .iter()
            .map(|i| (i.name.as_str(), i.order, i.orderable))
            .collect();
        assert_eq!(view, vec![("가", Some(1), false), ("나", Some(0), true)]);
    }

    #[test]
    fn paths_without_an_id_are_left_out() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        Workspace::create(r, "가").unwrap();
        Workspace::create(r, "나").unwrap();
        std::fs::write(r.join("나").join(TOTE_DIR).join("workspace.json"), "nope").unwrap();
        std::fs::create_dir(r.join("그냥 폴더")).unwrap();
        let paths = vec![
            r.join("나"),
            r.join("그냥 폴더"),
            r.join("없음"),
            r.join("가"),
        ];
        assert_eq!(entries(&paths), vec![entry(r, "가")]);
    }
}
