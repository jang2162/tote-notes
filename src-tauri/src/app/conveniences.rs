//! Finder, the clipboard, a memo copied or moved to another workspace, and a workspace renamed or
//! moved to the macOS trash (docs/superpowers/specs/2026-11-14-tote-notes-conveniences-design.md).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::ipc::Request;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow};

use super::commands::{
    absolute_path, body, header, memos_changed, workspace_of, workspace_to_change, CmdResult,
    CommandError,
};
use super::places::TabRef;
use super::{lock, AppCore, Inner};
use crate::workspace::index::memo_files;
use crate::workspace::names::is_valid_file_name;
use crate::workspace::{order, FileOps, MemoInfo, Workspace, WorkspaceError};

/// A window shows the workspace or is being opened on it: it is not renamed or trashed under that
/// window's saves (spec 「워크스페이스 이름 바꾸기·지우기」). The command answers `workspace-open`.
#[derive(Debug)]
pub struct WorkspaceInUse(PathBuf);

impl std::fmt::Display for WorkspaceInUse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "a window shows {}", self.0.display())
    }
}

impl std::error::Error for WorkspaceInUse {}

/// A window is being opened on the workspace a memo would move to: the move waits for nothing and
/// is refused. The command answers `workspace-opening`, which the frontend words.
#[derive(Debug)]
pub struct WorkspaceOpening(PathBuf);

impl std::fmt::Display for WorkspaceOpening {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "a window is opening {}", self.0.display())
    }
}

impl std::error::Error for WorkspaceOpening {}

/// A memo moved by `AppCore::move_memo_out`: as the target lists it, the target's name, and the
/// windows that show the target, to read their memo list again.
#[derive(Debug)]
pub struct MovedMemo {
    pub info: MemoInfo,
    pub workspace: String,
    pub windows: Vec<String>,
}

impl AppCore {
    /// `path` as a workspace directly under the workspace root, canonical; `NotAWorkspace` for
    /// anything else, so a command cannot rename or trash some other folder.
    fn managed_workspace(&self, path: &Path) -> Result<PathBuf, WorkspaceError> {
        let not_one = || WorkspaceError::NotAWorkspace(path.to_path_buf());
        let found = fs::canonicalize(path).map_err(|_| not_one())?;
        let root = fs::canonicalize(self.workspace_root()).map_err(|_| not_one())?;
        let named = found.file_name().and_then(|name| name.to_str());
        if found.parent() != Some(root.as_path())
            || named.is_none_or(|name| name.starts_with('.'))
            || !Workspace::is_workspace(&found)
        {
            return Err(not_one());
        }
        Ok(found)
    }

    /// Renames the folder of the workspace at `path` to `name` (a workspace is named after its
    /// folder) and returns its new path. Refused while a window shows it or is being opened on it,
    /// checked and done under one lock so no window opens it in between. The ID stays, and with
    /// it the backups; the order file and the recent list follow the new name.
    pub fn rename_workspace(&self, path: &Path, name: &str) -> Result<PathBuf, WorkspaceError> {
        let from = self.managed_workspace(path)?;
        let name = name.trim();
        if !is_valid_file_name(name) {
            return Err(WorkspaceError::InvalidName(name.to_string()));
        }
        let (root, old) = parent_and_name(&from);
        if old == name {
            return Ok(from);
        }
        let to = root.join(name);
        let mut inner = lock(&self.inner);
        if in_use(&inner, &from) {
            return Err(in_use_error(&from));
        }
        // On APFS a name that differs only in case finds the folder itself, which is no clash.
        if to.symlink_metadata().is_ok() && !same_file(&from, &to) {
            return Err(WorkspaceError::AlreadyExists(to));
        }
        fs::rename(&from, &to)?;
        // The folder has its new name: what follows only keeps the switcher's places.
        if let Some(id) = Workspace::read_id(&to) {
            if let Err(err) = order::renamed(&root, &id, &old, name) {
                eprintln!("tote: could not write the workspace order: {err}");
            }
        }
        for recent in inner.launch.recent.iter_mut() {
            if *recent == from {
                recent.clone_from(&to);
            }
        }
        self.save_launch(&inner.launch);
        Ok(to)
    }

