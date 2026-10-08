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
        let disk_hash = match meta {
            Some(_) => Some(content_hash(&fs::read(path)?)),
            None => None,
        };
        let (base, draft) = match self.drafts.get(path)? {
            Some((header, _)) => {
                let changed = header.base_hash != disk_hash;
                (
                    header.base_hash,
                    Some(DraftInfo {
                        disk_changed: changed,
                    }),
                )
            }
            None => (disk_hash, None),
        };
        self.bases_lock().insert(path.to_path_buf(), base);
        Ok(ExternalInfo {
            path: path.to_path_buf(),
            exists: meta.is_some(),
            size: meta.map_or(0, |m| m.len()),
            kind: kind_for(&path.file_name().unwrap_or_default().to_string_lossy()),
            draft,
        })
    }

    /// The file's bytes; a path that does not exist yet reads as empty.
    pub fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        match fs::read(path) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
            other => other,
        }
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
            None => fs::read(path).ok().map(|bytes| content_hash(&bytes)),
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
        self.drafts.remove(path)?;
        self.bases_lock()
            .insert(path.to_path_buf(), Some(content_hash(contents)));
        Ok(contents.len() as u64)
    }

    fn bases_lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Option<String>>> {
        self.bases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
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
}
