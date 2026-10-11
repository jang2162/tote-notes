//! External files: anything opened from outside the workspace. Written only on ⌘S; edits in
//! between live in drafts. The hash of the file when editing started travels with the draft, so
//! a restored draft can tell whether the file changed on disk meanwhile.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::{atomic_write, content_hash};
use crate::session::drafts::DraftStore;
use crate::workspace::{kind_for, FileKind};

/// Largest file the editor opens. The frontend has a constant of the same name and value
/// (Task 13); keep them equal.
pub const MAX_EDITOR_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalInfo {
    pub path: PathBuf,
    pub exists: bool,
    pub size: u64,
    pub kind: FileKind,
    pub draft: Option<DraftInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInfo {
    /// The file on disk changed after the edits in the draft started.
    pub disk_changed: bool,
}

/// What another app did to an open external file (`ExternalFiles::outside_state`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExternalState {
    Modified,
    Removed,
}

pub struct ExternalFiles {
    drafts: DraftStore,
    /// Hash of each open file when editing started (`None`: it did not exist yet).
    bases: Mutex<HashMap<PathBuf, Option<String>>>,
}

impl ExternalFiles {
    pub fn new(drafts: DraftStore) -> ExternalFiles {
        ExternalFiles {
            drafts,
            bases: Mutex::new(HashMap::new()),
        }
    }

