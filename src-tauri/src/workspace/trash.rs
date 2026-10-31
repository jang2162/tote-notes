//! The workspace's trash (memo trash spec 「저장」): a trashed memo is `.trash/<id>/<file>`, and
//! what it was (its name, when it was trashed, automatic titles, language, pin) is in
//! `.trash/trash.json`. The folders are the original: the information is brought in line with
//! them on every read, as `index.json` is with the memo files.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::index::MemoEntry;
use super::names::split_name;
use super::{kind_for, FileKind, MemoInfo, Workspace, WorkspaceError};
use crate::persist::{read_editable_text, read_json, write_json};

pub const TRASH_DIR: &str = ".trash";
const TRASH_FILE: &str = "trash.json";
pub const DAY_MS: u64 = 86_400_000;

/// A memo in the trash, as the trash list shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedInfo {
    pub id: String,
    pub file: String,
    pub deleted_ms: u64,
    pub auto_title: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    pub kind: FileKind,
}

/// One item of `trash.json`. `language` and `pinned` are written only when set, as in
/// `index.json`'s `MemoEntry`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashEntry {
    file: String,
    deleted_at: u64,
    auto_title: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pinned: bool,
}

#[derive(Serialize, Deserialize)]
struct TrashFile {
    version: u32,
    items: BTreeMap<String, TrashEntry>,
}

impl Workspace {
    /// Moves the memo's file to `.trash/<id>/`, drops it from the index and records it in
    /// `trash.json`, in that order: whenever the app dies in between, the memo is still in the
    /// memo list (its file not moved yet) or in the trash (`load_trash` finds its folder).
    ///
    /// The file leaves the folder the watcher looks at, and the index forgets it first, so the
    /// watcher's event for its old name finds nothing to report.
    pub fn trash_memo(&mut self, id: &str, now_ms: u64) -> Result<TrashedInfo, WorkspaceError> {
        let entry = self.entry(id)?.clone();
        let folder = self.trash_dir().join(id);
        if fs::read_dir(&folder).is_ok_and(|mut entries| entries.next().is_some()) {
            return Err(WorkspaceError::AlreadyExists(folder));
        }
        self.mark_changed();
        fs::create_dir_all(&folder)?;
        if let Err(err) = fs::rename(self.root.join(&entry.file), folder.join(&entry.file)) {
            let _ = fs::remove_dir(&folder);
            return Err(err.into());
        }
        self.went_out(&entry.file);
        self.index.remove(id);
        self.previews.borrow_mut().remove(id);
        self.index.save()?;
        if let Some(viewed) = self.viewed.as_mut() {
            viewed.retain(|each| each != id);
        }
        // The folder is in by now, so the reconciling read has given it the defaults; the real
        // record replaces them.
        let mut items = self.load_trash(now_ms)?;
        let item = TrashEntry {
            file: entry.file,
            deleted_at: now_ms,
            auto_title: entry.auto_title,
            language: entry.language,
            pinned: entry.pinned,
        };
        items.insert(id.to_string(), item.clone());
        self.save_trash(&items)?;
        Ok(info(id, &item))
    }

    /// The trash, most recently trashed first.
    pub fn list_trash(&mut self, now_ms: u64) -> Result<Vec<TrashedInfo>, WorkspaceError> {
        let items = self.load_trash(now_ms)?;
        let mut list: Vec<TrashedInfo> = items.iter().map(|(id, item)| info(id, item)).collect();
        list.sort_by(|a, b| {
            b.deleted_ms
                .cmp(&a.deleted_ms)
                .then_with(|| a.file.cmp(&b.file))
        });
        Ok(list)
    }

    /// The trashed memo's bytes, refused as `read_memo` refuses what is not text, and unread when
    /// it is over the editor's limit: the trash list carries no size for the page to check first,
    /// as a memo tab does. The folder is the original, so `trash.json` is not needed to find it.
    pub fn read_trashed(&self, id: &str) -> Result<Vec<u8>, WorkspaceError> {
        let file = self
            .trashed_file(id, None)
            .ok_or_else(|| WorkspaceError::UnknownMemo(id.to_string()))?;
        Ok(read_editable_text(&self.trash_dir().join(id).join(file))?)
    }

