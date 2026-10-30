//! `.tote/index.json`: memo ID → file name. The memo files are the original, so the index can be
//! rebuilt from them whenever it is missing or unreadable (new IDs, `autoTitle: false`).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::TOTE_DIR;
use crate::persist::{read_json, write_json};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoEntry {
    pub file: String,
    pub auto_title: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Kept at the top of the memo list (spec 2026-10-30 「고정」); written only when set.
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Deserialize)]
struct IndexFile {
    memos: BTreeMap<String, MemoEntry>,
}

#[derive(Serialize)]
struct IndexFileRef<'a> {
    version: u32,
    memos: &'a BTreeMap<String, MemoEntry>,
}

pub struct MemoIndex {
    path: PathBuf,
    memos: BTreeMap<String, MemoEntry>,
}

impl MemoIndex {
    /// Loads the index of the workspace at `root` and brings it in line with the files there.
    pub fn load(root: &Path) -> io::Result<MemoIndex> {
        let path = root.join(TOTE_DIR).join("index.json");
        let memos = read_json::<IndexFile>(&path)?
            .map(|file| file.memos)
            .unwrap_or_default();
        let mut index = MemoIndex { path, memos };
        if index.reconcile(root)? || !index.path.is_file() {
            index.save()?;
        }
        Ok(index)
    }

    /// Drops entries whose file is gone and indexes new files. Returns whether anything changed.
    pub fn reconcile(&mut self, root: &Path) -> io::Result<bool> {
        let files = memo_files(root)?;
        Ok(reconcile_entries(&mut self.memos, &files, || {
            uuid::Uuid::new_v4().to_string()
        }))
    }

    pub fn save(&self) -> io::Result<()> {
        write_json(
            &self.path,
            &IndexFileRef {
                version: 1,
                memos: &self.memos,
            },
        )
    }

    pub fn get(&self, id: &str) -> Option<&MemoEntry> {
        self.memos.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut MemoEntry> {
        self.memos.get_mut(id)
    }

    pub fn insert(&mut self, id: String, entry: MemoEntry) {
        self.memos.insert(id, entry);
    }

    pub fn remove(&mut self, id: &str) -> Option<MemoEntry> {
        self.memos.remove(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &MemoEntry)> {
        self.memos.iter()
    }
}

/// The files that are memos: regular files (or links to them) directly in `root`. Dot files are
/// skipped, which also skips `.tote/` and leftover temporary files.
pub fn memo_files(root: &Path) -> io::Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !name.starts_with('.') && fs::metadata(entry.path()).is_ok_and(|m| m.is_file()) {
            names.insert(name);
        }
    }
    Ok(names)
}

/// The names directly in `root`, without looking at each entry. Unlike a lookup by name, this
/// spells a name the way the folder holds it: APFS finds `memo.md` when the file is `Memo.md`.
pub fn entry_names(root: &Path) -> io::Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(root)? {
        if let Ok(name) = entry?.file_name().into_string() {
            names.insert(name);
        }
    }
    Ok(names)
}

/// A folder entry's identity, (device, inode): it stays with the file through a rename. The
/// entry itself is looked at, so a symlink is known by the link and not by its target.
#[cfg(unix)]
pub fn file_id(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(not(unix))]
pub fn file_id(_path: &Path) -> Option<(u64, u64)> {
    None
}

/// `file_id` of every indexed file in `root`, by file name.
pub fn file_ids(root: &Path, index: &MemoIndex) -> BTreeMap<String, (u64, u64)> {
    index
        .iter()
        .filter_map(|(_, entry)| Some((entry.file.clone(), file_id(&root.join(&entry.file))?)))
        .collect()
}

