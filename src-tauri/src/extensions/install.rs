//! Installing, replacing and removing user extensions (spec 「설치와 로딩」). A package is a
//! .vsix or .zip, or a folder. It is unpacked into a staging folder under the user extensions
//! folder, its manifest read, and only then moved to `<id>@<version>` — so a broken package
//! never leaves a half-installed folder, and a rename is what makes it visible.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::manifest::{Manifest, ManifestError};
use super::{ExtensionStore, Installed, Source};

/// The vsix layout keeps the extension under this folder; a plain zip may not.
const VSIX_PREFIX: &str = "extension/";
/// Unpacked size above which an archive is refused: no theme or grammar pack comes near it, and
/// a zip bomb would otherwise fill the disk.
pub(crate) const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;

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
        check_folder(store, source)?;
        copy_folder(source, staging, &mut 0)?;
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
    if !inside_user_dir(store.user_dir(), &target) {
        return Err(InstallError::Invalid(format!("안전하지 않은 경로: {id}")));
    }
    // The old versions are moved aside, not deleted, until the new one is in place: a rename
    // that fails puts them back, so a failed replace leaves the extension as it was. Trash left
    // by a crash in between is put back or removed at the next start
    // (`ExtensionStore::remove_leftovers`).
    let mut trashed: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (folder, _) in &existing {
        let trash = store
            .user_dir()
            .join(format!(".trash-{}", uuid::Uuid::new_v4().simple()));
        if let Err(err) = fs::rename(folder, &trash) {
            put_back(&trashed);
            return Err(err.into());
        }
        trashed.push((folder.clone(), trash));
    }
    if let Err(err) = fs::rename(staging, &target) {
        put_back(&trashed);
        return Err(err.into());
    }
    for (_, trash) in &trashed {
        let _ = fs::remove_dir_all(trash);
    }
    Ok(Installed {
        manifest,
        path: target,
        source: Source::User,
    })
}

/// The manifest parser keeps id and version to a safe alphabet; this is the second lock, so a
/// path that leaves the user folder never gets a rename or a delete.
fn inside_user_dir(user_dir: &Path, target: &Path) -> bool {
    target.parent() == Some(user_dir)
}