    /// Puts the memo back under its ID with its automatic titles, language and pin. A name another
    /// file took since gets a number as a new memo's would (`free_name`); nothing is written over.
    pub fn restore_memo(&mut self, id: &str) -> Result<MemoInfo, WorkspaceError> {
        let mut items = self.load_trash(system_now_ms())?;
        let item = items
            .get(id)
            .cloned()
            .ok_or_else(|| WorkspaceError::UnknownMemo(id.to_string()))?;
        if self.index.get(id).is_some() {
            return Err(WorkspaceError::AlreadyExists(self.root.join(&item.file)));
        }
        let (stem, ext) = split_name(&item.file);
        let file = self.free_name(stem, ext, None);
        let folder = self.trash_dir().join(id);
        self.mark_changed();
        fs::rename(folder.join(&item.file), self.root.join(&file))?;
        // Recorded as tote's own before the watcher hears of it.
        self.came_in(&file);
        self.index.insert(
            id.to_string(),
            MemoEntry {
                file,
                auto_title: item.auto_title,
                language: item.language,
                pinned: item.pinned,
            },
        );
        self.index.save()?;
        items.remove(id);
        self.save_trash(&items)?;
        remove_folder(&folder)?;
        self.memo_info(id)
    }

    /// Removes the trashed memo for good: its folder first, so dying before `trash.json` is
    /// written leaves nothing to find again.
    pub fn purge_trashed(&mut self, id: &str) -> Result<(), WorkspaceError> {
        let mut items = self.load_trash(system_now_ms())?;
        if items.remove(id).is_none() {
            return Err(WorkspaceError::UnknownMemo(id.to_string()));
        }
        remove_folder(&self.trash_dir().join(id))?;
        self.save_trash(&items)?;
        Ok(())
    }

    /// Removes everything in the trash for good; the number of memos removed.
    pub fn empty_trash(&mut self) -> Result<usize, WorkspaceError> {
        let items = self.load_trash(system_now_ms())?;
        let ids: Vec<String> = items.keys().cloned().collect();
        self.remove_trashed(items, &ids)?;
        Ok(ids.len())
    }

    /// Removes the memos trashed more than `retention_days` before `now_ms` (memo trash spec
    /// 「자동 비우기」); none when `None`. One trashed after `now_ms` (the clock went back) stays,
    /// and so does one whose time had to be made up, since that is the time it was found.
    pub fn expire_trash(
        &mut self,
        now_ms: u64,
        retention_days: Option<u32>,
    ) -> Result<Vec<String>, WorkspaceError> {
        let Some(days) = retention_days else {
            return Ok(Vec::new());
        };
        if !self.trash_dir().is_dir() {
            return Ok(Vec::new());
        }
        let items = self.load_trash(now_ms)?;
        let cutoff = now_ms.saturating_sub(u64::from(days) * DAY_MS);
        let ids: Vec<String> = items
            .iter()
            .filter(|(_, item)| item.deleted_at < cutoff)
            .map(|(id, _)| id.clone())
            .collect();
        if !ids.is_empty() {
            self.remove_trashed(items, &ids)?;
        }
        Ok(ids)
    }

    fn remove_trashed(
        &mut self,
        mut items: BTreeMap<String, TrashEntry>,
        ids: &[String],
    ) -> Result<(), WorkspaceError> {
        for id in ids {
            remove_folder(&self.trash_dir().join(id))?;
            items.remove(id);
        }
        self.save_trash(&items)?;
        Ok(())
    }

    fn trash_dir(&self) -> PathBuf {
        self.root.join(TRASH_DIR)
    }

    /// `trash.json` brought in line with the folders: an item whose folder (or file) is gone is
    /// dropped; a folder with no item — moved in just before the app died, or `trash.json` was
    /// missing or unreadable (set aside by `read_json`) — joins as trashed at `now_ms` with the
    /// defaults (spec 「저장」: a folder's modified time is changed by copies and sync, so it cannot
    /// say when; now restarts the count and so never expires anything early). Written back when
    /// that changed anything.
    fn load_trash(&self, now_ms: u64) -> Result<BTreeMap<String, TrashEntry>, WorkspaceError> {
        let dir = self.trash_dir();
        let read = read_json::<TrashFile>(&dir.join(TRASH_FILE))?;
        let mut changed = read.is_none();
        let mut items = read.map(|file| file.items).unwrap_or_default();
        let folders = trash_folders(&dir)?;
        let before = items.len();
        items.retain(|id, _| folders.contains(id));
        changed |= items.len() != before;
        for id in &folders {
            let known = items.get(id).map(|item| item.file.clone());
            match (self.trashed_file(id, known.as_deref()), known) {
                (None, _) => {
                    changed |= items.remove(id).is_some();
                }
                (Some(file), Some(known)) if file == known => {}
                (Some(file), Some(_)) => {
                    if let Some(item) = items.get_mut(id) {
                        item.file = file;
                    }
                    changed = true;
                }
                (Some(file), None) => {
                    items.insert(
                        id.clone(),
                        TrashEntry {
                            file,
                            deleted_at: now_ms,
                            auto_title: false,
                            language: None,
                            pinned: false,
                        },
                    );
                    changed = true;
                }
            }
        }
        // Listing a workspace that never trashed anything leaves it without a `.trash`.
        if changed && dir.is_dir() {
            self.save_trash(&items)?;
        }
        Ok(items)
    }

