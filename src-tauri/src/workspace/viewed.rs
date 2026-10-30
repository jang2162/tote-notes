//! When each memo was last on show, for the memo list's viewed order (spec 2026-10-30 「정렬」).
//! Kept on this device only, in the app data folder by workspace ID: in `index.json` every look
//! at a memo would change the index, make a backup snapshot and, once sync comes, fight the other
//! devices. Written like the session file: once the views stop for a second, and at once when a
//! window closes or the app quits.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::persist::{read_json, write_json};

/// How long after the last view the file is written.
pub const VIEWED_DELAY_MS: u64 = 1000;

#[derive(Default, Deserialize, Serialize)]
struct ViewedFile {
    #[serde(default)]
    viewed: BTreeMap<String, u64>,
}

#[derive(Serialize)]
struct ViewedFileRef<'a> {
    version: u32,
    viewed: &'a BTreeMap<String, u64>,
}

pub struct ViewedTimes {
    path: PathBuf,
    /// Memo ID → ms since the epoch.
    times: BTreeMap<String, u64>,
    /// Counts the views; a write waits for the count to stop moving.
    generation: u64,
    dirty: bool,
}

impl ViewedTimes {
    /// `<data dir>/viewed/<workspace id>.json`.
    pub fn file(data_dir: &Path, workspace_id: &str) -> PathBuf {
        data_dir.join("viewed").join(format!("{workspace_id}.json"))
    }

    /// The times in `path`; none when there is no file or it cannot be read (it is set aside).
    pub fn load(path: PathBuf) -> ViewedTimes {
        let times = read_json::<ViewedFile>(&path)
            .unwrap_or_else(|err| {
                eprintln!("tote: cannot read {}: {err}", path.display());
                None
            })
            .unwrap_or_default()
            .viewed;
        ViewedTimes {
            path,
            times,
            generation: 0,
            dirty: false,
        }
    }

    pub fn get(&self, id: &str) -> Option<u64> {
        self.times.get(id).copied()
    }

    /// The memo was on show at `ms`. Returns the view's generation, for `save_if`.
    pub fn record(&mut self, id: &str, ms: u64) -> u64 {
        self.times.insert(id.to_string(), ms);
        self.dirty = true;
        self.generation += 1;
        self.generation
    }

    /// Writes the times when no view came after the one of `generation`; whether it wrote.
    pub fn save_if(&mut self, generation: u64) -> io::Result<bool> {
        if generation != self.generation || !self.dirty {
            return Ok(false);
        }
        self.save_now()?;
        Ok(true)
    }

    /// Writes the times if a view has not been written yet.
    pub fn save_now(&mut self) -> io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        write_json(
            &self.path,
            &ViewedFileRef {
                version: 1,
                viewed: &self.times,
            },
        )?;
        self.dirty = false;
        Ok(())
    }

    /// Forgets the memos `keep` says are gone, so the file does not grow with deleted ones.
    pub fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        let before = self.times.len();
        self.times.retain(|id, _| keep(id));
        if self.times.len() != before {
            self.dirty = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::workspace::Workspace;

    fn times(dir: &Path) -> ViewedTimes {
        ViewedTimes::load(ViewedTimes::file(dir, "w"))
    }

    #[test]
    fn viewed_times_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut viewed = times(dir.path());
        assert_eq!(viewed.get("a"), None);
        viewed.record("a", 5);
        viewed.save_now().unwrap();
        assert_eq!(times(dir.path()).get("a"), Some(5));
    }

    #[test]
    fn only_the_latest_generation_saves() {
        let dir = tempfile::tempdir().unwrap();
        let file = ViewedTimes::file(dir.path(), "w");
        let mut viewed = times(dir.path());
        let first = viewed.record("a", 1);
        let second = viewed.record("b", 2);
        assert!(!viewed.save_if(first).unwrap());
        assert!(!file.exists());
        assert!(viewed.save_if(second).unwrap());
        assert!(file.exists());
        // Written: the same generation has nothing more to write.
        assert!(!viewed.save_if(second).unwrap());
    }

    #[test]
    fn save_now_writes_only_when_dirty() {
        let dir = tempfile::tempdir().unwrap();
        let file = ViewedTimes::file(dir.path(), "w");
        let mut viewed = times(dir.path());
        viewed.save_now().unwrap();
        assert!(!file.exists());
        viewed.record("a", 1);
        viewed.save_now().unwrap();
        fs::remove_file(&file).unwrap();
        viewed.save_now().unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn an_unreadable_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = ViewedTimes::file(dir.path(), "w");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "{not json").unwrap();
        assert_eq!(times(dir.path()).get("a"), None);
    }

    #[test]
    fn retain_drops_gone_memos() {
        let dir = tempfile::tempdir().unwrap();
        let mut viewed = times(dir.path());
        viewed.record("a", 1);
        viewed.record("b", 2);
        viewed.save_now().unwrap();
        viewed.retain(|id| id == "a");
        viewed.save_now().unwrap();
        let read = times(dir.path());
        assert_eq!((read.get("a"), read.get("b")), (Some(1), None));
    }

    #[test]
    fn viewed_times_are_kept_by_id() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut ws = Workspace::create(root.path(), "w").unwrap();
        ws.attach_viewed(ViewedTimes::load(ViewedTimes::file(data.path(), ws.id())));
        let memo = ws.import_memo("가.md", b"x").unwrap();
        assert_eq!(memo.viewed_ms, None);
        ws.memo_viewed(&memo.id, 7).unwrap();
        ws.rename_memo(&memo.id, "나.md").unwrap();
        assert_eq!(ws.memo_info(&memo.id).unwrap().viewed_ms, Some(7));
        assert_eq!(ws.list_memos().unwrap()[0].viewed_ms, Some(7));
    }
}
