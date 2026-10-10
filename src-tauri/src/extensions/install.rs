//! Installing, replacing and removing user extensions (spec 「설치와 로딩」). A package is a
//! .vsix or .zip, or a folder. It is unpacked into a staging folder under the user extensions
//! folder, its manifest read, and only then moved to `<id>@<version>` — so a broken package
//! never leaves a half-installed folder, and a rename is what makes it visible.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use super::manifest::{Manifest, ManifestError};
use super::{ExtensionStore, Installed, Source};

/// The vsix layout keeps the extension under this folder; a plain zip may not.
const VSIX_PREFIX: &str = "extension/";
/// Unpacked size above which an archive is refused: no theme or grammar pack comes near it, and
/// a zip bomb would otherwise fill the disk.
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("{id} {version} is already installed")]
    AlreadyInstalled { id: String, version: String },
    #[error("not a usable extension package: {0}")]
    Invalid(String),
    #[error("not an installed extension: {0}")]
    NotInstalled(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl From<ManifestError> for InstallError {
    fn from(err: ManifestError) -> InstallError {
        InstallError::Invalid(err.to_string())
    }
}

pub fn install(
    store: &ExtensionStore,
    source: &Path,
    replace: bool,
) -> Result<Installed, InstallError> {
    fs::create_dir_all(store.user_dir())?;
    let staging = store
        .user_dir()
        .join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    let result = stage_and_place(store, source, replace, &staging);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn stage_and_place(
    store: &ExtensionStore,
    source: &Path,
    replace: bool,
    staging: &Path,
) -> Result<Installed, InstallError> {
    if source.is_dir() {
        copy_folder(source, staging)?;
    } else {
        unpack(source, staging)?;
    }
    let text = fs::read_to_string(staging.join("package.json"))
        .map_err(|_| InstallError::Invalid("package.json 이 없습니다".into()))?;
    let manifest = Manifest::parse(&text)?;
    let id = manifest.id();
    let existing = installed_folders(store.user_dir(), &id)?;
    if let Some((_, version)) = existing.first() {
        if !replace {
            return Err(InstallError::AlreadyInstalled {
                id,
                version: version.clone(),
            });
        }
    }
    let target = store.user_dir().join(format!("{id}@{}", manifest.version));
    // The manifest parser keeps id and version to a safe alphabet; this is the second lock, so a
    // path that leaves the user folder never gets a rename or a delete.
    if target.parent() != Some(store.user_dir()) {
        return Err(InstallError::Invalid(format!("안전하지 않은 경로: {id}")));
    }
    for (folder, _) in &existing {
        fs::remove_dir_all(folder)?;
    }
    fs::rename(staging, &target)?;
    Ok(Installed {
        manifest,
        path: target,
        source: Source::User,
    })
}

pub fn remove(store: &ExtensionStore, id: &str) -> Result<(), InstallError> {
    let folders = installed_folders(store.user_dir(), id)?;
    if folders.is_empty() {
        return Err(InstallError::NotInstalled(id.to_string()));
    }
    for (folder, _) in folders {
        fs::remove_dir_all(folder)?;
    }
    Ok(())
}

/// The user folders of `id` with their versions, by name. Only folders named `<id>@<version>`
/// count: the id of a folder named otherwise is not known without reading its manifest, and
/// such folders were not made by this installer.
fn installed_folders(user_dir: &Path, id: &str) -> io::Result<Vec<(PathBuf, String)>> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(user_dir) else {
        return Ok(found);
    };
    let prefix = format!("{id}@");
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(version) = name.strip_prefix(&prefix) {
            if entry.path().is_dir() {
                found.push((entry.path(), version.to_string()));
            }
        }
    }
    found.sort();
    Ok(found)
}

