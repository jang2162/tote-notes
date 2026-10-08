//! Unsaved edits of external files, kept on this device only (`buffers/` in the app data folder)
//! until the person saves or discards them (spec 「저장」). One file per path — a JSON header line,
//! then the edited bytes — so one atomic write keeps header and contents together.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::persist::{atomic_write, content_hash, is_temp_file, set_aside};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftHeader {
    pub version: u32,
    pub path: PathBuf,
    /// Hash of the file on disk when editing started; `None` when it did not exist yet.
    pub base_hash: Option<String>,
}

pub struct DraftStore {
    dir: PathBuf,
}

impl DraftStore {
    /// Clears temp files an interrupted write left in `dir`; the store is made once at startup.
    pub fn new(dir: PathBuf) -> DraftStore {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_str().is_some_and(is_temp_file) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        DraftStore { dir }
    }

    pub fn put(&self, path: &Path, base_hash: Option<&str>, contents: &[u8]) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let header = DraftHeader {
            version: 1,
            path: path.to_path_buf(),
            base_hash: base_hash.map(str::to_string),
        };
        let mut bytes = serde_json::to_vec(&header)?;
        bytes.push(b'\n');
        bytes.extend_from_slice(contents);
        atomic_write(&self.file_for(path), &bytes)
    }

    pub fn get(&self, path: &Path) -> io::Result<Option<(DraftHeader, Vec<u8>)>> {
        let file = self.file_for(path);
        let bytes = match fs::read(&file) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        let parsed = bytes.iter().position(|&b| b == b'\n').and_then(|end| {
            let header: DraftHeader = serde_json::from_slice(&bytes[..end]).ok()?;
            Some((header, bytes[end + 1..].to_vec()))
        });
        match parsed {
            // The path check guards against two paths whose hashes share the file-name prefix.
            Some((header, contents)) if header.path == path => Ok(Some((header, contents))),
            Some(_) => Ok(None),
            None => {
                set_aside(&file)?;
                Ok(None)
            }
        }
    }

    pub fn remove(&self, path: &Path) -> io::Result<()> {
        match fs::remove_file(self.file_for(path)) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        }
    }

    fn file_for(&self, path: &Path) -> PathBuf {
        let hash = content_hash(path.as_os_str().as_encoded_bytes());
        self.dir.join(format!("{}.draft", &hash[..32]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn drafts_round_trip_and_go_away() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("buffers")).unwrap();
        let leftover = dir.path().join("buffers/.tote-tmp-deadbeef");
        fs::write(&leftover, "half").unwrap();
        let store = DraftStore::new(dir.path().join("buffers"));
        assert!(!leftover.exists());
        let path = Path::new("/Users/me/스크립트/배포.sh");
        assert_eq!(store.get(path).unwrap(), None);
        store
            .put(path, Some("abc"), "echo 수정\n".as_bytes())
            .unwrap();
        let (header, contents) = store.get(path).unwrap().unwrap();
        assert_eq!(header.path, path);
        assert_eq!(header.base_hash.as_deref(), Some("abc"));
        assert_eq!(contents, "echo 수정\n".as_bytes());
        store.remove(path).unwrap();
        store.remove(path).unwrap();
        assert_eq!(store.get(path).unwrap(), None);
    }

    #[test]
    fn a_draft_for_a_file_that_did_not_exist_has_no_base() {
        let dir = tempfile::tempdir().unwrap();
        let store = DraftStore::new(dir.path().to_path_buf());
        store.put(Path::new("/new.txt"), None, b"").unwrap();
        let (header, contents) = store.get(Path::new("/new.txt")).unwrap().unwrap();
        assert_eq!(header.base_hash, None);
        assert!(contents.is_empty());
    }

    #[test]
    fn an_unreadable_draft_reads_as_none_and_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let store = DraftStore::new(dir.path().to_path_buf());
        let path = Path::new("/a.txt");
        store.put(path, None, b"x").unwrap();
        let file = fs::read_dir(dir.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(&file, "no header line").unwrap();
        assert_eq!(store.get(path).unwrap(), None);
        assert!(!file.exists());
    }
}