    fn save_trash(&self, items: &BTreeMap<String, TrashEntry>) -> io::Result<()> {
        write_json(
            &self.trash_dir().join(TRASH_FILE),
            &TrashFile {
                version: 1,
                items: items.clone(),
            },
        )
    }

    /// The file in `.trash/<id>/`: `known` when it is there, else the first by name. Dot files
    /// (Finder's, tote's temporary ones) are not memos. `None` for an ID that is not a folder
    /// directly in the trash, which also keeps a path in `id` from reaching out of it.
    fn trashed_file(&self, id: &str, known: Option<&str>) -> Option<String> {
        if id.is_empty() || id.starts_with('.') || id.contains(['/', '\\']) {
            return None;
        }
        let folder = self.trash_dir().join(id);
        let mut files: Vec<String> = fs::read_dir(&folder)
            .ok()?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                (!name.starts_with('.') && fs::metadata(entry.path()).is_ok_and(|m| m.is_file()))
                    .then_some(name)
            })
            .collect();
        if let Some(known) = known.filter(|known| files.iter().any(|f| f == known)) {
            return Some(known.to_string());
        }
        files.sort();
        files.into_iter().next()
    }
}

fn info(id: &str, item: &TrashEntry) -> TrashedInfo {
    TrashedInfo {
        id: id.to_string(),
        file: item.file.clone(),
        deleted_ms: item.deleted_at,
        auto_title: item.auto_title,
        language: item.language.clone(),
        pinned: item.pinned,
        kind: kind_for(&item.file),
    }
}

/// The folders directly in the trash, by name; none when there is no trash yet.
fn trash_folders(dir: &Path) -> io::Result<Vec<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !name.starts_with('.') && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            names.push(name);
        }
    }
    Ok(names)
}

