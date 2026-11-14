//! The commands that put an image in a Markdown memo's workspace: pasted bytes and a dropped file
//! (docs/superpowers/specs/2026-11-14-tote-notes-image-paste-design.md 「백엔드 명령」).

use tauri::ipc::Request;
use tauri::{Manager, State, WebviewWindow};

use super::commands::{absolute_path, body, header, memos_changed, workspace_to_change, CmdResult};
use super::{lock, AppCore};
use crate::workspace::images::ImportedImage;
use crate::workspace::MemoInfo;

/// Pasted image bytes (the body) saved as `x-file-name`, or the next free name.
#[tauri::command]
pub async fn save_image(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    request: Request<'_>,
) -> CmdResult<MemoInfo> {
    let name = header(&request, "x-file-name")?;
    let workspace = workspace_to_change(&core, &window)?;
    let info = lock(&workspace).save_image(&name, body(&request)?)?;
    memos_changed(window.app_handle(), window.label());
    Ok(info)
}

/// A dropped image file copied into the root, or linked as it is when it is there already.
#[tauri::command]
pub async fn import_image(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    path: String,
) -> CmdResult<ImportedImage> {
    let path = absolute_path(&path)?;
    let workspace = workspace_to_change(&core, &window)?;
    let imported = lock(&workspace).import_image(&path)?;
    if imported.memo.is_some() {
        memos_changed(window.app_handle(), window.label());
    }
    Ok(imported)
}