/// Drops entries whose file is gone and gives every unindexed file a new ID with
/// `autoTitle: false` (tote did not name it). Two entries naming one file keep the first. A file
/// renamed while tote was not watching therefore becomes a new memo; only its tab position is
/// lost (spec 「메모 ID 와 색인」).
pub fn reconcile_entries(
    memos: &mut BTreeMap<String, MemoEntry>,
    files: &BTreeSet<String>,
    mut new_id: impl FnMut() -> String,
) -> bool {
    let before = memos.len();
    let mut seen = BTreeSet::new();
    memos.retain(|_, entry| files.contains(&entry.file) && seen.insert(entry.file.clone()));
    let mut changed = memos.len() != before;
    for file in files.difference(&seen) {
        memos.insert(
            new_id(),
            MemoEntry {
                file: file.clone(),
                auto_title: false,
                language: None,
                pinned: false,
            },
        );
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn entry(file: &str, auto_title: bool) -> MemoEntry {
        MemoEntry {
            file: file.into(),
            auto_title,
            language: None,
            pinned: false,
        }
    }

    #[test]
    fn pinned_is_written_only_when_set() {
        let plain = serde_json::to_string(&entry("a.md", true)).unwrap();
        assert!(!plain.contains("pinned"), "{plain}");
        let pinned = MemoEntry {
            pinned: true,
            ..entry("a.md", true)
        };
        let text = serde_json::to_string(&pinned).unwrap();
        assert!(text.contains(r#""pinned":true"#), "{text}");
        let old: MemoEntry = serde_json::from_str(r#"{"file":"a.md","autoTitle":true}"#).unwrap();
        assert!(!old.pinned);
        let read: MemoEntry = serde_json::from_str(&text).unwrap();
        assert!(read.pinned);
    }

    #[test]
    fn reconcile_drops_missing_files_and_indexes_new_ones() {
        let mut memos = BTreeMap::from([
            ("a".to_string(), entry("남음.md", true)),
            ("b".to_string(), entry("사라짐.md", true)),
        ]);
        let files = BTreeSet::from(["남음.md".to_string(), "새 파일.sh".to_string()]);
        let mut ids = ["n1".to_string()].into_iter();
        assert!(reconcile_entries(&mut memos, &files, || ids
            .next()
            .unwrap()));
        assert_eq!(memos.get("a"), Some(&entry("남음.md", true)));
        assert_eq!(memos.get("b"), None);
        assert_eq!(memos.get("n1"), Some(&entry("새 파일.sh", false)));
        assert!(!reconcile_entries(&mut memos, &files, || unreachable!()));
    }

    #[test]
    fn two_entries_for_one_file_keep_the_first() {
        let mut memos = BTreeMap::from([
            ("a".to_string(), entry("x.md", true)),
            ("b".to_string(), entry("x.md", false)),
        ]);
        let files = BTreeSet::from(["x.md".to_string()]);
        assert!(reconcile_entries(&mut memos, &files, || unreachable!()));
        assert_eq!(memos.keys().collect::<Vec<_>>(), vec!["a"]);
    }

    #[cfg(unix)]
    #[test]
    fn memo_files_are_plain_files_at_the_top_level() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("메모.md"), "").unwrap();
        fs::write(dir.path().join(".DS_Store"), "").unwrap();
        fs::create_dir_all(dir.path().join("하위/폴더")).unwrap();
        fs::write(dir.path().join("하위/안쪽.md"), "").unwrap();
        std::os::unix::fs::symlink(dir.path().join("메모.md"), dir.path().join("링크.md")).unwrap();
        let files = memo_files(dir.path()).unwrap();
        assert_eq!(
            files,
            BTreeSet::from(["링크.md".to_string(), "메모.md".to_string()])
        );
    }

    #[test]
    fn an_unreadable_index_is_rebuilt_from_the_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(TOTE_DIR)).unwrap();
        fs::write(dir.path().join(TOTE_DIR).join("index.json"), "{ broken").unwrap();
        fs::write(dir.path().join("살아남음.md"), "내용").unwrap();
        let index = MemoIndex::load(dir.path()).unwrap();
        let entries: Vec<&MemoEntry> = index.iter().map(|(_, e)| e).collect();
        assert_eq!(entries, vec![&entry("살아남음.md", false)]);
        let reread = MemoIndex::load(dir.path()).unwrap();
        assert_eq!(reread.iter().count(), 1);
        let aside = fs::read_dir(dir.path().join(TOTE_DIR))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("index.json.corrupt-")
            })
            .count();
        assert_eq!(aside, 1);
    }
}
