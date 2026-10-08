//! What the memo list shows about each memo.

use std::fs;
use std::io;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::index::MemoEntry;
use super::names::split_name;
use super::{Workspace, WorkspaceError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
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

#[derive(Clone, Debug, PartialEq, Serialize)]
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
}

impl Workspace {
    /// Every memo, most recently modified first. Picks up files other apps added or removed.
    pub fn list_memos(&mut self) -> Result<Vec<MemoInfo>, WorkspaceError> {
        if self.index.reconcile(&self.root)? {
            self.index.save()?;
        }
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
        Ok(MemoInfo {
            id: id.to_string(),
            file: entry.file.clone(),
            auto_title: entry.auto_title,
            language: entry.language.clone(),
            modified_ms,
            size: meta.len(),
            kind: kind_for(&entry.file),
        })
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
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"id":"i","file":"a.md","autoTitle":true,"modifiedMs":5,"size":1,"kind":"text"}"#
        );
    }
}
