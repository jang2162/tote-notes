//! A workspace is a folder tote made (it has `.tote/workspace.json`). Its memos are the files
//! directly inside it, known by ID through `.tote/index.json` and never by path: automatic titles
//! rename files, and sync must still recognise a renamed file as the same memo.

pub mod index;
pub mod memo;
pub mod names;
mod ops;
pub mod order;
pub mod viewed;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::persist::{content_hash, is_temp_file, read_json, write_json};
use index::MemoIndex;
use names::is_valid_file_name;
use viewed::ViewedTimes;

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
    /// A write since the last backup took it (`take_changed`).
    changed: bool,
    /// File name → hash of the bytes tote last wrote there. A change the watcher sees with that
    /// hash is tote's own write (spec 「외부 변경」).
    last_written: BTreeMap<String, String>,
    /// File name → `index::file_id`, kept through tote's own writes and renames, so a rename by
    /// another app is told apart from a removal and a new file.
    inodes: BTreeMap<String, (u64, u64)>,
    /// When each memo was last on show (`attach_viewed`); none until the app attaches them.
    viewed: Option<ViewedTimes>,
}

/// What `apply_fs_events` found another app did to the workspace.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Change {
    Modified {
        id: String,
    },
    Added {
        id: String,
        file: String,
    },
    Removed {
        id: String,
        file: String,
    },
    Renamed {
        id: String,
        from: String,
        to: String,
    },
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
        let inodes = index::file_ids(&root, &index);
        Ok(Workspace {
            root,
            id: meta.id,
            index,
            // Opening counts as a change: the last stretch before the previous close may be in no
            // snapshot, so the first round after opening takes this state.
            changed: true,
            last_written: BTreeMap::new(),
            inodes,
            viewed: None,
        })
    }

    /// The ID of the workspace at `path` without opening it. Unlike `open`, an unreadable
    /// `workspace.json` is left where it is and gives `None`: listing must not change anything.
    pub fn read_id(path: &Path) -> Option<String> {
        let bytes = fs::read(path.join(TOTE_DIR).join("workspace.json")).ok()?;
        serde_json::from_slice::<WorkspaceFile>(&bytes)
            .ok()
            .map(|meta| meta.id)
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

    /// The memos' viewed times, kept outside the workspace (`viewed`).
    pub fn attach_viewed(&mut self, mut viewed: ViewedTimes) {
        viewed.retain(|id| self.index.get(id).is_some());
        self.viewed = Some(viewed);
    }

    /// The memo was on show at `ms`: the generation to write it at (`save_viewed_if`).
    pub fn memo_viewed(&mut self, id: &str, ms: u64) -> Result<u64, WorkspaceError> {
        self.entry(id)?;
        Ok(self
            .viewed
            .as_mut()
            .map_or(0, |viewed| viewed.record(id, ms)))
    }

    /// Writes the viewed times when no view came after `generation`.
    pub fn save_viewed_if(&mut self, generation: u64) -> io::Result<bool> {
        self.viewed
            .as_mut()
            .map_or(Ok(false), |viewed| viewed.save_if(generation))
    }

    /// Writes any viewed time not written yet: a window closes or the app quits.
    pub fn save_viewed_now(&mut self) -> io::Result<()> {
        self.viewed.as_mut().map_or(Ok(()), ViewedTimes::save_now)
    }

    pub(crate) fn viewed_ms(&self, id: &str) -> Option<u64> {
        self.viewed.as_ref()?.get(id)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Something in the workspace is about to be written: the next backup round snapshots it.
    /// Marked before the disk is touched, so a write that fails half way still counts.
    pub fn mark_changed(&mut self) {
        self.changed = true;
    }

    /// Whether anything was written since the last call; clears the mark. A round that could not
    /// take everything marks it again.
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    /// The hash of what tote last wrote to `file`, if it wrote it since the workspace opened.
    pub fn last_written(&self, file: &str) -> Option<&str> {
        self.last_written.get(file).map(String::as_str)
    }

    pub fn inodes(&self) -> &BTreeMap<String, (u64, u64)> {
        &self.inodes
    }

    /// Brings the index in line with what the watcher saw: `touched` are the file names in one
    /// batch, `renames` the from → to pairs the watcher paired itself. In order: those pairs; a
    /// file gone and a new one with its inode are a rename; what is left gone is removed and new
    /// is added (`autoTitle: false`, spec 「rename 을 놓치면 새 메모」); a file still there changed
    /// unless it hashes like tote's last write to it.
    ///
    /// Whether a name is there is read from the folder listing, not by looking the name up: APFS
    /// finds `memo.md` when the file is `Memo.md`, which would hide a case-only rename.
    pub fn apply_fs_events(
        &mut self,
        touched: &BTreeSet<String>,
        renames: &[(String, String)],
    ) -> io::Result<Vec<Change>> {
        let listed = index::entry_names(&self.root)?;
        let present = |file: &str| {
            listed.contains(file) && fs::metadata(self.root.join(file)).is_ok_and(|m| m.is_file())
        };
        let mut touched: BTreeSet<String> = touched
            .iter()
            .filter(|f| is_memo_name(f))
            .cloned()
            .collect();
        let mut renamed: Vec<(String, String, String)> = Vec::new();
        for (from, to) in renames {
            // Some platforms report one rename twice.
            if renamed.iter().any(|(_, f, t)| f == from && t == to) {
                continue;
            }
            let pair = (is_memo_name(from) && is_memo_name(to) && present(to))
                .then(|| self.id_of(from))
                .flatten()
                .filter(|_| self.id_of(to).is_none() && !present(from));
            match pair {
                Some(id) => renamed.push((id, from.clone(), to.clone())),
                None => touched.extend([from, to].into_iter().filter(|f| is_memo_name(f)).cloned()),
            }
        }
        // A write just before the rename puts its ends in `touched` too; seen there, `from` would
        // count as gone and the renamed memo would be removed.
        for (_, from, to) in &renamed {
            touched.remove(from);
            touched.remove(to);
        }

        let by_file: BTreeMap<String, String> = self
            .index
            .iter()
            .map(|(id, entry)| (entry.file.clone(), id.clone()))
            .collect();
        let mut gone = Vec::new();
        let mut new = Vec::new();
        let mut stayed = Vec::new();
        for file in &touched {
            match (by_file.get(file), present(file)) {
                (Some(id), false) => gone.push((id.clone(), file.clone())),
                (Some(id), true) => stayed.push((id.clone(), file.clone())),
                (None, true) => new.push(file.clone()),
                (None, false) => {}
            }
        }
        let mut removed = Vec::new();
        for (id, from) in gone {
            let inode = self.inodes.get(&from).copied();
            let same = inode.and_then(|inode| {
                new.iter()
                    .position(|to| index::file_id(&self.root.join(to)) == Some(inode))
            });
            match same {
                Some(at) => renamed.push((id, from, new.remove(at))),
                None => removed.push((id, from)),
            }
        }

        let mut changes = Vec::new();
        for (id, from, to) in renamed {
            self.follow_rename(&id, &from, &to);
            changes.push(Change::Renamed { id, from, to });
        }
        for (id, file) in removed {
            self.index.remove(&id);
            self.last_written.remove(&file);
            self.inodes.remove(&file);
            changes.push(Change::Removed { id, file });
        }
        for file in new {
            let id = new_id();
            self.index.insert(
                id.clone(),
                index::MemoEntry {
                    file: file.clone(),
                    auto_title: false,
                    language: None,
                    pinned: false,
                },
            );
            self.track_inode(&file);
            changes.push(Change::Added { id, file });
        }
        let index_changed = !changes.is_empty();
        for (id, file) in stayed {
            self.track_inode(&file);
            // Only what tote wrote is worth reading to compare; anything else changed.
            let ours = match self.last_written.get(&file) {
                Some(hash) => {
                    fs::read(self.root.join(&file)).is_ok_and(|bytes| content_hash(&bytes) == *hash)
                }
                None => false,
            };
            if !ours {
                // No longer what tote wrote: tote's next write there sets it again.
                self.last_written.remove(&file);
                changes.push(Change::Modified { id });
            }
        }

        if !changes.is_empty() {
            self.mark_changed();
        }
        // The changes stand even so: dropping them would hide another app's edit, which tote's next
        // save would then write over. The index is written again with the next change to it.
        if index_changed {
            if let Err(err) = self.index.save() {
                eprintln!("tote: could not save the index of {}: {err}", self.name());
            }
        }
        Ok(changes)
    }

    /// `inodes` and `last_written` for what the index holds now, after it changed without the
    /// watcher (`list_memos`).
    pub(super) fn resync_files(&mut self) {
        self.inodes = index::file_ids(&self.root, &self.index);
        let files: BTreeSet<&String> = self.index.iter().map(|(_, entry)| &entry.file).collect();
        self.last_written.retain(|file, _| files.contains(file));
    }

    fn id_of(&self, file: &str) -> Option<String> {
        self.index
            .iter()
            .find(|(_, entry)| entry.file == file)
            .map(|(id, _)| id.clone())
    }

    /// Another app renamed the memo's file. The name is the person's now, so automatic titles
    /// stop — or the next keystroke would rename it back.
    fn follow_rename(&mut self, id: &str, from: &str, to: &str) {
        if let Some(entry) = self.index.get_mut(id) {
            if !names::split_name(from)
                .1
                .eq_ignore_ascii_case(names::split_name(to).1)
            {
                entry.language = None;
            }
            entry.file = to.to_string();
            entry.auto_title = false;
        }
        if let Some(hash) = self.last_written.remove(from) {
            self.last_written.insert(to.to_string(), hash);
        }
        self.inodes.remove(from);
        self.track_inode(to);
    }

    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

/// A name that can be a memo: dot files are not, which also leaves out `.tote/` and tote's
/// temporary files (`index::memo_files`).
fn is_memo_name(file: &str) -> bool {
    !file.is_empty() && !file.starts_with('.')
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

    /// The shape `WorkspaceChange` in src/backend/types.ts reads from `tote://outside`.
    #[test]
    fn changes_serialize_as_the_frontend_reads_them() {
        let json = |change: Change| serde_json::to_value(change).unwrap();
        assert_eq!(
            json(Change::Added {
                id: "i".into(),
                file: "새.md".into()
            }),
            serde_json::json!({"kind": "added", "id": "i", "file": "새.md"})
        );
        assert_eq!(
            json(Change::Removed {
                id: "i".into(),
                file: "옛.md".into()
            }),
            serde_json::json!({"kind": "removed", "id": "i", "file": "옛.md"})
        );
        assert_eq!(
            json(Change::Renamed {
                id: "i".into(),
                from: "a.md".into(),
                to: "b.md".into()
            }),
            serde_json::json!({"kind": "renamed", "id": "i", "from": "a.md", "to": "b.md"})
        );
    }

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

    fn names(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let root = tempfile::tempdir().unwrap();
        let ws = Workspace::create(root.path(), "w").unwrap();
        (root, ws)
    }

    #[test]
    fn an_opened_workspace_starts_changed() {
        let (_root, mut ws) = workspace();
        assert!(ws.take_changed(), "the first round after opening takes it");
        assert!(!ws.take_changed());
    }

    #[test]
    fn a_change_that_hashes_like_our_last_write_is_ignored() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        ws.write_memo(&memo.id, "# 회의".as_bytes()).unwrap();
        assert_eq!(
            ws.last_written("untitled.md"),
            Some(crate::persist::content_hash("# 회의".as_bytes()).as_str())
        );
        ws.take_changed();
        let seen = names(&["untitled.md", ".tote-tmp-0"]);
        assert_eq!(ws.apply_fs_events(&seen, &[]).unwrap(), vec![]);
        assert!(!ws.take_changed(), "our own write is not another change");

        // tote's own renames carry the hash along, so they are not someone else's either.
        ws.retitle_memo(&memo.id, "회의").unwrap();
        let seen = names(&["untitled.md", "회의.md"]);
        assert_eq!(ws.apply_fs_events(&seen, &[]).unwrap(), vec![]);
        ws.retitle_memo(&memo.id, "Meeting").unwrap();
        ws.retitle_memo(&memo.id, "MEETING").unwrap();
        let seen = names(&["회의.md", "Meeting.md", "MEETING.md"]);
        assert_eq!(ws.apply_fs_events(&seen, &[]).unwrap(), vec![]);
        // Even a memo tote never wrote: it was there when the workspace opened.
        fs::write(ws.root().join("옛 메모.md"), "그대로").unwrap();
        let mut ws = Workspace::open(ws.root()).unwrap();
        let old = ws.list_memos().unwrap();
        let old = old.iter().find(|m| m.file == "옛 메모.md").unwrap();
        ws.rename_memo(&old.id, "새 이름.md").unwrap();
        let seen = names(&["옛 메모.md", "새 이름.md"]);
        assert_eq!(ws.apply_fs_events(&seen, &[]).unwrap(), vec![]);
    }

    #[test]
    fn a_change_by_another_app_is_modified() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"ours").unwrap();
        ws.take_changed();
        fs::write(ws.root().join(&memo.file), "theirs").unwrap();
        assert_eq!(
            ws.apply_fs_events(&names(&[&memo.file]), &[]).unwrap(),
            vec![Change::Modified {
                id: memo.id.clone()
            }]
        );
        assert!(ws.take_changed(), "the next backup takes it");
    }

    #[test]
    fn a_rename_pair_updates_the_index_and_keeps_the_id() {
        // macOS never pairs renames (FSEvents reports each path alone), so this test is the only
        // thing holding the paired branch.
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"x").unwrap();
        fs::rename(ws.root().join("untitled.md"), ws.root().join("회의.md")).unwrap();
        let pair = [("untitled.md".to_string(), "회의.md".to_string())];
        assert_eq!(
            ws.apply_fs_events(&BTreeSet::new(), &pair).unwrap(),
            vec![Change::Renamed {
                id: memo.id.clone(),
                from: "untitled.md".into(),
                to: "회의.md".into()
            }]
        );
        let info = ws.memo_info(&memo.id).unwrap();
        assert_eq!(info.file, "회의.md");
        assert!(
            !info.auto_title,
            "a name given elsewhere is the person's own"
        );
        let reopened = Workspace::open(ws.root()).unwrap();
        assert_eq!(reopened.memo_info(&memo.id).unwrap().file, "회의.md");

        // A write just before the rename puts `from` in the batch too, and some platforms
        // report one rename twice: still one rename, and the memo stays.
        fs::rename(ws.root().join("회의.md"), ws.root().join("안건.md")).unwrap();
        let pair = ("회의.md".to_string(), "안건.md".to_string());
        assert_eq!(
            ws.apply_fs_events(&names(&["회의.md"]), &[pair.clone(), pair])
                .unwrap(),
            vec![Change::Renamed {
                id: memo.id.clone(),
                from: "회의.md".into(),
                to: "안건.md".into()
            }]
        );
        assert_eq!(ws.memo_info(&memo.id).unwrap().file, "안건.md");
    }

    #[test]
    fn memos_tote_never_wrote_are_followed_through_a_rename() {
        let root = tempfile::tempdir().unwrap();
        Workspace::create(root.path(), "w").unwrap();
        let folder = root.path().join("w");
        // There before the workspace opened: opening records its inode.
        fs::write(folder.join("옛.md"), "x").unwrap();
        let mut ws = Workspace::open(&folder).unwrap();
        let old = ws.id_of("옛.md").unwrap();
        fs::rename(folder.join("옛.md"), folder.join("새.md")).unwrap();
        assert_eq!(
            ws.apply_fs_events(&names(&["옛.md", "새.md"]), &[])
                .unwrap(),
            vec![Change::Renamed {
                id: old,
                from: "옛.md".into(),
                to: "새.md".into()
            }]
        );
        // Found by the memo list rather than the watcher: listing records its inode.
        fs::write(folder.join("늦게.md"), "y").unwrap();
        ws.list_memos().unwrap();
        let late = ws.id_of("늦게.md").unwrap();
        fs::rename(folder.join("늦게.md"), folder.join("나중.md")).unwrap();
        assert_eq!(
            ws.apply_fs_events(&names(&["늦게.md", "나중.md"]), &[])
                .unwrap(),
            vec![Change::Renamed {
                id: late,
                from: "늦게.md".into(),
                to: "나중.md".into()
            }]
        );
        // A file the listing drops leaves nothing behind.
        fs::remove_file(folder.join("나중.md")).unwrap();
        ws.list_memos().unwrap();
        assert!(!ws.inodes().contains_key("나중.md"));
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_index_save_still_reports_the_changes() {
        // Dropping them would bury another app's edit: no banner, and tote's next save of the
        // memo would write over it.
        use std::os::unix::fs::PermissionsExt;
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"ours").unwrap();
        fs::write(ws.root().join(&memo.file), "theirs").unwrap();
        fs::write(ws.root().join("new.md"), "new").unwrap();
        let tote = ws.root().join(TOTE_DIR);
        fs::set_permissions(&tote, fs::Permissions::from_mode(0o555)).unwrap();
        let result = ws.apply_fs_events(&names(&[&memo.file, "new.md"]), &[]);
        fs::set_permissions(&tote, fs::Permissions::from_mode(0o755)).unwrap();
        let changes = result.expect("the changes, even though the index was not saved");
        assert!(changes.contains(&Change::Modified {
            id: memo.id.clone()
        }));
        assert!(changes
            .iter()
            .any(|c| matches!(c, Change::Added { file, .. } if file == "new.md")));
    }

    #[test]
    fn a_rename_seen_only_as_remove_and_create_is_matched_by_inode() {
        let (_root, mut ws) = workspace();
        let memo = ws.import_memo("메모.md", b"x").unwrap();
        fs::rename(ws.root().join("메모.md"), ws.root().join("이름.md")).unwrap();
        let renamed = Change::Renamed {
            id: memo.id.clone(),
            from: "메모.md".into(),
            to: "이름.md".into(),
        };
        let seen = names(&["메모.md", "이름.md"]);
        assert_eq!(ws.apply_fs_events(&seen, &[]).unwrap(), vec![renamed]);
        // Writing on goes to the new name; the old one does not come back.
        ws.write_memo(&memo.id, b"y").unwrap();
        assert_eq!(fs::read(ws.root().join("이름.md")).unwrap(), b"y");
        assert!(!ws.root().join("메모.md").exists());
        // Only the case changes: on APFS the old spelling still opens, so the folder decides.
        fs::rename(ws.root().join("이름.md"), ws.root().join("이름.MD")).unwrap();
        let seen = names(&["이름.md", "이름.MD"]);
        assert_eq!(
            ws.apply_fs_events(&seen, &[]).unwrap(),
            vec![Change::Renamed {
                id: memo.id.clone(),
                from: "이름.md".into(),
                to: "이름.MD".into()
            }]
        );
    }

    #[test]
    fn a_missed_rename_becomes_a_new_memo() {
        let (_root, mut ws) = workspace();
        let memo = ws.import_memo("a.md", b"x").unwrap();
        // Both exist for a moment, so `b.md` cannot get the inode `a.md` frees.
        fs::write(ws.root().join("b.md"), "x").unwrap();
        fs::remove_file(ws.root().join("a.md")).unwrap();
        let changes = ws.apply_fs_events(&names(&["a.md", "b.md"]), &[]).unwrap();
        let [Change::Removed { id, file }, Change::Added {
            id: new,
            file: added,
        }] = &changes[..]
        else {
            panic!("expected a removal and an addition, got {changes:?}");
        };
        assert_eq!(
            (id, file.as_str(), added.as_str()),
            (&memo.id, "a.md", "b.md")
        );
        assert!(matches!(
            ws.memo_info(&memo.id),
            Err(WorkspaceError::UnknownMemo(_))
        ));
        let info = ws.memo_info(new).unwrap();
        assert_eq!(info.file, "b.md");
        assert!(!info.auto_title, "tote did not name it");
    }

    #[test]
    fn tote_temp_files_and_dot_files_never_appear() {
        let (_root, mut ws) = workspace();
        ws.take_changed();
        fs::write(ws.root().join(".tote-tmp-x"), "half").unwrap();
        fs::write(ws.root().join(".DS_Store"), "finder").unwrap();
        let seen = names(&[".tote-tmp-x", ".DS_Store", ".tote"]);
        let pair = [(".tote-tmp-y".to_string(), ".DS_Store".to_string())];
        assert_eq!(ws.apply_fs_events(&seen, &pair).unwrap(), vec![]);
        assert!(ws.list_memos().unwrap().is_empty());
        assert!(!ws.take_changed());
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
