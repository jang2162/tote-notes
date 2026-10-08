//! A workspace is a folder tote made (it has `.tote/workspace.json`). Its memos are the files
//! directly inside it, known by ID through `.tote/index.json` and never by path: automatic titles
//! rename files, and sync must still recognise a renamed file as the same memo.

pub mod index;
pub mod memo;
pub mod names;
mod ops;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::persist::{is_temp_file, read_json, write_json};
use index::MemoIndex;
use names::is_valid_file_name;

pub use memo::{kind_for, FileKind, MemoInfo};

pub const TOTE_DIR: &str = ".tote";
/// Made on the first launch so there is somewhere to type right away.
pub const DEFAULT_WORKSPACE: &str = "메모";

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("not a tote workspace: {0}")]
    NotAWorkspace(PathBuf),
    #[error("already exists: {0}")]
    AlreadyExists(PathBuf),
    #[error("invalid name: {0}")]
    InvalidName(String),
    #[error("no memo with id {0}")]
    UnknownMemo(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// `.tote/workspace.json`. No name: a workspace is named after its folder, so renaming the
/// folder in Finder cannot leave two names disagreeing.
#[derive(Serialize, Deserialize)]
struct WorkspaceFile {
    version: u32,
    id: String,
}

pub struct Workspace {
    root: PathBuf,
    id: String,
    index: MemoIndex,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub name: String,
    pub path: PathBuf,
}

impl Workspace {
    pub fn create(root: &Path, name: &str) -> Result<Workspace, WorkspaceError> {
        let name = name.trim();
        if !is_valid_file_name(name) {
            return Err(WorkspaceError::InvalidName(name.to_string()));
        }
        let path = root.join(name);
        if path.symlink_metadata().is_ok() {
            return Err(WorkspaceError::AlreadyExists(path));
        }
        write_json(
            &path.join(TOTE_DIR).join("workspace.json"),
            &WorkspaceFile {
                version: 1,
                id: new_id(),
            },
        )?;
        Workspace::open(&path)
    }

    pub fn open(path: &Path) -> Result<Workspace, WorkspaceError> {
        let file = path.join(TOTE_DIR).join("workspace.json");
        if !file.is_file() {
            return Err(WorkspaceError::NotAWorkspace(path.to_path_buf()));
        }
        let meta = match read_json::<WorkspaceFile>(&file)? {
            Some(meta) => meta,
            // Unreadable (read_json set it aside): a new ID keeps the memos usable; only state
            // keyed by the ID, such as this workspace's backups, starts over.
            None => {
                let meta = WorkspaceFile {
                    version: 1,
                    id: new_id(),
                };
                write_json(&file, &meta)?;
                meta
            }
        };
        let root = fs::canonicalize(path)?;
        remove_temp_files(&root);
        remove_temp_files_below(&root.join(TOTE_DIR));
        let index = MemoIndex::load(&root)?;
        Ok(Workspace {
            root,
            id: meta.id,
            index,
        })
    }

    pub fn is_workspace(path: &Path) -> bool {
        path.join(TOTE_DIR).join("workspace.json").is_file()
    }

    /// The workspaces directly under `root`, by name.
    pub fn list(root: &Path) -> Vec<WorkspaceSummary> {
        let Ok(entries) = fs::read_dir(root) else {
            return Vec::new();
        };
        let mut list: Vec<WorkspaceSummary> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let path = entry.path();
                (!name.starts_with('.') && Workspace::is_workspace(&path))
                    .then_some(WorkspaceSummary { name, path })
            })
            .collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Temporary files of writes that never reached their rename (the app died in between).
fn remove_temp_files(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_str().is_some_and(is_temp_file) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// `.tote/` itself and each folder directly inside it (`sessions/`, …). Symlinked folders are not
/// followed, and folders are not listed by name so a new one needs no change here.
fn remove_temp_files_below(tote_dir: &Path) {
    remove_temp_files(tote_dir);
    let Ok(entries) = fs::read_dir(tote_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            remove_temp_files(&entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn create_then_open_keeps_the_id() {
        let root = tempfile::tempdir().unwrap();
        let created = Workspace::create(root.path(), "업무 메모").unwrap();
        let opened = Workspace::open(&root.path().join("업무 메모")).unwrap();
        assert_eq!(created.id(), opened.id());
        assert_eq!(opened.name(), "업무 메모");
        assert!(uuid::Uuid::parse_str(opened.id()).is_ok());
        assert!(root.path().join("업무 메모/.tote/workspace.json").is_file());
        assert!(root.path().join("업무 메모/.tote/index.json").is_file());
    }

    #[test]
    fn create_refuses_bad_names_and_existing_folders() {
        let root = tempfile::tempdir().unwrap();
        for bad in ["", " ", ".숨김", "a/b", "a:b"] {
            assert!(matches!(
                Workspace::create(root.path(), bad),
                Err(WorkspaceError::InvalidName(_))
            ));
        }
        fs::create_dir(root.path().join("있음")).unwrap();
        assert!(matches!(
            Workspace::create(root.path(), "있음"),
            Err(WorkspaceError::AlreadyExists(_))
        ));
    }

    #[test]
    fn a_plain_folder_is_not_a_workspace() {
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(
            Workspace::open(root.path()),
            Err(WorkspaceError::NotAWorkspace(_))
        ));
    }

    #[test]
    fn an_unreadable_workspace_file_gets_a_new_id_and_is_set_aside() {
        let root = tempfile::tempdir().unwrap();
        let first = Workspace::create(root.path(), "w").unwrap();
        let file = root.path().join("w/.tote/workspace.json");
        fs::write(&file, "nope").unwrap();
        let reopened = Workspace::open(&root.path().join("w")).unwrap();
        assert_ne!(reopened.id(), first.id());
        let aside = fs::read_dir(root.path().join("w/.tote"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("workspace.json.corrupt-")
            })
            .count();
        assert_eq!(aside, 1);
    }

    #[test]
    fn list_finds_only_workspaces() {
        let root = tempfile::tempdir().unwrap();
        Workspace::create(root.path(), "나").unwrap();
        Workspace::create(root.path(), "가").unwrap();
        fs::create_dir(root.path().join("그냥 폴더")).unwrap();
        let names: Vec<String> = Workspace::list(root.path())
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["가", "나"]);
    }

    #[test]
    fn opening_removes_leftover_temp_files() {
        let root = tempfile::tempdir().unwrap();
        Workspace::create(root.path(), "w").unwrap();
        let leftover = root.path().join("w/.tote-tmp-deadbeef");
        fs::write(&leftover, "half").unwrap();
        let in_tote = root.path().join("w/.tote/.tote-tmp-deadbeef");
        fs::write(&in_tote, "half").unwrap();
        let sessions = root.path().join("w/.tote/sessions");
        fs::create_dir_all(&sessions).unwrap();
        let in_sessions = sessions.join(".tote-tmp-deadbeef");
        fs::write(&in_sessions, "half").unwrap();
        Workspace::open(&root.path().join("w")).unwrap();
        assert!(!leftover.exists());
        assert!(!in_tote.exists());
        assert!(!in_sessions.exists());
    }
}