    /// Hands the workspace folder at `path` to `trash` — the macOS trash in the app — under the
    /// same rule as `rename_workspace`. Its backups stay. It leaves the order file and the
    /// recent list.
    pub fn trash_workspace(
        &self,
        path: &Path,
        trash: impl FnOnce(&Path) -> io::Result<()>,
    ) -> Result<(), WorkspaceError> {
        let path = self.managed_workspace(path)?;
        let (root, name) = parent_and_name(&path);
        let id = Workspace::read_id(&path);
        let mut inner = lock(&self.inner);
        if in_use(&inner, &path) {
            return Err(in_use_error(&path));
        }
        trash(&path)?;
        if let Some(id) = id {
            if let Err(err) = order::forget(&root, &id, &name) {
                eprintln!("tote: could not write the workspace order: {err}");
            }
        }
        inner.launch.recent.retain(|recent| *recent != path);
        self.save_launch(&inner.launch);
        Ok(())
    }

    /// The memo files directly in the workspace at `path`, for the question before trashing it.
    pub fn workspace_memo_count(&self, path: &Path) -> Result<usize, WorkspaceError> {
        Ok(memo_files(&self.managed_workspace(path)?)?.len())
    }

    /// Moves memo `id` of window `label`'s workspace into the workspace at `to` (spec 「다른
    /// 워크스페이스로 옮기기」). The source is locked from start to end. A target some window shows
    /// is locked too, the two in path order so two moves crossing each other cannot wait on each
    /// other; one no window shows is opened for the move under the window registry's lock, so no
    /// window opens a second copy of it meanwhile.
    pub fn move_memo_out(
        &self,
        label: &str,
        id: &str,
        to: &Path,
        ops: &FileOps,
    ) -> Result<MovedMemo, WorkspaceError> {
        let to = self.managed_workspace(to)?;
        let source = self.workspace_to_change(label)?;
        let from = self.path_of(label).unwrap_or_default();
        if from == to {
            return Err(WorkspaceError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the memo is in that workspace already",
            )));
        }
        let (_, workspace) = parent_and_name(&to);
        let info = loop {
            let open = lock(&self.inner)
                .workspaces
                .get(&to)
                .map(|open| open.workspace.clone());
            if let Some(target) = open {
                let (mut source, mut target) = if from < to {
                    let source = lock(&source);
                    (source, lock(&target))
                } else {
                    let target = lock(&target);
                    (lock(&source), target)
                };
                break source.move_memo_to(id, &mut target, ops)?;
            }
            let mut source = lock(&source);
            let inner = lock(&self.inner);
            // Opened by a window since the look above: the move goes into that one.
            if inner.workspaces.contains_key(&to) {
                continue;
            }
            if inner.reserved.contains_key(&to) {
                return Err(WorkspaceError::Io(io::Error::other(WorkspaceOpening(
                    to.clone(),
                ))));
            }
            let mut target = Workspace::open(&to)?;
            break source.move_memo_to(id, &mut target, ops)?;
        };
        Ok(MovedMemo {
            info,
            workspace,
            windows: self.windows_of(&to),
        })
    }
}

/// The folder a workspace is in and its name.
fn parent_and_name(path: &Path) -> (PathBuf, String) {
    (
        path.parent().map(Path::to_path_buf).unwrap_or_default(),
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    )
}

/// Whether a window shows the workspace at `path`, is being opened on it, or it is open at all.
fn in_use(inner: &Inner, path: &Path) -> bool {
    inner.workspaces.contains_key(path)
        || inner.reserved.contains_key(path)
        || inner.windows.values().any(|window| window.path == path)
}

