//! What a `tote` command asks of the running app (spec 「`tote` CLI」).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, EventTarget, Manager, Url};

use super::{commands, lock, windows, AppCore, PendingOpen};
use crate::appdata::shown_from_home;
use crate::cli::CliRequest;
use crate::workspace::names::is_valid_file_name;
use crate::workspace::{MemoInfo, Workspace, WorkspaceError};

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
            if let Some(label) = refuse(&core, request, message) {
                windows::focus(app, &label);
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
        // The window went while the request was on its way to it.
        let message = "요청을 받을 창이 닫혔습니다".to_string();
        eprintln!("tote: {message}");
        if let Some(label) = refuse(&core, request, message) {
            windows::focus(app, &label);
            poke(app, &label);
        }
        return;
    };
    for notice in &request.notices {
        eprintln!("tote: {notice}");
        notify(app, &label, notice.clone());
    }
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
        match take_stdin(&core.paths.inbox_dir(), &workspace, file) {
            Ok(info) => {
                made = true;
                core.push_pending(&label, PendingOpen::Memo { id: info.id });
            }
            Err(message) => notify(app, &label, message),
        }
    }
    if made {
        commands::memos_changed(app, &label);
    }
    poke(app, &label);
}

/// Files macOS opened with tote (`RunEvent::Opened`) before the app was set up: launched by a
/// file, AppKit hands it over before `applicationDidFinishLaunching`, which is when Tauri runs
/// `setup`. `opened_after_setup` takes them once `AppCore` is there.
#[derive(Default)]
pub struct EarlyOpens(Mutex<Vec<Url>>);

/// Opens what macOS handed tote as `tote <파일…>` would, now or once setup is done.
pub fn opened(app: &AppHandle, urls: Vec<Url>) {
    if app.try_state::<AppCore>().is_none() {
        lock(&app.state::<EarlyOpens>().0).extend(urls);
        return;
    }
    handle(app, CliRequest::opened(&urls));
}

/// Setup is done: the files that came before it open now, after the start-up windows.
pub fn opened_after_setup(app: &AppHandle) {
    let urls = std::mem::take(&mut *lock(&app.state::<EarlyOpens>().0));
    if !urls.is_empty() {
        handle(app, CliRequest::opened(&urls));
    }
}

const STDIN_FAILED: &str = "표준 입력을 받지 못했습니다";

/// Where the text of a `tote -` that did not become a memo is. The `tote` command has ended by
/// then with 0, and nothing reads the inbox again, so this notice is the only way to the text.
fn stdin_kept(file: &Path) -> String {
    let shown = shown_from_home(file, dirs::home_dir().as_deref());
    format!("표준 입력을 메모로 만들지 못했습니다: 받은 글은 {shown} 에 있습니다")
}

/// A request no workspace window could take: what it was to say goes to the window the person
/// used last, which is returned for the caller to bring forward. Text piped to it stays in the
/// inbox, and where it is gets told too — by the next window to open when there is none now.
fn refuse(core: &AppCore, request: CliRequest, message: String) -> Option<String> {
    let kept = request
        .stdin_file
        .as_deref()
        .filter(|file| is_inbox_file(&core.paths.inbox_dir(), file))
        .map(stdin_kept);
    let label = core.latest_window();
    match &label {
        Some(label) => {
            for message in request.notices.into_iter().chain([message]).chain(kept) {
                core.push_pending(label, PendingOpen::Notice { message });
            }
        }
        None => kept.into_iter().for_each(|kept| {
            eprintln!("tote: {kept}");
            core.tell_next_window(kept);
        }),
    }
    label
}