/// Unpacks an archive into `into`. Entries are placed by `enclosed_name` (the zip crate's
/// traversal-safe name); any other entry fails the whole install. The `extension/` prefix of a
/// vsix is dropped; a zip whose only top-level folder holds package.json is unwrapped likewise.
fn unpack(archive: &Path, into: &Path) -> Result<(), InstallError> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|err| InstallError::Invalid(format!("zip 을 열지 못했습니다: {err}")))?;
    let names: Vec<String> = (0..zip.len())
        .map(|i| {
            let entry = zip
                .by_index(i)
                .map_err(|err| InstallError::Invalid(err.to_string()))?;
            entry
                .enclosed_name()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .ok_or_else(|| {
                    InstallError::Invalid(format!(
                        "안전하지 않은 항목: {}",
                        entry.name().map(|n| n.into_owned()).unwrap_or_default()
                    ))
                })
        })
        .collect::<Result<_, _>>()?;
    let prefix = archive_prefix(&names)?;
    let mut total: u64 = 0;
    for (i, name) in names.iter().enumerate() {
        let mut entry = zip
            .by_index(i)
            .map_err(|err| InstallError::Invalid(err.to_string()))?;
        if entry.is_dir() {
            continue;
        }
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue; // a vsix's wrapper files outside extension/
        };
        total += entry.size();
        if total > MAX_UNPACKED_BYTES {
            return Err(InstallError::Invalid("압축을 풀면 너무 큽니다".into()));
        }
        let target = into.join(rest);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes)?;
        fs::write(&target, bytes)?;
    }
    Ok(())
}

/// Where package.json sits in the archive: at the root (`""`), under `extension/` (a vsix), or
/// under the single top-level folder a hand-made zip tends to have.
fn archive_prefix(names: &[String]) -> Result<String, InstallError> {
    if names.iter().any(|n| n == "package.json") {
        return Ok(String::new());
    }
    if names.iter().any(|n| n == "extension/package.json") {
        return Ok(VSIX_PREFIX.to_string());
    }
    let mut tops: Vec<&str> = names
        .iter()
        .filter_map(|n| n.split_once('/').map(|(top, _)| top))
        .collect();
    tops.sort_unstable();
    tops.dedup();
    if let [only] = tops.as_slice() {
        let prefix = format!("{only}/");
        if names.iter().any(|n| *n == format!("{prefix}package.json")) {
            return Ok(prefix);
        }
    }
    Err(InstallError::Invalid("package.json 이 없습니다".into()))
}