fn in_use_error(path: &Path) -> WorkspaceError {
    WorkspaceError::Io(io::Error::new(
        io::ErrorKind::ResourceBusy,
        WorkspaceInUse(path.to_path_buf()),
    ))
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    a == b
}

/// `CommandError::from`, with codes of their own for a workspace a window holds and one a window
/// is being opened on.
fn command_error(err: WorkspaceError) -> CommandError {
    if let WorkspaceError::Io(io) = &err {
        if let Some(inner) = io.get_ref() {
            if inner.is::<WorkspaceInUse>() {
                return CommandError::new("workspace-open", err.to_string());
            }
            if inner.is::<WorkspaceOpening>() {
                return CommandError::new("workspace-opening", err.to_string());
            }
        }
    }
    err.into()
}

/// What `reveal_in_finder` and `copy_file_path` act on: a memo of the window's workspace, an
/// external file, or a memo in the workspace's trash. The path is made here, never by the page.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileTarget {
    Memo { id: String },
    External { path: String },
    Trashed { id: String },
}

fn target_path(core: &AppCore, window: &WebviewWindow, target: &FileTarget) -> CmdResult<PathBuf> {
    Ok(match target {
        FileTarget::Memo { id } => {
            let workspace = workspace_of(core, window)?;
            let path = lock(&workspace).memo_path(id)?;
            path
        }
        FileTarget::External { path } => absolute_path(path)?,
        FileTarget::Trashed { id } => {
            let workspace = workspace_of(core, window)?;
            let path = lock(&workspace).trashed_path(id)?;
            path
        }
    })
}

/// Shows the file in Finder, selected (`open -R`). `not-found` when it is not there.
#[tauri::command]
pub async fn reveal_in_finder(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    target: FileTarget,
) -> CmdResult<()> {
    let path = target_path(&core, &window, &target)?;
    if fs::symlink_metadata(&path).is_err() {
        return Err(CommandError::new("not-found", path.display().to_string()));
    }
    Ok(reveal(&path)?)
}

/// Puts the file's absolute path on the clipboard, from here: a pick in the native context menu
/// reaches the page outside the click, where the web view may refuse a clipboard write (spec
/// 「경로 복사」). Returns the path.
#[tauri::command]
pub async fn copy_file_path(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    target: FileTarget,
) -> CmdResult<String> {
    let path = target_path(&core, &window, &target)?;
    let text = path.to_string_lossy().into_owned();
    write_clipboard(&text)?;
    Ok(text)
}

/// A copy of the memo beside it (`Workspace::duplicate_memo`). With `x-with-text`, the body is
/// the text of the memo's tab, unsaved edits and all; without, the file is copied.
#[tauri::command]
pub async fn duplicate_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    request: Request<'_>,
) -> CmdResult<MemoInfo> {
    let id = header(&request, "x-memo-id")?;
    let text = request
        .headers()
        .contains_key("x-with-text")
        .then(|| body(&request))
        .transpose()?;
    let workspace = workspace_to_change(&core, &window)?;
    let info = lock(&workspace).duplicate_memo(&id, text)?;
    memos_changed(window.app_handle(), window.label());
    Ok(info)
}

/// What `move_memo_to` did: moved it, or left it to the window that has it open, which was asked
/// to save and close it (`tote://move-memo`) and moves it from there.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MoveOutcome {
    Moved { info: MemoInfo, workspace: String },
    Elsewhere,
}

/// What `tote://move-memo` asks of the window holding the memo.
#[derive(Clone, Serialize)]
struct MoveRequest {
    id: String,
    workspace: String,
}

