//! Writing files so that a crash never leaves one half-written.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const TEMP_PREFIX: &str = ".tote-tmp-";

/// Replaces the contents of `path` with `bytes`: they go to a temporary file in the same folder,
/// which is then renamed over `path`, so a crash leaves the old or the new contents and never a
/// mix. Files are never modified in place — backups hard-link earlier copies and rely on that.
///
/// The replaced file's permissions carry over (a script stays executable), and a symlink is
/// followed so the file it points to changes while the link stays a link. Extended attributes
/// such as Finder tags do not carry over.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = follow_link(path)?;
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
}