fn put_back(trashed: &[(PathBuf, PathBuf)]) {
    for (folder, trash) in trashed {
        let _ = fs::rename(trash, folder);
    }
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
pub(super) fn installed_folders(user_dir: &Path, id: &str) -> io::Result<Vec<(PathBuf, String)>> {
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
    unpack_with_limit(archive, into, MAX_UNPACKED_BYTES)
}

fn unpack_with_limit(archive: &Path, into: &Path, limit: u64) -> Result<(), InstallError> {
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
        if total > limit {
            return Err(InstallError::Invalid("압축을 풀면 너무 큽니다".into()));
        }
        let target = into.join(rest);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        io::copy(&mut entry, &mut fs::File::create(&target)?)?;
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

/// What a picked folder must be before anything is copied: a folder with a usable manifest
/// that is not the user extensions folder or one of its ancestors (copying such a folder would
/// recurse into its own staging folder).
fn check_folder(store: &ExtensionStore, source: &Path) -> Result<(), InstallError> {
    let text = fs::read_to_string(source.join("package.json"))
        .map_err(|_| InstallError::Invalid("package.json 이 없습니다".into()))?;
    Manifest::parse(&text)?;
    if fs::canonicalize(store.user_dir())?.starts_with(fs::canonicalize(source)?) {
        return Err(InstallError::Invalid(
            "확장 설치 폴더나 그 상위 폴더는 고를 수 없습니다".into(),
        ));
    }
    Ok(())
}

/// Copies `from` into `to`, files and folders only; symlinks are skipped so a link to somewhere
/// else never ends up served as part of the extension. `total` counts the bytes copied so far
/// across the whole tree, held to the same limit as an archive.
fn copy_folder(from: &Path, to: &Path, total: &mut u64) -> Result<(), InstallError> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_folder(&entry.path(), &target, total)?;
        } else if kind.is_file() {
            *total += entry.metadata()?.len();
            if *total > MAX_UNPACKED_BYTES {
                return Err(InstallError::Invalid("폴더가 너무 큽니다".into()));
            }
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

    fn user_dir_is_empty(dir: &Path) -> bool {
        fs::read_dir(dir.join("user"))
            .map(|d| d.count() == 0)
            .unwrap_or(true)
    }

    #[test]
    fn a_folder_without_a_usable_manifest_is_refused_before_anything_is_copied() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let none = dir.path().join("picked");
        fs::create_dir_all(none.join("deep")).unwrap();
        fs::write(none.join("deep/file.txt"), "x").unwrap();
        assert!(matches!(
            install(&store, &none, false),
            Err(InstallError::Invalid(_))
        ));
        let broken = write_extension(dir.path(), "broken", "{ nope");
        assert!(matches!(
            install(&store, &broken, false),
            Err(InstallError::Invalid(_))
        ));
        assert!(user_dir_is_empty(dir.path()));
    }

    #[test]
    fn the_user_folder_and_its_ancestors_cannot_be_installed_from() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        // The picked folder holds a valid manifest and the user folder sits inside it.
        fs::write(
            dir.path().join("package.json"),
            r#"{"name": "up", "publisher": "p", "version": "1"}"#,
        )
        .unwrap();
        fs::write(dir.path().join("note.txt"), "x").unwrap();
        assert!(matches!(
            install(&store, dir.path(), false),
            Err(InstallError::Invalid(_))
        ));
        assert!(user_dir_is_empty(dir.path()));
        fs::write(
            dir.path().join("user/package.json"),
            r#"{"name": "same", "publisher": "p", "version": "1"}"#,
        )
        .unwrap();
        assert!(matches!(
            install(&store, &dir.path().join("user"), false),
            Err(InstallError::Invalid(_))
        ));
        assert!(!dir.path().join("user/p.same@1").exists());
    }

    #[test]
    fn a_folder_over_the_size_limit_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let big = write_extension(
            dir.path(),
            "big",
            r#"{"name": "big", "publisher": "p", "version": "1"}"#,
        );
        // Sparse: the length counts against the limit but no disk is used.
        fs::File::create(big.join("huge.bin"))
            .unwrap()
            .set_len(MAX_UNPACKED_BYTES + 1)
            .unwrap();
        assert!(matches!(
            install(&store, &big, false),
            Err(InstallError::Invalid(_))
        ));
        assert!(user_dir_is_empty(dir.path()));
    }

    #[test]
    fn archive_prefix_finds_the_manifest_at_root_under_extension_or_a_single_top_folder() {
        let names = |list: &[&str]| list.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        assert_eq!(
            archive_prefix(&names(&["package.json", "themes/a.json"])).unwrap(),
            ""
        );
        assert_eq!(
            archive_prefix(&names(&[
                "extension.vsixmanifest",
                "extension/package.json",
                "extension/themes/a.json",
            ]))
            .unwrap(),
            "extension/"
        );
        assert_eq!(
            archive_prefix(&names(&["night/package.json", "night/themes/a.json"])).unwrap(),
            "night/"
        );
        assert!(matches!(
            archive_prefix(&names(&["night/package.json", "other/readme.md"])),
            Err(InstallError::Invalid(_))
        ));
    }

    #[test]
    fn an_archive_over_the_unpacked_limit_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("big.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("package.json", options).unwrap();
            zip.write_all(br#"{"name": "big", "publisher": "p", "version": "1"}"#)
                .unwrap();
            zip.start_file("data.bin", options).unwrap();
            zip.write_all(&[7; 100]).unwrap();
            zip.finish().unwrap();
        }
        assert!(matches!(
            unpack_with_limit(&zip_path, &dir.path().join("small"), 120),
            Err(InstallError::Invalid(_))
        ));
        unpack_with_limit(&zip_path, &dir.path().join("roomy"), 1024).unwrap();
        assert_eq!(
            fs::read(dir.path().join("roomy/data.bin")).unwrap(),
            [7; 100]
        );
    }

    #[cfg(unix)]
    #[test]
    fn copy_folder_skips_symlinks_and_keeps_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let secret = dir.path().join("secret");
        fs::create_dir_all(&secret).unwrap();
        fs::write(secret.join("key.txt"), "private").unwrap();
        let folder = write_extension(
            dir.path(),
            "linked",
            r#"{"name": "linked", "publisher": "p", "version": "1"}"#,
        );
        fs::write(folder.join("theme.json"), "{}").unwrap();
        std::os::unix::fs::symlink(secret.join("key.txt"), folder.join("key.txt")).unwrap();
        std::os::unix::fs::symlink(&secret, folder.join("secret")).unwrap();
        let installed = install(&store, &folder, false).unwrap();
        assert!(installed.path.join("theme.json").is_file());
        assert!(installed.path.join("package.json").is_file());
        assert!(fs::symlink_metadata(installed.path.join("key.txt")).is_err());
        assert!(fs::symlink_metadata(installed.path.join("secret")).is_err());
    }

    #[test]
    fn a_target_outside_the_user_folder_is_refused() {
        let user = Path::new("/data/extensions");
        assert!(inside_user_dir(user, &user.join("p.x@1")));
        assert!(!inside_user_dir(user, &user.join("../x@1")));
        assert!(!inside_user_dir(user, &user.join("p/x@1")));
        assert!(!inside_user_dir(user, Path::new("/elsewhere/p.x@1")));
    }

    #[test]
    fn a_replace_that_fails_at_the_rename_keeps_the_old_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let old = write_extension(
            &dir.path().join("user"),
            "tote-test.test-theme@0.0.0",
            r#"{"name": "test-theme", "publisher": "tote-test", "version": "0.0.0"}"#,
        );
        // A file where the new version's folder goes: the rename into place cannot succeed.
        fs::write(
            dir.path().join("user/tote-test.test-theme@0.0.1"),
            "in the way",
        )
        .unwrap();
        assert!(matches!(
            install(&store, &fixture_vsix(), true),
            Err(InstallError::Io(_))
        ));
        assert!(old.join("package.json").is_file());
        let mut left: Vec<String> = fs::read_dir(dir.path().join("user"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec!["tote-test.test-theme@0.0.0", "tote-test.test-theme@0.0.1"]
        );
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