/// Moves the memo to the workspace at `workspace`. The window holds the memo's place meanwhile,
/// as for the trash; a memo another window has open stays and that window is asked. The windows
/// of both workspaces read their memo list again, also after a move that failed part way.
#[tauri::command]
pub async fn move_memo_to(
    app: AppHandle,
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
    workspace: String,
) -> CmdResult<MoveOutcome> {
    let to = absolute_path(&workspace)?;
    let fresh = match core.hold_memo(window.label(), &id)? {
        Ok(fresh) => fresh,
        Err(owner) => {
            let _ = app.emit_to(
                EventTarget::webview_window(&owner),
                "tote://move-memo",
                MoveRequest { id, workspace },
            );
            return Ok(MoveOutcome::Elsewhere);
        }
    };
    let result = core.move_memo_out(window.label(), &id, &to, &FileOps::SYSTEM);
    if result.is_ok() || fresh {
        core.release_tab(window.label(), &TabRef::Memo { id });
    }
    memos_changed(&app, window.label());
    let target = fs::canonicalize(&to).unwrap_or(to);
    for label in core.windows_of(&target) {
        let _ = app.emit_to(EventTarget::webview_window(&label), "tote://memos", ());
    }
    let moved = result.map_err(command_error)?;
    Ok(MoveOutcome::Moved {
        info: moved.info,
        workspace: moved.workspace,
    })
}

#[tauri::command]
pub async fn rename_workspace(
    app: AppHandle,
    core: State<'_, AppCore>,
    path: String,
    name: String,
) -> CmdResult<PathBuf> {
    let renamed = core
        .rename_workspace(&absolute_path(&path)?, &name)
        .map_err(command_error)?;
    let _ = app.emit("tote://workspaces", ());
    Ok(renamed)
}

#[tauri::command]
pub async fn workspace_memo_count(core: State<'_, AppCore>, path: String) -> CmdResult<usize> {
    core.workspace_memo_count(&absolute_path(&path)?)
        .map_err(command_error)
}

#[tauri::command]
pub async fn trash_workspace(
    app: AppHandle,
    core: State<'_, AppCore>,
    path: String,
) -> CmdResult<()> {
    core.trash_workspace(&absolute_path(&path)?, move_to_trash)
        .map_err(command_error)?;
    let _ = app.emit("tote://workspaces", ());
    Ok(())
}

#[cfg(target_os = "macos")]
fn reveal(path: &Path) -> io::Result<()> {
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "open -R {}: {status}",
            path.display()
        )))
    }
}

#[cfg(target_os = "macos")]
fn write_clipboard(text: &str) -> io::Result<()> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;
    let board = NSPasteboard::generalPasteboard();
    board.clearContents();
    // SAFETY: an AppKit constant, there for the life of the process.
    let kind = unsafe { NSPasteboardTypeString };
    if board.setString_forType(&NSString::from_str(text), kind) {
        Ok(())
    } else {
        Err(io::Error::other("the clipboard did not take the path"))
    }
}

/// The macOS trash, as Finder's 「휴지통으로 이동」: 「되돌려 놓기」 brings the folder back.
#[cfg(target_os = "macos")]
fn move_to_trash(path: &Path) -> io::Result<()> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|err| io::Error::other(err.localizedDescription().to_string()))
}

#[cfg(not(target_os = "macos"))]
fn reveal(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "지원하지 않음"))
}

#[cfg(not(target_os = "macos"))]
fn write_clipboard(_text: &str) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "지원하지 않음"))
}