/// Copies `from` into `to`, files and folders only; symlinks are skipped so a link to somewhere
/// else never ends up served as part of the extension.
fn copy_folder(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_folder(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    use crate::extensions::manifest::tests::fixture_vsix;
    use crate::extensions::tests::write_extension;

    fn store(dir: &Path) -> ExtensionStore {
        ExtensionStore::new(dir.join("bundled"), dir.join("user"))
    }

    #[test]
    fn installs_the_fixture_vsix_under_id_and_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let installed = install(&store, &fixture_vsix(), false).unwrap();
        assert_eq!(installed.manifest.id(), "tote-test.test-theme");
        assert_eq!(installed.source, Source::User);
        assert_eq!(
            installed.path,
            dir.path().join("user/tote-test.test-theme@0.0.1")
        );
        assert!(installed
            .path
            .join("themes/night-color-theme.json")
            .is_file());
        assert!(installed
            .path
            .join("syntaxes/tote.tmLanguage.json")
            .is_file());
        // The vsix wrapper files stay out of the extension folder.
        assert!(!installed.path.join("extension.vsixmanifest").exists());
        assert!(!installed.path.join("extension").exists());
        // Nothing is left of the staging folder.
        let leftovers: Vec<String> = fs::read_dir(dir.path().join("user"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["tote-test.test-theme@0.0.1"]);
        assert_eq!(store.scan().extensions.len(), 1);
    }

    #[test]
    fn the_same_id_needs_replace_and_then_the_old_version_goes() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        write_extension(
            &dir.path().join("user"),
            "tote-test.test-theme@0.0.0",
            r#"{"name": "test-theme", "publisher": "tote-test", "version": "0.0.0"}"#,
        );
        let err = install(&store, &fixture_vsix(), false).unwrap_err();
        assert!(
            matches!(err, InstallError::AlreadyInstalled { ref version, .. } if version == "0.0.0")
        );
        assert!(dir.path().join("user/tote-test.test-theme@0.0.0").is_dir());
        let installed = install(&store, &fixture_vsix(), true).unwrap();
        assert_eq!(installed.manifest.version, "0.0.1");
        assert!(!dir.path().join("user/tote-test.test-theme@0.0.0").exists());
        assert!(dir.path().join("user/tote-test.test-theme@0.0.1").is_dir());
    }

    #[test]
    fn installs_a_plain_zip_and_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        // A zip with package.json at its root (not the vsix layout).
        let zip_path = dir.path().join("plain.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("package.json", options).unwrap();
            zip.write_all(br#"{"name": "plain", "publisher": "p", "version": "1.0.0"}"#)
                .unwrap();
            zip.start_file("themes/a.json", options).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.finish().unwrap();
        }
        let plain = install(&store, &zip_path, false).unwrap();
        assert_eq!(plain.manifest.id(), "p.plain");
        assert!(plain.path.join("themes/a.json").is_file());

        let folder = write_extension(
            dir.path(),
            "somewhere/folder-ext",
            r#"{"name": "folder", "publisher": "p", "version": "2.0.0"}"#,
        );
        fs::create_dir_all(folder.join("sub")).unwrap();
        fs::write(folder.join("sub/x.json"), "{}").unwrap();
        let from_folder = install(&store, &folder, false).unwrap();
        assert_eq!(from_folder.path, dir.path().join("user/p.folder@2.0.0"));
        assert!(from_folder.path.join("sub/x.json").is_file());
        assert!(folder.join("package.json").is_file()); // the source folder is untouched
    }

    #[test]
    fn entries_that_escape_the_folder_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let zip_path = dir.path().join("evil.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("package.json", options).unwrap();
            zip.write_all(br#"{"name": "evil", "publisher": "p", "version": "1"}"#)
                .unwrap();
            zip.start_file("../outside.txt", options).unwrap();
            zip.write_all(b"escaped").unwrap();
            zip.finish().unwrap();
        }
        let err = install(&store, &zip_path, false).unwrap_err();
        assert!(matches!(err, InstallError::Invalid(_)));
        assert!(!dir.path().join("outside.txt").exists());
        assert!(!dir.path().join("user/outside.txt").exists());
        assert!(fs::read_dir(dir.path().join("user"))
            .map(|d| d.count() == 0)
            .unwrap_or(true));
    }

    #[test]
    fn a_package_without_a_manifest_or_with_a_broken_one_installs_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let zip_path = dir.path().join("none.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("readme.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"hi").unwrap();
            zip.finish().unwrap();
        }
        assert!(matches!(
            install(&store, &zip_path, false),
            Err(InstallError::Invalid(_))
        ));
        let broken = write_extension(dir.path(), "broken", "{ nope");
        assert!(matches!(
            install(&store, &broken, false),
            Err(InstallError::Invalid(_))
        ));
        assert!(matches!(
            install(&store, &dir.path().join("missing.vsix"), false),
            Err(InstallError::Io(_))
        ));
        assert!(fs::read_dir(dir.path().join("user"))
            .map(|d| d.count() == 0)
            .unwrap_or(true));
    }

    #[test]
    fn remove_deletes_every_folder_of_the_id_and_refuses_bundled_ones() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        install(&store, &fixture_vsix(), false).unwrap();
        remove(&store, "tote-test.test-theme").unwrap();
        assert!(store.scan().extensions.is_empty());
        assert!(matches!(
            remove(&store, "tote-test.test-theme"),
            Err(InstallError::NotInstalled(_))
        ));
        write_extension(
            &dir.path().join("bundled"),
            "tote.themes",
            r#"{"name": "themes", "publisher": "tote", "version": "1"}"#,
        );
        assert!(matches!(
            remove(&store, "tote.themes"),
            Err(InstallError::NotInstalled(_))
        ));
        assert!(dir.path().join("bundled/tote.themes").is_dir());
    }
}