    /// Looks at the file and remembers what it looked like when editing starts. A waiting draft
    /// keeps the base it was made against.
    pub fn open(&self, path: &Path) -> io::Result<ExternalInfo> {
        let meta = match fs::metadata(path) {
            Ok(meta) => Some(meta),
            Err(err) if err.kind() == io::ErrorKind::NotFound => None,
            Err(err) => return Err(err),
        };
        if meta.as_ref().is_some_and(|m| m.is_dir()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a folder is not a file",
            ));
        }
        // Only a file the editor can open is read and hashed: a video opened through `tote` must
        // not be loaded into memory. Such a file has no base; a missing one has base `None`.
        let editable = meta.as_ref().is_some_and(|m| is_editable(path, m.len()));
        let tracked = meta.is_none() || editable;
        let disk_hash = if editable {
            Some(content_hash(&fs::read(path)?))
        } else {
            None
        };
        let (base, draft) = match self.drafts.get(path)? {
            Some((header, _)) => {
                // A draft is only made while the file is editable, so an uneditable file has
                // certainly changed since.
                let changed = !tracked || header.base_hash != disk_hash;
                (
                    header.base_hash,
                    Some(DraftInfo {
                        disk_changed: changed,
                    }),
                )
            }
            None => (disk_hash, None),
        };
        if tracked {
            self.bases_lock().insert(path.to_path_buf(), base);
        } else {
            self.bases_lock().remove(path);
        }
        Ok(ExternalInfo {
            path: path.to_path_buf(),
            exists: meta.is_some(),
            size: meta.map_or(0, |m| m.len()),
            kind: kind_for(&path.file_name().unwrap_or_default().to_string_lossy()),
            draft,
        })
    }

    /// The file's bytes; a path that does not exist yet reads as empty. An open file without a
    /// draft takes what is read as its base: a tab reading it again after another app changed it
    /// edits from there, so a draft it makes later is not taken for a change on disk. A draft
    /// keeps the base it was made against.
    pub fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let bytes = match fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(err) if err.kind() == io::ErrorKind::NotFound => None,
            Err(err) => return Err(err),
        };
        // A draft store that cannot be read may hold one: the base stays.
        if self.bases_lock().contains_key(path) && matches!(self.drafts.get(path), Ok(None)) {
            let base = bytes.as_deref().map(content_hash);
            self.bases_lock().insert(path.to_path_buf(), base);
        }
        Ok(bytes.unwrap_or_default())
    }

    pub fn read_draft(&self, path: &Path) -> io::Result<Vec<u8>> {
        self.drafts
            .get(path)?
            .map(|(_, contents)| contents)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no draft"))
    }

    pub fn keep_draft(&self, path: &Path, contents: &[u8]) -> io::Result<()> {
        let remembered = self.bases_lock().get(path).cloned();
        let base = match remembered {
            Some(base) => base,
            None => fs::metadata(path)
                .ok()
                .filter(|m| is_editable(path, m.len()))
                .and_then(|_| fs::read(path).ok())
                .map(|bytes| content_hash(&bytes)),
        };
        self.drafts.put(path, base.as_deref(), contents)
    }

    pub fn discard_draft(&self, path: &Path) -> io::Result<()> {
        self.drafts.remove(path)
    }

    /// ⌘S: writes the file (creating it if needed), drops the draft, and makes the saved contents
    /// the new base.
    pub fn save(&self, path: &Path, contents: &[u8]) -> io::Result<u64> {
        atomic_write(path, contents)?;
        // The file already has the new contents; failing here would send the caller into the
        // retry-and-block-quit path for a save that worked.
        if let Err(err) = self.drafts.remove(path) {
            eprintln!("could not remove the draft of {}: {err}", path.display());
        }
        self.bases_lock()
            .insert(path.to_path_buf(), Some(content_hash(contents)));
        Ok(contents.len() as u64)
    }

    /// The file at `path` changed on disk: whether that is news. Contents hashing like the base —
    /// what tote saved last, or what was there when editing started — are not; neither is a file
    /// still missing that was missing then. A file without a base (one the editor does not open)
    /// is not read and counts as modified.
    pub fn outside_state(&self, path: &Path) -> Option<ExternalState> {
        let base = self.bases_lock().get(path).cloned();
        let meta = match fs::metadata(path) {
            Ok(meta) => meta,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                return (base != Some(None)).then_some(ExternalState::Removed);
            }
            Err(err) => {
                eprintln!("tote: could not look at {}: {err}", path.display());
                return None;
            }
        };
        let Some(Some(base)) = base else {
            return Some(ExternalState::Modified);
        };
        let same = is_editable(path, meta.len())
            && fs::read(path).is_ok_and(|bytes| content_hash(&bytes) == base);
        (!same).then_some(ExternalState::Modified)
    }

    fn bases_lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Option<String>>> {
        self.bases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn is_editable(path: &Path, size: u64) -> bool {
    size <= MAX_EDITOR_BYTES
        && kind_for(&path.file_name().unwrap_or_default().to_string_lossy()) == FileKind::Text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn files(dir: &Path) -> ExternalFiles {
        ExternalFiles::new(DraftStore::new(dir.join("buffers")))
    }

    #[test]
    fn a_missing_path_opens_empty_and_save_creates_it() {
        let dir = tempfile::tempdir().unwrap();
        let ext = files(dir.path());
        let path = dir.path().join("새 파일.txt");
        let info = ext.open(&path).unwrap();
        assert!(!info.exists);
        assert_eq!(info.draft, None);
        assert!(ext.read(&path).unwrap().is_empty());
        assert_eq!(ext.save(&path, "처음".as_bytes()).unwrap(), 6);
        assert_eq!(fs::read_to_string(&path).unwrap(), "처음");
    }

    #[test]
    fn a_draft_survives_a_restart_and_notices_disk_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "disk").unwrap();
        let before = files(dir.path());
        before.open(&path).unwrap();
        before.keep_draft(&path, b"edited").unwrap();

        let after = files(dir.path()); // a new process: nothing remembered in memory
        let info = after.open(&path).unwrap();
        assert_eq!(
            info.draft,
            Some(DraftInfo {
                disk_changed: false
            })
        );
        assert_eq!(after.read_draft(&path).unwrap(), b"edited");

        fs::write(&path, "someone else").unwrap();
        let info = files(dir.path()).open(&path).unwrap();
        assert_eq!(info.draft, Some(DraftInfo { disk_changed: true }));
    }

    #[test]
    fn a_reread_of_a_clean_file_moves_its_base() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "v1").unwrap();
        let ext = files(dir.path());
        ext.open(&path).unwrap();
        fs::write(&path, "v2").unwrap();
        assert_eq!(ext.outside_state(&path), Some(ExternalState::Modified));
        assert_eq!(ext.read(&path).unwrap(), b"v2");
        // Read again, the file is where editing starts from: the same contents are no news, and a
        // draft made now is measured against them.
        assert_eq!(ext.outside_state(&path), None);
        ext.keep_draft(&path, b"v2!").unwrap();
        let info = files(dir.path()).open(&path).unwrap();
        assert_eq!(
            info.draft,
            Some(DraftInfo {
                disk_changed: false
            })
        );
    }

    #[test]
    fn a_read_under_a_waiting_draft_keeps_the_drafts_base() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "v0").unwrap();
        let ext = files(dir.path());
        ext.open(&path).unwrap();
        ext.keep_draft(&path, b"mine").unwrap();
        fs::write(&path, "v1").unwrap();
        assert_eq!(ext.read(&path).unwrap(), b"v1");
        ext.keep_draft(&path, b"mine!").unwrap();
        let info = files(dir.path()).open(&path).unwrap();
        assert_eq!(info.draft, Some(DraftInfo { disk_changed: true }));
    }

    #[test]
    fn saving_or_discarding_removes_the_draft() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "disk").unwrap();
        let ext = files(dir.path());
        ext.open(&path).unwrap();
        ext.keep_draft(&path, b"edited").unwrap();
        ext.save(&path, b"edited").unwrap();
        assert_eq!(ext.open(&path).unwrap().draft, None);
        ext.keep_draft(&path, b"again").unwrap();
        ext.discard_draft(&path).unwrap();
        assert_eq!(ext.open(&path).unwrap().draft, None);
        assert_eq!(fs::read_to_string(&path).unwrap(), "edited");
    }

    #[cfg(unix)]
    #[test]
    fn saving_keeps_an_executable_script_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deploy.sh");
        fs::write(&path, "echo old\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let ext = files(dir.path());
        ext.open(&path).unwrap();
        ext.save(&path, b"echo new\n").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn folders_and_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let ext = files(dir.path());
        assert_eq!(
            ext.open(dir.path()).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
        let photo = dir.path().join("사진.png");
        fs::write(&photo, [0u8, 1, 2]).unwrap();
        let info = ext.open(&photo).unwrap();
        assert_eq!((info.kind, info.size), (FileKind::Image, 3));
    }

    #[test]
    fn a_file_over_the_editor_limit_opens_without_reading() {
        let dir = tempfile::tempdir().unwrap();
        let ext = files(dir.path());
        let big = dir.path().join("big.txt");
        fs::File::create(&big)
            .unwrap()
            .set_len(MAX_EDITOR_BYTES + 1)
            .unwrap();
        let info = ext.open(&big).unwrap();
        assert!(info.exists);
        assert_eq!(info.size, MAX_EDITOR_BYTES + 1);
        let photo = dir.path().join("a.png");
        fs::write(&photo, [1u8]).unwrap();
        ext.open(&photo).unwrap();
        let bases = ext.bases_lock();
        assert!(!bases.contains_key(&big));
        assert!(!bases.contains_key(&photo));
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_save_keeps_the_draft() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locked.txt");
        fs::write(&path, "disk").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let ext = files(dir.path());
        ext.open(&path).unwrap();
        ext.keep_draft(&path, b"typed").unwrap();
        let err = ext.save(&path, b"typed").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(ext.read_draft(&path).unwrap(), b"typed");
        assert_eq!(fs::read_to_string(&path).unwrap(), "disk");
    }

    #[cfg(unix)]
    #[test]
    fn a_draft_that_cannot_be_removed_does_not_fail_the_save() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "disk").unwrap();
        let ext = files(dir.path());
        ext.open(&path).unwrap();
        ext.keep_draft(&path, b"edited").unwrap();
        let buffers = dir.path().join("buffers");
        fs::set_permissions(&buffers, fs::Permissions::from_mode(0o555)).unwrap();
        let result = ext.save(&path, b"edited");
        fs::set_permissions(&buffers, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result.unwrap(), 6);
        assert_eq!(fs::read_to_string(&path).unwrap(), "edited");
    }
}