/// Makes a memo of the text the `tote` script parked at `file`, and removes the file. `Err` is
/// what the window says instead: the text stays parked, so it says where (`stdin_kept`).
fn take_stdin(inbox: &Path, workspace: &Mutex<Workspace>, file: &Path) -> Result<MemoInfo, String> {
    // `--tote-request` can be given by any process: only what the `tote` script parked in the
    // inbox is read and removed, never an arbitrary file of the person's.
    if !is_inbox_file(inbox, file) {
        eprintln!("tote: inbox 밖의 파일은 받지 않습니다: {}", file.display());
        return Err(STDIN_FAILED.to_string());
    }
    let created = fs::read(file)
        .map_err(WorkspaceError::from)
        .and_then(|text| lock(workspace).create_memo("md", &text));
    // The parked file is the only copy of the piped text until it is a memo.
    match created {
        Ok(info) => {
            let _ = fs::remove_file(file);
            Ok(info)
        }
        Err(err) => {
            eprintln!("tote: {}: {err}", file.display());
            Err(stdin_kept(file))
        }
    }
}

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
    use crate::appdata::{AppPaths, LaunchState, Machine, Settings};

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

    /// The text `tote -` parked in the inbox of `core`.
    fn parked(core: &AppCore, text: &str) -> PathBuf {
        let inbox = core.paths.inbox_dir();
        fs::create_dir_all(&inbox).unwrap();
        let file = inbox.join("0123abcd.txt");
        fs::write(&file, text).unwrap();
        file
    }

    fn notices(core: &AppCore, label: &str) -> Vec<String> {
        core.take_pending(label)
            .into_iter()
            .filter_map(|open| match open {
                PendingOpen::Notice { message } => Some(message),
                _ => None,
            })
            .collect()
    }

    fn kept_at(file: &Path) -> String {
        format!(
            "표준 입력을 메모로 만들지 못했습니다: 받은 글은 {} 에 있습니다",
            shown_from_home(file, dirs::home_dir().as_deref())
        )
    }

    #[test]
    fn text_piped_to_a_request_no_window_takes_stays_and_is_told_where() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let file = parked(&core, "파이프한 글");
        let request = |notices: &[&str]| CliRequest {
            workspace: Some("없는곳".into()),
            stdin_file: Some(file.clone()),
            notices: notices.iter().map(|n| n.to_string()).collect(),
            ..CliRequest::default()
        };
        let missing = "워크스페이스가 없습니다: 없는곳".to_string();
        // No window at all: the next one opened says where the text is.
        assert_eq!(refuse(&core, request(&[]), missing.clone()), None);
        assert_eq!(fs::read_to_string(&file).unwrap(), "파이프한 글");
        let a = open(&core, "가");
        assert_eq!(notices(&core, &a), vec![kept_at(&file)]);
        // A window is open: it says why the request failed, then where the text is.
        assert_eq!(
            refuse(
                &core,
                request(&["폴더는 열 수 없습니다: /x"]),
                missing.clone()
            ),
            Some(a.clone())
        );
        assert_eq!(
            notices(&core, &a),
            vec![
                "폴더는 열 수 없습니다: /x".to_string(),
                missing.clone(),
                kept_at(&file)
            ]
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "파이프한 글");
        // A file outside the inbox is not the request's to speak of, and no text was piped at all.
        let outside = dir.path().join("secret.txt");
        fs::write(&outside, "x").unwrap();
        let elsewhere = CliRequest {
            stdin_file: Some(outside),
            ..CliRequest::default()
        };
        refuse(&core, elsewhere, missing.clone());
        refuse(&core, CliRequest::default(), missing.clone());
        assert_eq!(notices(&core, &a), vec![missing.clone(), missing]);
    }

    #[test]
    fn piped_text_becomes_a_memo_or_stays_in_the_inbox() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let workspace = core.workspace(&a).unwrap();
        let inbox = core.paths.inbox_dir();
        let file = parked(&core, "# 파이프한 글\n");
        let memo = take_stdin(&inbox, &workspace, &file).unwrap();
        assert_eq!(
            lock(&workspace).read_memo(&memo.id).unwrap(),
            "# 파이프한 글\n".as_bytes()
        );
        assert!(memo.auto_title && memo.file.ends_with(".md"), "{memo:?}");
        assert!(!file.exists());
        // The memo cannot be made (the workspace folder is gone): the text stays, and the window
        // is told where.
        let file = parked(&core, "둘째 글");
        let root = lock(&workspace).root().to_path_buf();
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(
            take_stdin(&inbox, &workspace, &file).unwrap_err(),
            kept_at(&file)
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "둘째 글");
        // A file outside the inbox is refused without a word about where it is.
        let outside = dir.path().join("secret.txt");
        fs::write(&outside, "x").unwrap();
        assert_eq!(
            take_stdin(&inbox, &workspace, &outside).unwrap_err(),
            STDIN_FAILED
        );
        assert!(outside.exists());
    }

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