#[cfg(not(target_os = "macos"))]
fn move_to_trash(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "지원하지 않음"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appdata::{AppPaths, LaunchState, Machine, Settings};
    use crate::workspace::order::{Entry, WorkspaceOrder};

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

    fn create(core: &AppCore, name: &str) -> PathBuf {
        let workspace = Workspace::create(&core.workspace_root(), name).unwrap();
        fs::canonicalize(workspace.root()).unwrap()
    }

    /// A window on the workspace at `path`, opened as the app opens one.
    fn show(core: &AppCore, path: &Path) -> String {
        let label = core.next_label();
        let opened = (!core.is_open_path(path)).then(|| Workspace::open(path).unwrap());
        assert!(core.register_window(&label, path, opened, None));
        core.opened(&label);
        label
    }

    fn is_in_use(err: &WorkspaceError) -> bool {
        matches!(err, WorkspaceError::Io(io) if io.get_ref().is_some_and(|e| e.is::<WorkspaceInUse>()))
    }

    #[test]
    fn a_workspace_no_window_shows_is_renamed_and_keeps_its_id_order_and_recent_place() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = create(&core, "가");
        let b = create(&core, "나");
        let id = Workspace::read_id(&a).unwrap();
        let entry = |id: &str, name: &str| Entry {
            id: id.into(),
            name: name.into(),
        };
        let root = fs::canonicalize(core.workspace_root()).unwrap();
        order::save(
            &root,
            &WorkspaceOrder {
                order: vec![
                    entry(&Workspace::read_id(&b).unwrap(), "나"),
                    entry(&id, "가"),
                ],
                hidden: vec![entry(&id, "가")],
            },
        )
        .unwrap();
        // Used once, then its window closed: it is in the recent list.
        let label = show(&core, &a);
        core.closed(&label);
        let renamed = core.rename_workspace(&a, " 다 ").unwrap();
        assert_eq!(renamed, root.join("다"));
        assert!(!a.exists());
        assert_eq!(Workspace::read_id(&renamed).as_deref(), Some(id.as_str()));
        let arranged = order::arranged(&root);
        assert_eq!(
            arranged
                .iter()
                .map(|a| (a.summary.name.as_str(), a.hidden))
                .collect::<Vec<_>>(),
            vec![("나", false), ("다", true)]
        );
        // By its new name in the file too, not only through the ID matching alone.
        let saved = order::load(&root);
        assert_eq!(saved.order[1], entry(&id, "다"));
        assert_eq!(saved.hidden, vec![entry(&id, "다")]);
        assert!(core.recent().contains(&renamed));
        assert!(!core.recent().contains(&a));
        let saved = LaunchState::load(&core.paths.launch_file()).unwrap();
        assert!(saved.recent.contains(&renamed));
    }

    #[test]
    fn a_name_is_held_to_the_rules_of_a_new_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = create(&core, "가");
        create(&core, "나");
        for bad in ["", "a/b", ".숨김", "a:b"] {
            assert!(
                matches!(
                    core.rename_workspace(&a, bad),
                    Err(WorkspaceError::InvalidName(_))
                ),
                "{bad}"
            );
        }
        assert!(matches!(
            core.rename_workspace(&a, "나"),
            Err(WorkspaceError::AlreadyExists(_))
        ));
        assert!(a.exists());
        // Only the case: another name to the person, the same folder to APFS.
        let upper = create(&core, "memo");
        let renamed = core.rename_workspace(&upper, "Memo").unwrap();
        assert_eq!(renamed.file_name().unwrap(), "Memo");
        // The same name changes nothing.
        assert_eq!(core.rename_workspace(&a, "가").unwrap(), a);
    }

    #[test]
    fn a_workspace_a_window_shows_is_neither_renamed_nor_trashed() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = create(&core, "가");
        let label = show(&core, &a);
        let err = core.rename_workspace(&a, "다").unwrap_err();
        assert!(is_in_use(&err), "{err}");
        assert_eq!(command_error(err).code, "workspace-open");
        let mut trashed = false;
        let err = core
            .trash_workspace(&a, |_| {
                trashed = true;
                Ok(())
            })
            .unwrap_err();
        assert!(is_in_use(&err), "{err}");
        assert!(!trashed);
        assert!(a.exists());
        // Nor while a window is being opened on it.
        core.closed(&label);
        let opening = core.reserve(&a).unwrap();
        assert!(is_in_use(&core.rename_workspace(&a, "다").unwrap_err()));
        core.release(&opening);
        assert!(core.rename_workspace(&a, "다").is_ok());
    }

    #[test]
    fn only_a_workspace_directly_under_the_root_is_renamed_or_trashed() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = create(&core, "가");
        let plain = core.workspace_root().join("그냥 폴더");
        fs::create_dir_all(&plain).unwrap();
        let outside = Workspace::create(dir.path(), "밖")
            .unwrap()
            .root()
            .to_path_buf();
        for path in [plain.clone(), outside.clone(), a.join(".tote")] {
            assert!(
                matches!(
                    core.rename_workspace(&path, "다"),
                    Err(WorkspaceError::NotAWorkspace(_))
                ),
                "{}",
                path.display()
            );
            assert!(matches!(
                core.trash_workspace(&path, |_| Ok(())),
                Err(WorkspaceError::NotAWorkspace(_))
            ));
            assert!(core.workspace_memo_count(&path).is_err());
        }
        assert!(plain.exists() && outside.exists());
    }

    #[test]
    fn a_trashed_workspace_goes_where_it_is_handed_and_leaves_the_order_and_recent_list() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = create(&core, "가");
        let b = create(&core, "나");
        let mut workspace = Workspace::open(&a).unwrap();
        workspace.import_memo("하나.md", b"1").unwrap();
        workspace.import_memo("둘.md", b"2").unwrap();
        workspace.create_memo("md", b"").unwrap();
        let memo = workspace.import_memo("셋.md", b"3").unwrap();
        workspace.trash_memo(&memo.id, 1000).unwrap();
        drop(workspace);
        // What is in the trash of tote is not counted: it goes along, but it is not a memo.
        assert_eq!(core.workspace_memo_count(&a).unwrap(), 3);
        let id = Workspace::read_id(&a).unwrap();
        let root = fs::canonicalize(core.workspace_root()).unwrap();
        let entry = |id: &str, name: &str| Entry {
            id: id.into(),
            name: name.into(),
        };
        let other = entry(&Workspace::read_id(&b).unwrap(), "나");
        order::save(
            &root,
            &WorkspaceOrder {
                order: vec![entry(&id, "가"), other.clone()],
                hidden: vec![entry(&id, "가")],
            },
        )
        .unwrap();
        let label = show(&core, &a);
        core.closed(&label);
        let bin = dir.path().join("Trash");
        fs::create_dir_all(&bin).unwrap();
        core.trash_workspace(&a, |path| {
            fs::rename(path, bin.join(path.file_name().unwrap()))
        })
        .unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read(bin.join("가").join("하나.md")).unwrap(), b"1");
        assert_eq!(
            order::load(&root),
            WorkspaceOrder {
                order: vec![other],
                hidden: vec![],
            }
        );
        assert!(!core.recent().contains(&a));
        // A trash that fails leaves everything as it was.
        let err = core
            .trash_workspace(&b, |_| Err(io::Error::other("no trash on this volume")))
            .unwrap_err();
        assert!(err.to_string().contains("no trash"), "{err}");
        assert!(b.exists());
    }

    #[test]
    fn a_memo_moves_to_a_workspace_no_window_shows() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = create(&core, "가");
        let b = create(&core, "나");
        let label = show(&core, &a);
        let memo = lock(&core.workspace(&label).unwrap())
            .import_memo("회의록.md", b"# agenda")
            .unwrap();
        let moved = core
            .move_memo_out(&label, &memo.id, &b, &FileOps::SYSTEM)
            .unwrap();
        assert_eq!(moved.workspace, "나");
        assert_eq!(moved.info.file, "회의록.md");
        assert!(moved.windows.is_empty());
        assert!(lock(&core.workspace(&label).unwrap())
            .list_memos()
            .unwrap()
            .is_empty());
        let mut target = Workspace::open(&b).unwrap();
        assert_eq!(target.memo_info(&moved.info.id).unwrap().file, "회의록.md");
        assert_eq!(target.list_memos().unwrap().len(), 1);
        // Opened only for the move.
        assert!(!core.is_open_path(&b));
    }

    #[test]
    fn a_memo_moves_into_the_open_workspace_of_another_window_which_is_told() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = create(&core, "가");
        let b = create(&core, "나");
        let here = show(&core, &a);
        let there = show(&core, &b);
        let memo = lock(&core.workspace(&here).unwrap())
            .import_memo("a.md", b"text")
            .unwrap();
        let moved = core
            .move_memo_out(&here, &memo.id, &b, &FileOps::SYSTEM)
            .unwrap();
        assert_eq!(moved.windows, vec![there.clone()]);
        // The open workspace has it, recorded as tote's own: its watcher stays quiet.
        let target = core.workspace(&there).unwrap();
        assert_eq!(
            lock(&target).memo_info(&moved.info.id).unwrap().file,
            "a.md"
        );
        assert!(lock(&target).held_hash("a.md").is_some());
        // And the way back, with the two locks taken the other way round.
        let back = core
            .move_memo_out(&there, &moved.info.id, &a, &FileOps::SYSTEM)
            .unwrap();
        assert_eq!(back.windows, vec![here.clone()]);
        assert!(lock(&target).list_memos().unwrap().is_empty());
    }

    #[test]
    fn a_memo_does_not_move_into_a_workspace_a_window_is_opening_and_says_so_with_a_code() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = create(&core, "가");
        let b = create(&core, "나");
        let label = show(&core, &a);
        let memo = lock(&core.workspace(&label).unwrap())
            .import_memo("a.md", b"text")
            .unwrap();
        let opening = core.reserve(&b).unwrap();
        let err = core
            .move_memo_out(&label, &memo.id, &b, &FileOps::SYSTEM)
            .unwrap_err();
        // A code of its own: the frontend words it, and an `io` would show the English message.
        assert_eq!(command_error(err).code, "workspace-opening");
        assert!(lock(&core.workspace(&label).unwrap())
            .memo_info(&memo.id)
            .is_ok());
        core.release(&opening);
        assert!(core
            .move_memo_out(&label, &memo.id, &b, &FileOps::SYSTEM)
            .is_ok());
    }

    #[test]
    fn a_memo_does_not_move_to_its_own_workspace_nor_out_of_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = create(&core, "가");
        let label = show(&core, &a);
        let memo = lock(&core.workspace(&label).unwrap())
            .import_memo("a.md", b"text")
            .unwrap();
        assert!(core
            .move_memo_out(&label, &memo.id, &a, &FileOps::SYSTEM)
            .is_err());
        let plain = core.workspace_root().join("그냥 폴더");
        fs::create_dir_all(&plain).unwrap();
        assert!(matches!(
            core.move_memo_out(&label, &memo.id, &plain, &FileOps::SYSTEM),
            Err(WorkspaceError::NotAWorkspace(_))
        ));
        assert_eq!(
            lock(&core.workspace(&label).unwrap())
                .memo_info(&memo.id)
                .unwrap()
                .file,
            "a.md"
        );
    }

    #[test]
    fn file_targets_read_as_the_page_sends_them() {
        let targets: Vec<FileTarget> = serde_json::from_str(
            r#"[{"kind":"memo","id":"m"},{"kind":"external","path":"/a/b.txt"},{"kind":"trashed","id":"t"}]"#,
        )
        .unwrap();
        assert!(matches!(&targets[0], FileTarget::Memo { id } if id == "m"));
        assert!(matches!(&targets[1], FileTarget::External { path } if path == "/a/b.txt"));
        assert!(matches!(&targets[2], FileTarget::Trashed { id } if id == "t"));
        assert_eq!(
            serde_json::to_value(MoveOutcome::Elsewhere).unwrap(),
            serde_json::json!({"kind": "elsewhere"})
        );
    }
}
