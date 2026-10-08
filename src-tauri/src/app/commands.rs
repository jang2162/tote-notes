//! The commands the frontend invokes (src/backend/tauri.ts). File contents travel as raw bytes
//! (Tauri's binary IPC); names and paths go in percent-encoded headers, never inside JSON strings.

use std::borrow::Cow;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State, WebviewWindow};

use super::{lifecycle, lock, windows, AppCore, PendingOpen};
use crate::persist::external::ExternalInfo;
use crate::session;
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
    path: PathBuf,
    device_id: String,
}

#[tauri::command]
pub fn workspace_info(core: State<'_, AppCore>, window: WebviewWindow) -> CmdResult<WorkspaceInfo> {
    let workspace = workspace_of(&core, &window)?;
    let workspace = lock(&workspace);
    Ok(WorkspaceInfo {
        id: workspace.id().to_string(),
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
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).create_memo("md", &[])?;
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
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).write_memo(&id, body(&request)?)?;
    Ok(info)
}

#[tauri::command]
pub async fn retitle_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
    stem: String,
) -> CmdResult<MemoInfo> {
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).retitle_memo(&id, &stem)?;
    Ok(info)
}

#[tauri::command]
pub async fn rename_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
    file: String,
) -> CmdResult<MemoInfo> {
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).rename_memo(&id, &file)?;
    Ok(info)
}

#[tauri::command]
pub async fn delete_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
) -> CmdResult<()> {
    let workspace = workspace_of(&core, &window)?;
    lock(&workspace).delete_memo(&id)?;
    Ok(())
}

#[tauri::command]
pub async fn import_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    request: Request<'_>,
) -> CmdResult<MemoInfo> {
    let name = header(&request, "x-file-name")?;
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).import_memo(&name, body(&request)?)?;
    Ok(info)
}

#[tauri::command]
pub async fn import_file(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    path: String,
) -> CmdResult<MemoInfo> {
    let path = absolute_path(&path)?;
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).import_file(&path)?;
    Ok(info)
}

#[tauri::command]
pub async fn read_session(
    core: State<'_, AppCore>,
    window: WebviewWindow,
) -> CmdResult<Option<String>> {
    let workspace = workspace_of(&core, &window)?;
    let root = lock(&workspace).root().to_path_buf();
    Ok(session::read_session(&root, &core.machine.device_id)?)
}

#[tauri::command]
pub async fn write_session(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    json: String,
) -> CmdResult<()> {
    let workspace = workspace_of(&core, &window)?;
    let root = lock(&workspace).root().to_path_buf();
    session::write_session(&root, &core.machine.device_id, &json)?;
    Ok(())
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListItem {
    name: String,
    path: PathBuf,
    open: bool,
}

#[tauri::command]
pub fn list_workspaces(core: State<'_, AppCore>) -> Vec<WorkspaceListItem> {
    let recent = core.recent();
    let mut list: Vec<WorkspaceListItem> = Workspace::list(&core.workspace_root)
        .into_iter()
        .map(|summary| {
            let path = std::fs::canonicalize(&summary.path).unwrap_or(summary.path);
            WorkspaceListItem {
                open: core.is_open_path(&path),
                name: summary.name,
                path,
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
    list
}

#[tauri::command]
pub async fn create_workspace(
    app: AppHandle,
    core: State<'_, AppCore>,
    name: String,
) -> CmdResult<()> {
    let workspace = Workspace::create(&core.workspace_root, &name)?;
    windows::show(&app, workspace.root())?;
    Ok(())
}

#[tauri::command]
pub async fn open_workspace(app: AppHandle, path: String) -> CmdResult<()> {
    windows::show(&app, &absolute_path(&path)?)?;
    Ok(())
}

#[tauri::command]
pub async fn flush_done(app: AppHandle, window: WebviewWindow, id: u64) -> CmdResult<()> {
    lifecycle::ack(&app, id, window.label());
    Ok(())
}

#[tauri::command]
pub async fn close_window(window: WebviewWindow) -> CmdResult<()> {
    window.close()?;
    Ok(())
}
