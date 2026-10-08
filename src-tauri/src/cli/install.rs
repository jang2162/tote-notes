//! 「셸 명령 설치」: a `tote` symlink to the script inside the app bundle (spec 「`tote` CLI」).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum Installed {
    /// In the preferred folder, which shells have on PATH.
    Preferred(PathBuf),
    /// In the fallback folder, which the person may still have to put on PATH.
    Fallback(PathBuf),
}

/// Links `<preferred>/tote` to `script`, or `<fallback>/tote` (creating the folder) when the
/// preferred folder is missing or not writable — `/usr/local/bin` needs admin rights on many Macs.
pub fn install(script: &Path, preferred: &Path, fallback: &Path) -> io::Result<Installed> {
    let target = preferred.join("tote");
    match link(script, &target) {
        Ok(()) => return Ok(Installed::Preferred(target)),
        Err(err)
            if matches!(
                err.kind(),
                io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound
            ) => {}
        Err(err) => return Err(err),
    }
    fs::create_dir_all(fallback)?;
    let target = fallback.join("tote");
    link(script, &target)?;
    Ok(Installed::Fallback(target))
}

/// Replaces an earlier `tote` link (the app moved) but never anything else someone put there —
/// a file, or a link to another program (Homebrew, pipx, a hand-made one).
fn link(script: &Path, at: &Path) -> io::Result<()> {
    match fs::symlink_metadata(at) {
        Ok(meta) if meta.file_type().is_symlink() && is_tote_link(script, at) => {
            fs::remove_file(at)?
        }
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} 가 이미 있고 링크가 아닙니다", at.display()),
            ))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(script, at)
    }
    #[cfg(not(unix))]
    {
        let _ = script;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "macOS only for now",
        ))
    }
}

/// A link we made: it points at this script, or at the script of a tote.app in its old place.
fn is_tote_link(script: &Path, at: &Path) -> bool {
    fs::read_link(at)
        .is_ok_and(|target| target == script || target.ends_with("Contents/Resources/bin/tote"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &Path) -> PathBuf {
        let script = dir.join("bin-tote");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        script
    }

    #[test]
    fn links_into_the_preferred_folder() {
        let dir = tempfile::tempdir().unwrap();
        let script = script(dir.path());
        let preferred = dir.path().join("usr-local-bin");
        fs::create_dir(&preferred).unwrap();
        assert_eq!(
            install(&script, &preferred, &dir.path().join("fallback")).unwrap(),
            Installed::Preferred(preferred.join("tote"))
        );
        assert_eq!(fs::read_link(preferred.join("tote")).unwrap(), script);
    }

    #[test]
    fn falls_back_when_the_preferred_folder_is_locked_or_missing() {
        let dir = tempfile::tempdir().unwrap();
        let script = script(dir.path());
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        let fallback = dir.path().join("home/.local/bin");
        let result = install(&script, &locked, &fallback);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result.unwrap(), Installed::Fallback(fallback.join("tote")));
        assert_eq!(
            install(&script, &dir.path().join("missing"), &fallback).unwrap(),
            Installed::Fallback(fallback.join("tote"))
        );
    }

    #[test]
    fn replaces_an_old_link_but_never_a_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let script = script(dir.path());
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        std::os::unix::fs::symlink(
            "/Old/tote.app/Contents/Resources/bin/tote",
            bin.join("tote"),
        )
        .unwrap();
        install(&script, &bin, &dir.path().join("fb")).unwrap();
        assert_eq!(fs::read_link(bin.join("tote")).unwrap(), script);
        fs::remove_file(bin.join("tote")).unwrap();
        let brew = Path::new("/opt/homebrew/Cellar/tote/1.0/bin/tote");
        std::os::unix::fs::symlink(brew, bin.join("tote")).unwrap();
        let err = install(&script, &bin, &dir.path().join("fb")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_link(bin.join("tote")).unwrap(), brew);
        fs::remove_file(bin.join("tote")).unwrap();
        fs::write(bin.join("tote"), "someone else's").unwrap();
        let err = install(&script, &bin, &dir.path().join("fb")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
    }
}
