//! Writing files so that a crash never leaves one half-written, and the JSON files built on
//! that: reading one (setting a broken file aside instead of failing) and writing one.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};

const TEMP_PREFIX: &str = ".tote-tmp-";

/// Replaces the contents of `path` with `bytes`: they go to a temporary file in the same folder,
/// which is then renamed over `path`, so a crash leaves the old or the new contents and never a
/// mix. Files are never modified in place — backups hard-link earlier copies and rely on that.
///
/// The replaced file's permissions carry over (a script stays executable), and a symlink is
/// followed so the file it points to changes while the link stays a link. Extended attributes
/// such as Finder tags do not carry over.
///
/// A read-only file is refused with `PermissionDenied`: someone locked it on purpose, and the
/// rename would replace it anyway, so the caller shows a save failure instead. A symlink whose
/// target is missing fails with `NotFound` rather than turning the link into a plain file.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = follow_link(path)?;
    // Not `?`: a missing target is a new file, which is fine.
    if let Ok(meta) = fs::metadata(&target) {
        if meta.permissions().readonly() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "file is read-only",
            ));
        }
    }
    let dir = target
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent folder"))?;
    // Named after a UUID only: the target's name plus a suffix could pass the 255-byte limit.
    let temp = dir.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4().simple()));
    let result = write_and_rename(&temp, &target, bytes);
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_and_rename(temp: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create(temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    if let Ok(meta) = fs::metadata(target) {
        fs::set_permissions(temp, meta.permissions())?;
    }
    fs::rename(temp, target)
}

fn follow_link(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path),
        _ => Ok(path.to_path_buf()),
    }
}

/// A temporary file `atomic_write` left behind when the app died between write and rename. The
/// leading dot keeps it out of memo listings either way.
pub fn is_temp_file(name: &str) -> bool {
    name.starts_with(TEMP_PREFIX)
}

/// Hex SHA-256 of `bytes`. It is stored in draft files, so it must stay the same across builds —
/// which rules out std's `DefaultHasher`.
pub fn content_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Reads JSON from `path`. Missing is `Ok(None)`. A file that does not parse as `T` is moved aside
/// to `<name>.corrupt-<unix ms>` and also reads as `Ok(None)`: the caller starts over without
/// destroying what was there (spec 「오류 처리」).
pub fn read_json<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(Some(value)),
        Err(_) => {
            set_aside(path)?;
            Ok(None)
        }
    }
}

/// Renames `path` to `<name>.corrupt-<unix ms>` next to it and returns the new path.
pub fn set_aside(path: &Path) -> io::Result<PathBuf> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".corrupt-{millis}"));
    let aside = path.with_file_name(name);
    fs::rename(path, &aside)?;
    Ok(aside)
}

/// Writes `value` as pretty JSON through `atomic_write`, creating the folder when needed.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn creates_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("새 메모.md");
        atomic_write(&path, "안녕".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "안녕");
    }

    #[test]
    fn replaces_contents_without_leaving_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(names(dir.path()), vec!["a.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deploy.sh");
        fs::write(&path, "echo old\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        atomic_write(&path, b"echo new\n").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlink_and_keeps_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.txt");
        let link = dir.path().join("link.txt");
        fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        atomic_write(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_keeps_the_old_contents() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let result = atomic_write(&path, b"new");
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        assert_eq!(names(dir.path()), vec!["a.txt"]);
    }

    #[test]
    fn a_failed_rename_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("memo.md");
        fs::create_dir(&target).unwrap(); // a file cannot be renamed over a folder
        assert!(atomic_write(&target, b"new").is_err());
        assert_eq!(names(dir.path()), vec!["memo.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_file_is_not_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locked.md");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let err = atomic_write(&path, b"new").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        assert_eq!(names(dir.path()), vec!["locked.md"]);
    }

    #[test]
    fn temp_files_are_recognised() {
        assert!(is_temp_file(".tote-tmp-0123abcd"));
        assert!(!is_temp_file("tote-tmp.md"));
    }

    #[test]
    fn hash_is_lowercase_hex_sha256() {
        assert_eq!(
            content_hash(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct Sample {
        name: String,
    }

    #[test]
    fn json_round_trips_and_creates_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/폴더/a.json");
        write_json(
            &path,
            &Sample {
                name: "메모".into(),
            },
        )
        .unwrap();
        assert!(fs::read_to_string(&path).unwrap().ends_with("}\n"));
        assert_eq!(
            read_json::<Sample>(&path).unwrap(),
            Some(Sample {
                name: "메모".into()
            })
        );
    }

    #[test]
    fn missing_json_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_json::<Sample>(&dir.path().join("none.json")).unwrap(),
            None
        );
    }

    #[test]
    fn unreadable_json_is_set_aside_with_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.json");
        fs::write(&path, "{ broken").unwrap();
        assert_eq!(read_json::<Sample>(&path).unwrap(), None);
        let names = names(dir.path());
        assert_eq!(names.len(), 1);
        assert!(names[0].starts_with("index.json.corrupt-"));
        assert_eq!(
            fs::read_to_string(dir.path().join(&names[0])).unwrap(),
            "{ broken"
        );
    }
}