fn remove_folder(folder: &Path) -> io::Result<()> {
    match fs::remove_dir_all(folder) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

fn system_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const NOW: u64 = 1_793_464_405_000;

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let root = tempfile::tempdir().unwrap();
        let ws = Workspace::create(root.path(), "w").unwrap();
        (root, ws)
    }

    fn names(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn trash_json(ws: &Workspace) -> PathBuf {
        ws.root().join(TRASH_DIR).join(TRASH_FILE)
    }

    /// The folders in `.trash`, by name.
    fn trash_folders_of(ws: &Workspace) -> Vec<String> {
        let mut names = trash_folders(&ws.root().join(TRASH_DIR)).unwrap();
        names.sort();
        names
    }

    #[test]
    fn trash_moves_the_file_and_leaves_the_memo_list() {
        let (_root, mut ws) = workspace();
        let memo = ws.import_memo("회의록.md", b"# agenda").unwrap();
        ws.set_language(&memo.id, "markdown", "md", false).unwrap();
        ws.set_pinned(&memo.id, true).unwrap();
        let trashed = ws.trash_memo(&memo.id, 1000).unwrap();
        assert!(!ws.root().join("회의록.md").exists());
        // Nothing of it is tote's own in the folder any more, as after `delete_memo`.
        assert_eq!(ws.last_written("회의록.md"), None);
        assert!(!ws.inodes().contains_key("회의록.md"));
        assert_eq!(
            fs::read(ws.root().join(TRASH_DIR).join(&memo.id).join("회의록.md")).unwrap(),
            b"# agenda"
        );
        assert!(ws.list_memos().unwrap().is_empty());
        let expected = TrashedInfo {
            id: memo.id.clone(),
            file: "회의록.md".into(),
            deleted_ms: 1000,
            auto_title: false,
            language: Some("markdown".into()),
            pinned: true,
            kind: FileKind::Text,
        };
        assert_eq!(trashed, expected);
        assert_eq!(ws.list_trash(1000).unwrap(), vec![expected]);
        let index = fs::read_to_string(ws.root().join(".tote/index.json")).unwrap();
        assert!(!index.contains(&memo.id), "{index}");
        assert!(matches!(
            ws.memo_info(&memo.id),
            Err(WorkspaceError::UnknownMemo(_))
        ));
        // Gone from the workspace search too, which searches the indexed memos.
        let reopened = Workspace::open(ws.root()).unwrap();
        assert!(reopened.memo_info(&memo.id).is_err());
        assert_eq!(
            serde_json::to_value(&ws.list_trash(1000).unwrap()[0]).unwrap(),
            serde_json::json!({
                "id": memo.id, "file": "회의록.md", "deletedMs": 1000, "autoTitle": false,
                "language": "markdown", "pinned": true, "kind": "text"
            })
        );
    }

    #[test]
    fn the_same_name_trashed_twice_keeps_both() {
        let (_root, mut ws) = workspace();
        let first = ws.import_memo("a.md", b"first").unwrap();
        ws.trash_memo(&first.id, 1000).unwrap();
        let second = ws.import_memo("a.md", b"second").unwrap();
        assert_eq!(second.file, "a.md");
        ws.trash_memo(&second.id, 2000).unwrap();
        let list = ws.list_trash(2000).unwrap();
        assert_eq!(
            list.iter()
                .map(|t| (t.id.as_str(), t.file.as_str(), t.deleted_ms))
                .collect::<Vec<_>>(),
            vec![
                (second.id.as_str(), "a.md", 2000),
                (first.id.as_str(), "a.md", 1000)
            ],
            "most recently trashed first"
        );
        assert_eq!(ws.read_trashed(&first.id).unwrap(), b"first");
        assert_eq!(ws.read_trashed(&second.id).unwrap(), b"second");
        assert!(matches!(
            ws.read_trashed("nope"),
            Err(WorkspaceError::UnknownMemo(_))
        ));
        assert!(matches!(
            ws.read_trashed(".."),
            Err(WorkspaceError::UnknownMemo(_))
        ));
    }

    /// Over the editor's limit, as a memo tab's size check turns one away: refused before it is
    /// read, as `too-large` to the page.
    #[test]
    fn a_trashed_memo_over_the_editor_limit_is_refused_unread() {
        use crate::app::commands::CommandError;
        use crate::persist::external::MAX_EDITOR_BYTES;
        let (_root, mut ws) = workspace();
        let memo = ws.import_memo("큰.txt", b"x").unwrap();
        ws.trash_memo(&memo.id, NOW).unwrap();
        let file = ws.root().join(TRASH_DIR).join(&memo.id).join("큰.txt");
        // Text in its first bytes, so only the size can turn it away; the rest is a sparse tail.
        fs::write(&file, vec![b'a'; crate::persist::BINARY_PROBE_BYTES]).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_len(MAX_EDITOR_BYTES + 1)
            .unwrap();
        let err = ws
            .read_trashed(&memo.id)
            .map(|bytes| bytes.len())
            .unwrap_err();
        assert_eq!(CommandError::from(err).code, "too-large");
        // At the limit it is read.
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_len(MAX_EDITOR_BYTES)
            .unwrap();
        assert_eq!(
            ws.read_trashed(&memo.id).unwrap().len() as u64,
            MAX_EDITOR_BYTES
        );
    }

    #[test]
    fn restore_brings_back_the_id_name_pin_and_language() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"# x").unwrap();
        ws.retitle_memo(&memo.id, "제목").unwrap();
        ws.set_language(&memo.id, "markdown", "md", false).unwrap();
        ws.set_pinned(&memo.id, true).unwrap();
        let before = ws.memo_info(&memo.id).unwrap();
        ws.trash_memo(&memo.id, 1000).unwrap();
        let restored = ws.restore_memo(&memo.id).unwrap();
        assert_eq!(
            (
                &restored.id,
                &restored.file,
                restored.pinned,
                &restored.language,
                restored.auto_title
            ),
            (
                &before.id,
                &before.file,
                before.pinned,
                &before.language,
                before.auto_title
            )
        );
        assert!(restored.auto_title && restored.pinned);
        assert_eq!(ws.read_memo(&memo.id).unwrap(), b"# x");
        assert!(!ws.root().join(TRASH_DIR).join(&memo.id).exists());
        let trash = fs::read_to_string(trash_json(&ws)).unwrap();
        assert!(!trash.contains(&memo.id), "{trash}");
        assert!(ws.list_trash(2000).unwrap().is_empty());
        let reopened = Workspace::open(ws.root()).unwrap();
        assert_eq!(reopened.memo_info(&memo.id).unwrap().file, "제목.md");
        assert!(matches!(
            ws.restore_memo(&memo.id),
            Err(WorkspaceError::UnknownMemo(_))
        ));
    }

    #[test]
    fn restore_takes_a_free_name_when_the_old_one_is_taken() {
        let (_root, mut ws) = workspace();
        let old = ws.import_memo("a.md", b"old").unwrap();
        ws.trash_memo(&old.id, 1000).unwrap();
        let new = ws.import_memo("a.md", b"new").unwrap();
        let restored = ws.restore_memo(&old.id).unwrap();
        assert_eq!(restored.file, "a 2.md");
        assert_eq!(restored.id, old.id);
        assert_eq!(ws.read_memo(&old.id).unwrap(), b"old");
        assert_eq!(fs::read(ws.root().join("a.md")).unwrap(), b"new");
        assert_eq!(ws.memo_info(&new.id).unwrap().file, "a.md");
    }

    #[test]
    fn restore_keeps_auto_title() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", "# 회의".as_bytes()).unwrap();
        ws.retitle_memo(&memo.id, "회의").unwrap();
        ws.trash_memo(&memo.id, 1000).unwrap();
        ws.import_memo("회의.md", b"other").unwrap();
        let restored = ws.restore_memo(&memo.id).unwrap();
        assert_eq!(restored.file, "회의 2.md");
        assert!(restored.auto_title);
    }

    #[test]
    fn purge_and_empty_remove_for_good() {
        let (_root, mut ws) = workspace();
        let a = ws.import_memo("a.md", b"a").unwrap();
        let b = ws.import_memo("b.md", b"b").unwrap();
        let c = ws.import_memo("c.md", b"c").unwrap();
        for memo in [&a, &b, &c] {
            ws.trash_memo(&memo.id, 1000).unwrap();
        }
        ws.purge_trashed(&a.id).unwrap();
        assert!(!ws.root().join(TRASH_DIR).join(&a.id).exists());
        assert!(ws.list_trash(1000).unwrap().iter().all(|t| t.id != a.id));
        assert!(matches!(
            ws.purge_trashed(&a.id),
            Err(WorkspaceError::UnknownMemo(_))
        ));
        assert_eq!(ws.empty_trash().unwrap(), 2);
        assert!(trash_folders_of(&ws).is_empty());
        assert!(ws.list_trash(1000).unwrap().is_empty());
        assert_eq!(ws.empty_trash().unwrap(), 0);
        // Not by way of the system trash: nothing of them is anywhere in the workspace.
        assert!(ws.list_memos().unwrap().is_empty());
    }

    #[test]
    fn expire_deletes_only_what_is_past_its_days() {
        let (_root, mut ws) = workspace();
        let old = ws.import_memo("old.md", b"").unwrap();
        let recent = ws.import_memo("recent.md", b"").unwrap();
        let just_over = ws.import_memo("just over.md", b"").unwrap();
        let just_under = ws.import_memo("just under.md", b"").unwrap();
        ws.trash_memo(&old.id, NOW - 61 * DAY_MS).unwrap();
        ws.trash_memo(&recent.id, NOW - 59 * DAY_MS).unwrap();
        ws.trash_memo(&just_over.id, NOW - 60 * DAY_MS - 1).unwrap();
        ws.trash_memo(&just_under.id, NOW - 60 * DAY_MS + 1)
            .unwrap();
        let sorted = |mut ids: Vec<String>| {
            ids.sort();
            ids
        };
        assert_eq!(
            sorted(ws.expire_trash(NOW, Some(60)).unwrap()),
            sorted(vec![old.id.clone(), just_over.id.clone()])
        );
        assert!(!ws.root().join(TRASH_DIR).join(&old.id).exists());
        let left: Vec<String> = ws
            .list_trash(NOW)
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(sorted(left), sorted(vec![recent.id, just_under.id]));
    }

    #[test]
    fn expire_keeps_items_from_the_future_and_rebuilt_ones() {
        let (_root, mut ws) = workspace();
        let future = ws.import_memo("future.md", b"").unwrap();
        // The clock went back ten days since: still trashed less than a day ago.
        ws.trash_memo(&future.id, NOW + 10 * DAY_MS).unwrap();
        assert!(ws.expire_trash(NOW, Some(1)).unwrap().is_empty());
        assert_eq!(ws.list_trash(NOW).unwrap().len(), 1);

        // trash.json missing: rebuilt from the folders, trashed as of now.
        let gone = ws.import_memo("gone.md", b"").unwrap();
        ws.trash_memo(&gone.id, NOW - 400 * DAY_MS).unwrap();
        fs::remove_file(trash_json(&ws)).unwrap();
        let list = ws.list_trash(NOW).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|t| t.deleted_ms == NOW), "{list:?}");
        assert!(ws.expire_trash(NOW, Some(1)).unwrap().is_empty());
        assert_eq!(ws.list_trash(NOW).unwrap().len(), 2);

        // trash.json unreadable: the same, and the broken file is set aside.
        fs::write(trash_json(&ws), "{ broken").unwrap();
        assert!(ws.expire_trash(NOW + 1, Some(1)).unwrap().is_empty());
        let list = ws.list_trash(NOW + 1).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|t| t.deleted_ms == NOW + 1), "{list:?}");
        let aside = fs::read_dir(ws.root().join(TRASH_DIR))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("trash.json.corrupt-")
            })
            .count();
        assert_eq!(aside, 1);
        // A day after they were found, they go.
        assert_eq!(
            ws.expire_trash(NOW + 1 + DAY_MS + 1, Some(1))
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn an_orphan_folder_joins_the_trash() {
        let (_root, mut ws) = workspace();
        let folder = ws.root().join(TRASH_DIR).join("orphan-id");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("x.md"), "x").unwrap();
        fs::write(folder.join(".DS_Store"), "finder").unwrap();
        assert_eq!(
            ws.list_trash(NOW).unwrap(),
            vec![TrashedInfo {
                id: "orphan-id".into(),
                file: "x.md".into(),
                deleted_ms: NOW,
                auto_title: false,
                language: None,
                pinned: false,
                kind: FileKind::Text,
            }]
        );
        // Written down, so the next read keeps the time it was found.
        assert_eq!(ws.list_trash(NOW + 5).unwrap()[0].deleted_ms, NOW);
        // An item whose folder went is dropped.
        fs::remove_dir_all(&folder).unwrap();
        assert!(ws.list_trash(NOW).unwrap().is_empty());
    }

    #[test]
    fn trashing_and_restoring_leave_no_fs_change_to_report() {
        let (_root, mut ws) = workspace();
        let memo = ws.import_memo("회의록.md", b"x").unwrap();
        ws.write_memo(&memo.id, b"saved").unwrap();
        ws.trash_memo(&memo.id, NOW).unwrap();
        assert_eq!(
            ws.apply_fs_events(&names(&["회의록.md"]), &[]).unwrap(),
            vec![]
        );
        // Taken while it was away: the memo comes back as `회의록 2.md`.
        let other = ws.import_memo("회의록.md", b"other").unwrap();
        let restored = ws.restore_memo(&memo.id).unwrap();
        assert_eq!(restored.file, "회의록 2.md");
        assert_eq!(
            ws.apply_fs_events(&names(&[&restored.file]), &[]).unwrap(),
            vec![]
        );
        // Also a memo tote had not written since the workspace opened.
        let mut ws = Workspace::open(ws.root()).unwrap();
        ws.trash_memo(&other.id, NOW).unwrap();
        assert_eq!(
            ws.apply_fs_events(&names(&["회의록.md"]), &[]).unwrap(),
            vec![]
        );
        let back = ws.restore_memo(&other.id).unwrap();
        assert_eq!(
            ws.apply_fs_events(&names(&[&back.file]), &[]).unwrap(),
            vec![]
        );
        assert_eq!(ws.list_memos().unwrap().len(), 2, "no duplicate entry");
    }

    #[test]
    fn a_memo_whose_file_is_gone_stays_out_of_the_trash() {
        let (_root, mut ws) = workspace();
        let memo = ws.import_memo("a.md", b"").unwrap();
        fs::remove_file(ws.root().join("a.md")).unwrap();
        assert!(ws.trash_memo(&memo.id, NOW).is_err());
        assert!(trash_folders_of(&ws).is_empty());
        assert!(ws.list_trash(NOW).unwrap().is_empty());
    }

    #[test]
    fn retention_none_never_expires() {
        let (_root, mut ws) = workspace();
        let memo = ws.import_memo("a.md", b"").unwrap();
        ws.trash_memo(&memo.id, 0).unwrap();
        assert!(ws.expire_trash(NOW, None).unwrap().is_empty());
        assert_eq!(ws.list_trash(NOW).unwrap().len(), 1);
    }
}
