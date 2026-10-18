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
use super::{lifecycle, lock, menu, windows, AppCore, PendingOpen};
use crate::appdata::{Settings, SettingsPatch};
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

/// Moves this window's tab `tab_ref` into a new window of the workspace, a little off this one.
/// `tab` is its session entry (`SessionTab`), what the new window opens; `bad-request` when it is
/// not a JSON object. The tab is in the session and its place is the new window's before the
/// window is made; when it cannot be made the tab stays here.
#[tauri::command]
pub async fn tear_off_tab(
    app: AppHandle,
    core: State<'_, AppCore>,
    window: WebviewWindow,
    tab: String,
    tab_ref: TabRef,
) -> CmdResult<()> {
    let tab = match serde_json::from_str(&tab) {
        Ok(tab @ serde_json::Value::Object(_)) => tab,
        _ => return Err(CommandError::new("bad-request", "a tab is a JSON object")),
    };
    let label = window.label();
    let (Some(path), Some(key)) = (core.path_of(label), core.key_for(label, &tab_ref)) else {
        return Err(CommandError::new(
            "no-workspace",
            format!("{label} shows no workspace"),
        ));
    };
    let near =
        windows::frame_of(&window).map(|f| windows::cascade(f, &windows::monitor_rects(&app)));
    let plan = windows::WindowPlan::Tab {
        tab,
        near,
        from: label.to_string(),
        key,
    };
    windows::open_window(&app, &path, plan)?;
    Ok(())
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
}

/// The workspaces under `root`, most recently used first, then the recent ones that vanished.
/// `windows` counts the windows showing a workspace.
fn workspace_items(
    root: &Path,
    recent: &[PathBuf],
    windows: impl Fn(&Path) -> usize,
) -> Vec<WorkspaceListItem> {
    let mut list: Vec<WorkspaceListItem> = Workspace::list(root)
        .into_iter()
        .map(|summary| {
            let path = std::fs::canonicalize(&summary.path).unwrap_or(summary.path);
            let windows = windows(&path);
            WorkspaceListItem {
                open: windows > 0,
                windows,
                name: summary.name,
                path,
                missing: false,
            }
        })
        .collect();
    // Most recently used first; the rest keep their name order (the sort is stable).
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
        })
        .collect::<Vec<_>>();
    list.extend(gone);
    list
}

#[tauri::command]
pub async fn list_workspaces(core: State<'_, AppCore>) -> CmdResult<Vec<WorkspaceListItem>> {
    Ok(workspace_items(
        &core.workspace_root(),
        &core.recent(),
        |path| core.windows_of(path).len(),
    ))
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

#[tauri::command]
pub async fn patch_settings(
    app: AppHandle,
    core: State<'_, AppCore>,
    patch: SettingsPatch,
) -> CmdResult<()> {
    core.patch_settings(patch)?;
    broadcast_config(&app);
    Ok(())
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
        let items = workspace_items(root.path(), &recent, |p| usize::from(p == kept_path));
        let view: Vec<_> = items
            .iter()
            .map(|i| (i.name.as_str(), i.open, i.missing))
            .collect();
        assert_eq!(
            view,
            vec![
                ("있는 곳", true, false),
                ("옛", false, true),
                ("텅 빈", false, true)
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
        let items = workspace_items(root.path(), &recent, |p| if p == a_path { 2 } else { 0 });
        let view: Vec<_> = items
            .iter()
            .map(|i| (i.name.as_str(), i.windows, i.open))
            .collect();
        assert_eq!(
            view,
            vec![("가", 2, true), ("나", 0, false), ("옛", 0, false)]
        );
    }
}
