//! What the memo list shows about each memo.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::index::{self, MemoEntry};
use super::names::split_name;
use super::preview::{is_markdown, read_preview};
use super::{CachedPreview, Workspace, WorkspaceError};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    #[default]
    Text,
    Image,
    Video,
    Audio,
    Document,
}

/// Guessed from the extension: listing 10,000 memos must not open every file. Which viewer
/// actually opens a file is decided by the extension registry of a later plan.
pub fn kind_for(file_name: &str) -> FileKind {
    let ext = split_name(file_name).1.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "bmp" | "tif" | "tiff" | "avif" => {
            FileKind::Image
        }
        "mp4" | "mov" | "m4v" | "webm" => FileKind::Video,
        "mp3" | "m4a" | "wav" | "aac" | "flac" | "ogg" | "aiff" => FileKind::Audio,
        "pdf" => FileKind::Document,
        _ => FileKind::Text,
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoInfo {
    pub id: String,
    pub file: String,
    pub auto_title: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub modified_ms: u64,
    pub size: u64,
    pub kind: FileKind,
    /// Left out when false, as in the index.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    /// When it was last on show on this device; left out when never (`workspace::viewed`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewed_ms: Option<u64>,
    /// The memo list's line under the name (`workspace::preview`); text memos only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

impl Workspace {
    /// Every memo, most recently modified first. Picks up files other apps added, removed or
    /// renamed.
    pub fn list_memos(&mut self) -> Result<Vec<MemoInfo>, WorkspaceError> {
        let files = index::memo_files(&self.root)?;
        let followed = self.follow_renames(&files);
        let reconciled = self.index.reconcile(&files);
        if reconciled {
            // Before saving: a file found here must be followable through a rename even if the
            // save fails.
            self.resync_files();
        }
        if followed || reconciled {
            self.index.save()?;
        }
        // Memos gone from the index keep no preview.
        self.previews
            .borrow_mut()
            .retain(|id, _| self.index.get(id).is_some());
        let mut list: Vec<MemoInfo> = self
            .index
            .iter()
            .filter_map(|(id, entry)| self.info_for(id, entry).ok())
            .collect();
        list.sort_by(|a, b| {
            b.modified_ms
                .cmp(&a.modified_ms)
                .then_with(|| a.file.cmp(&b.file))
        });
        Ok(list)
    }

    /// A memo whose file is gone and a file the index does not know, with the inode that file
    /// had, are one memo another app renamed. It is followed here as the watcher follows it
    /// (`apply_fs_events`), because the memo list can ask before the watcher's batch arrives:
    /// dropping the memo and indexing the file as new would lose its ID, pin and language.
    /// Returns whether any was followed.
    fn follow_renames(&mut self, files: &BTreeSet<String>) -> bool {
        let gone: Vec<(String, String, (u64, u64))> = self
            .index
            .iter()
            .filter(|(_, entry)| !files.contains(&entry.file))
            .filter_map(|(id, entry)| {
                let inode = *self.inodes.get(&entry.file)?;
                Some((id.clone(), entry.file.clone(), inode))
            })
            .collect();
        // Nearly always: the new files are looked at only when a memo's file is gone.
        if gone.is_empty() {
            return false;
        }
        let indexed: BTreeSet<&String> = self.index.iter().map(|(_, entry)| &entry.file).collect();
        let mut new: BTreeMap<(u64, u64), &String> = BTreeMap::new();
        for file in files.iter().filter(|file| !indexed.contains(file)) {
            if let Some(inode) = index::file_id(&self.root.join(file)) {
                new.entry(inode).or_insert(file);
            }
        }
        let renamed: Vec<(String, String, String)> = gone
            .into_iter()
            .filter_map(|(id, from, inode)| Some((id, from, new.remove(&inode)?.clone())))
            .collect();
        for (id, from, to) in &renamed {
            self.follow_rename(id, from, to);
        }
        if !renamed.is_empty() {
            self.mark_changed();
        }
        !renamed.is_empty()
    }

    pub fn memo_info(&self, id: &str) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?;
        Ok(self.info_for(id, entry)?)
    }

    pub(super) fn entry(&self, id: &str) -> Result<&MemoEntry, WorkspaceError> {
        self.index
            .get(id)
            .ok_or_else(|| WorkspaceError::UnknownMemo(id.to_string()))
    }

    fn info_for(&self, id: &str, entry: &MemoEntry) -> io::Result<MemoInfo> {
        let meta = fs::metadata(self.root.join(&entry.file))?;
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        let kind = kind_for(&entry.file);
        let preview = (kind == FileKind::Text)
            .then(|| self.preview(id, entry, modified_ms, meta.len()))
            .flatten();
        Ok(MemoInfo {
            id: id.to_string(),
            file: entry.file.clone(),
            auto_title: entry.auto_title,
            language: entry.language.clone(),
            modified_ms,
            size: meta.len(),
            kind,
            pinned: entry.pinned,
            viewed_ms: self.viewed_ms(id),
            preview,
        })
    }

    /// The memo's preview, read only when its file or its being Markdown changed since it was last
    /// read. A file that cannot be read has none.
    fn preview(&self, id: &str, entry: &MemoEntry, modified_ms: u64, size: u64) -> Option<String> {
        let file = entry.file.as_str();
        let markdown = is_markdown(file, entry.language.as_deref());
        let mut cache = self.previews.borrow_mut();
        if let Some(cached) = cache.get(id) {
            if cached.file == file
                && cached.markdown == markdown
                && cached.modified_ms == modified_ms
                && cached.size == size
            {
                return cached.preview.clone();
            }
        }
        let preview = read_preview(&self.root.join(file), markdown).ok().flatten();
        cache.insert(
            id.to_string(),
            CachedPreview {
                file: file.to_string(),
                markdown,
                modified_ms,
                size,
                preview: preview.clone(),
            },
        );
        preview
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    use crate::workspace::Workspace;

    fn set_mtime(path: &std::path::Path, secs: u64) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    #[test]
    fn kinds_come_from_the_extension() {
        assert_eq!(kind_for("a.md"), FileKind::Text);
        assert_eq!(kind_for("a.svg"), FileKind::Text);
        assert_eq!(kind_for("사진.JPG"), FileKind::Image);
        assert_eq!(kind_for("clip.mov"), FileKind::Video);
        assert_eq!(kind_for("voice.m4a"), FileKind::Audio);
        assert_eq!(kind_for("doc.pdf"), FileKind::Document);
        assert_eq!(kind_for("Makefile"), FileKind::Text);
    }

    #[test]
    fn memos_are_listed_newest_first_and_follow_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::create(root.path(), "w").unwrap();
        let dir = ws.root().to_path_buf();
        fs::write(dir.join("오래됨.md"), "a").unwrap();
        fs::write(dir.join("새것.md"), "bb").unwrap();
        set_mtime(&dir.join("오래됨.md"), 1_000);
        set_mtime(&dir.join("새것.md"), 2_000);
        let list = ws.list_memos().unwrap();
        let files: Vec<&str> = list.iter().map(|m| m.file.as_str()).collect();
        assert_eq!(files, vec!["새것.md", "오래됨.md"]);
        assert_eq!(list[0].size, 2);
        assert_eq!(list[0].modified_ms, 2_000_000);
        assert!(!list[0].auto_title);

        fs::remove_file(dir.join("오래됨.md")).unwrap();
        let files: Vec<String> = ws
            .list_memos()
            .unwrap()
            .into_iter()
            .map(|m| m.file)
            .collect();
        assert_eq!(files, vec!["새것.md"]);
    }

    /// The memo list can ask before the watcher's batch arrives; both must tell the same story.
    #[cfg(unix)]
    #[test]
    fn a_rename_by_another_app_found_by_listing_keeps_the_memo() {
        use crate::workspace::Change;
        use std::collections::BTreeSet;
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::create(root.path(), "w").unwrap();
        let dir = ws.root().to_path_buf();
        let memo = ws.create_memo("md", b"# x").unwrap();
        ws.set_language(&memo.id, "markdown", "md", false).unwrap();
        ws.set_pinned(&memo.id, true).unwrap();
        ws.write_memo(&memo.id, b"# saved").unwrap();
        // Never written since the workspace opened: known by the inode opening recorded.
        fs::write(dir.join("옛.py"), "old").unwrap();
        let mut ws = Workspace::open(&dir).unwrap();
        ws.write_memo(&memo.id, b"# saved").unwrap();
        let old = ws
            .list_memos()
            .unwrap()
            .into_iter()
            .find(|m| m.file == "옛.py")
            .unwrap();
        ws.set_language(&old.id, "python", "py", false).unwrap();
        ws.take_changed();

        fs::rename(dir.join("untitled.md"), dir.join("회의.md")).unwrap();
        fs::rename(dir.join("옛.py"), dir.join("새.txt")).unwrap();
        let list = ws.list_memos().unwrap();
        assert_eq!(list.len(), 2, "{list:?}");
        let renamed = list.iter().find(|m| m.id == memo.id).expect("the same ID");
        assert_eq!(renamed.file, "회의.md");
        assert!(renamed.pinned);
        assert_eq!(renamed.language.as_deref(), Some("markdown"));
        assert!(
            !renamed.auto_title,
            "a name given elsewhere is the person's"
        );
        // Another extension: the language chosen for the old one goes, as the watcher has it.
        let other = list.iter().find(|m| m.id == old.id).expect("the same ID");
        assert_eq!((other.file.as_str(), &other.language), ("새.txt", &None));
        assert!(ws.take_changed(), "the next backup takes the new names");
        assert_eq!(
            ws.inodes().keys().collect::<Vec<_>>(),
            vec!["새.txt", "회의.md"]
        );
        let reopened = Workspace::open(&dir).unwrap();
        assert_eq!(reopened.memo_info(&memo.id).unwrap().file, "회의.md");

        // The watcher's batch comes after: nothing more to say of the memo tote wrote, and the
        // write that follows goes to the new name.
        let seen: BTreeSet<String> = ["untitled.md", "회의.md"]
            .iter()
            .map(|name| name.to_string())
            .collect();
        assert_eq!(
            ws.apply_fs_events(&seen, &[]).unwrap(),
            Vec::<Change>::new()
        );
        ws.write_memo(&memo.id, b"# on").unwrap();
        assert_eq!(fs::read(dir.join("회의.md")).unwrap(), b"# on");
        assert!(!dir.join("untitled.md").exists());

        // A copy made and the original removed is not a rename: the inode is another.
        fs::copy(dir.join("회의.md"), dir.join("사본.md")).unwrap();
        fs::remove_file(dir.join("회의.md")).unwrap();
        let list = ws.list_memos().unwrap();
        let copy = list.iter().find(|m| m.file == "사본.md").unwrap();
        assert_ne!(copy.id, memo.id);
        assert!(!copy.pinned);
    }

    #[test]
    fn text_memos_have_a_preview_and_others_none() {
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::create(root.path(), "w").unwrap();
        let text = ws.import_memo("a.md", "제목\n본문".as_bytes()).unwrap();
        let image = ws.import_memo("b.png", b"t\nnot really").unwrap();
        assert_eq!(text.preview.as_deref(), Some("본문"));
        assert_eq!(image.preview, None);
        let json = serde_json::to_string(&image).unwrap();
        assert!(!json.contains("preview"), "{json}");
    }

    #[test]
    fn only_a_markdown_memo_loses_its_markdown_marks() {
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::create(root.path(), "w").unwrap();
        let body = b"t\n- [ ] **\xea\xb0\x80** 2**10";
        let md = ws.import_memo("a.md", body).unwrap();
        let py = ws.import_memo("b.py", body).unwrap();
        assert_eq!(md.preview.as_deref(), Some("가 2**10"));
        assert_eq!(py.preview.as_deref(), Some("[ ] **가** 2**10"));
        // Read again as Markdown once that is its chosen language, the file untouched.
        let txt = ws.import_memo("c.txt", body).unwrap();
        assert_eq!(txt.preview.as_deref(), Some("[ ] **가** 2**10"));
        let txt = ws.set_language(&txt.id, "markdown", "txt", false).unwrap();
        assert_eq!(txt.file, "c.txt");
        assert_eq!(txt.preview.as_deref(), Some("가 2**10"));
    }

    #[test]
    fn previews_are_cached_until_the_file_changes() {
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::create(root.path(), "w").unwrap();
        let memo = ws.import_memo("a.md", b"t\nold").unwrap();
        let path = ws.root().join("a.md");
        set_mtime(&path, 1_000);
        assert_eq!(
            ws.memo_info(&memo.id).unwrap().preview.as_deref(),
            Some("old")
        );
        // Same size, same time: the file is not read again.
        fs::write(&path, b"t\nnew").unwrap();
        set_mtime(&path, 1_000);
        assert_eq!(ws.list_memos().unwrap()[0].preview.as_deref(), Some("old"));
        set_mtime(&path, 2_000);
        assert_eq!(ws.list_memos().unwrap()[0].preview.as_deref(), Some("new"));
        // Another size at the same time is another file too.
        fs::write(&path, b"t\nlonger").unwrap();
        set_mtime(&path, 2_000);
        assert_eq!(
            ws.list_memos().unwrap()[0].preview.as_deref(),
            Some("longer")
        );
    }

    #[test]
    fn memo_info_reports_unknown_ids() {
        let root = tempfile::tempdir().unwrap();
        let ws = Workspace::create(root.path(), "w").unwrap();
        assert!(matches!(
            ws.memo_info("nope"),
            Err(WorkspaceError::UnknownMemo(_))
        ));
    }

    #[test]
    fn memo_info_serialises_for_the_frontend() {
        let info = MemoInfo {
            id: "i".into(),
            file: "a.md".into(),
            auto_title: true,
            language: None,
            modified_ms: 5,
            size: 1,
            kind: FileKind::Text,
            pinned: false,
            viewed_ms: None,
            preview: None,
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"id":"i","file":"a.md","autoTitle":true,"modifiedMs":5,"size":1,"kind":"text"}"#
        );
    }
}
