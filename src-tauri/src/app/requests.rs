//! What a `tote` command asks of the running app (spec 「`tote` CLI」).

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, EventTarget, Manager};

use super::{commands, lock, windows, AppCore, PendingOpen};
use crate::cli::CliRequest;
use crate::workspace::names::is_valid_file_name;
use crate::workspace::WorkspaceError;

pub fn handle(app: &AppHandle, request: CliRequest) {
    let core = app.state::<AppCore>();
    let label = match &request.workspace {
        Some(name) => match workspace_dir(&core.workspace_root(), name) {
            Some(dir) => windows::show(app, &dir).map_err(|e| match e.code {
                "not-found" => format!("워크스페이스가 없습니다: {name}"),
                _ => format!("워크스페이스를 열지 못했습니다: {name}: {}", e.message),
            }),
            None => Err(format!("워크스페이스가 없습니다: {name}")),
        },
        None => match core.latest_window() {
            Some(label) => {
                windows::focus(app, &label);
                Ok(label)
            }
            None => {
                windows::open_latest(app);
                core.latest_window()
                    .ok_or_else(|| "no workspace window".to_string())
            }
        },
    };
    let label = match label {
        Ok(label) => label,
        Err(message) => {
            eprintln!("tote: {message}");
            // No window was meant: the one the person used last says it, if there is one, and
            // comes to the front as it would for a request that worked.
            if let Some(label) = core.latest_window() {
                windows::focus(app, &label);
                notify(app, &label, message);
                poke(app, &label);
            }
            return;
        }
    };
    // The window is between writing its tabs and showing the target: a request for the target
    // would land in the workspace it leaves. `lifecycle::switch_window` handles it again.
    let request = match core.hold_request(&label, request) {
        Ok(()) => return,
        Err(request) => request,
    };
    let Some(workspace) = core.workspace(&label) else {
        return;
    };
    // A memo made here is new to the workspace's other windows too.
    let mut made = false;
    for path in &request.files {
        if !request.import {
            core.push_pending(&label, PendingOpen::External { path: path.clone() });
            continue;
        }
        match lock(&workspace).import_file(path) {
            Ok(info) => {
                made = true;
                core.push_pending(&label, PendingOpen::Memo { id: info.id });
            }
            Err(err) => {
                eprintln!("tote: {}: {err}", path.display());
                notify(
                    app,
                    &label,
                    format!("{} 를 가져오지 못했습니다: {err}", path.display()),
                );
            }
        }
    }
    if let Some(file) = &request.stdin_file {
        // `--tote-request` can be given by any process: only what the `tote` script parked in the
        // inbox is read and removed, never an arbitrary file of the person's.
        if !is_inbox_file(&core.paths.inbox_dir(), file) {
            eprintln!("tote: inbox 밖의 파일은 받지 않습니다: {}", file.display());
            notify(app, &label, STDIN_FAILED.to_string());
        } else {
            let created = fs::read(file)
                .map_err(WorkspaceError::from)
                .and_then(|text| lock(&workspace).create_memo("md", &text));
            // The parked file is the only copy of the piped text until it is a memo.
            match created {
                Ok(info) => {
                    made = true;
                    core.push_pending(&label, PendingOpen::Memo { id: info.id });
                    let _ = fs::remove_file(file);
                }
                Err(err) => {
                    eprintln!("tote: {}: {err}", file.display());
                    notify(app, &label, STDIN_FAILED.to_string());
                }
            }
        }
    }
    if made {
        commands::memos_changed(app, &label);
    }
    poke(app, &label);
}

const STDIN_FAILED: &str = "표준 입력을 받지 못했습니다";

/// Tells window `label` why a request failed. Queued like the opens, not emitted: a window that
/// `windows::show` just made has no listener yet. The callers print the details to stderr too.
fn notify(app: &AppHandle, label: &str, message: String) {
    app.state::<AppCore>()
        .push_pending(label, PendingOpen::Notice { message });
}

/// The frontend picks the queue up now, or when it finishes loading if the window is new.
fn poke(app: &AppHandle, label: &str) {
    let _ = app.emit_to(EventTarget::webview_window(label), "tote://pending", ());
}

/// The folder of workspace `name` under `root`. `--tote-request` can be given by any process, so
/// the name is checked here as the `tote` front end checks it: an absolute path or `..` would
/// otherwise open a workspace outside the root.
fn workspace_dir(root: &Path, name: &str) -> Option<PathBuf> {
    is_valid_file_name(name).then(|| root.join(name))
}

/// A regular file directly inside `inbox` (not a symlink, not reached through `..`).
fn is_inbox_file(inbox: &Path, path: &Path) -> bool {
    let Some(parent) = path.parent().and_then(|p| fs::canonicalize(p).ok()) else {
        return false;
    };
    let Ok(inbox) = fs::canonicalize(inbox) else {
        return false;
    };
    parent == inbox && fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_name_cannot_leave_the_root() {
        let root = Path::new("/root/Tote");
        assert_eq!(
            workspace_dir(root, "업무"),
            Some(PathBuf::from("/root/Tote/업무"))
        );
        for name in ["..", "../other", "/etc", "a/b", ".hidden", "", " 업무"] {
            assert_eq!(workspace_dir(root, name), None, "{name:?}");
        }
    }

    #[test]
    fn only_files_inside_the_inbox_are_taken() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("inbox");
        fs::create_dir_all(&inbox).unwrap();
        let inside = inbox.join("stdin-1.md");
        fs::write(&inside, "x").unwrap();
        let outside = dir.path().join("secret.txt");
        fs::write(&outside, "x").unwrap();
        let link = inbox.join("link.md");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        assert!(is_inbox_file(&inbox, &inside));
        assert!(!is_inbox_file(&inbox, &outside));
        assert!(!is_inbox_file(&inbox, &link));
        assert!(!is_inbox_file(&inbox, &inbox.join("../secret.txt")));
        assert!(!is_inbox_file(&inbox, &inbox.join("없음.md")));
    }
}
