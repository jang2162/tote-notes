//! Extensions as installed on disk (spec 「확장 구조」): the bundled ones inside the app bundle
//! (read-only) and the ones the person installed under the app data folder. Scanning reads
//! every manifest; a broken one is reported, never fatal — the app starts regardless.

pub mod install;
pub mod jsonc;
pub mod manifest;
pub mod registry;
pub mod serve;

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use manifest::Manifest;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Bundled,
    User,
}

#[derive(Clone, Debug)]
pub struct Installed {
    pub manifest: Manifest,
    pub path: PathBuf,
    pub source: Source,
}

/// A folder that could not be used as an extension, for the settings screen.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionProblem {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Clone, Debug, Default)]
pub struct Scan {
    pub extensions: Vec<Installed>,
    pub problems: Vec<ExtensionProblem>,
}

pub struct ExtensionStore {
    bundled_dir: PathBuf,
    user_dir: PathBuf,
}

impl ExtensionStore {
    pub fn new(bundled_dir: PathBuf, user_dir: PathBuf) -> ExtensionStore {
        ExtensionStore {
            bundled_dir,
            user_dir,
        }
    }

    pub fn user_dir(&self) -> &Path {
        &self.user_dir
    }

    /// Bundled extensions first, then user ones, each folder in name order. A user folder whose
    /// id a listed extension already has is reported and skipped: two copies would fight over
    /// the same file extensions.
    pub fn scan(&self) -> Scan {
        let mut scan = Scan::default();
        read_folder(&self.bundled_dir, Source::Bundled, &mut scan);
        read_folder(&self.user_dir, Source::User, &mut scan);
        scan
    }

    /// Removes what an install cut short leaves in the user folder: a staging folder, or the old
    /// versions moved aside during a replace. Only at start: during a run another window may be
    /// installing, and its staging folder is in use.
    pub fn remove_leftovers(&self) {
        let Ok(entries) = fs::read_dir(&self.user_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if (name.starts_with(".staging-") || name.starts_with(".trash-"))
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
            {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    pub fn find(&self, id: &str) -> Option<Installed> {
        self.scan()
            .extensions
            .into_iter()
            .find(|e| e.manifest.id() == id)
    }
}

fn read_folder(dir: &Path, source: Source, scan: &mut Scan) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut folders: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| !n.starts_with('.'))
        })
        .collect();
    folders.sort();
    for path in folders {
        let file = path.join("package.json");
        if !file.is_file() {
            continue;
        }
        let parsed = fs::read_to_string(&file)
            .map_err(|err| format!("package.json 을 읽을 수 없습니다: {err}"))
            .and_then(|text| Manifest::parse(&text).map_err(|err| err.to_string()));
        match parsed {
            Ok(manifest) => {
                let id = manifest.id();
                if scan.extensions.iter().any(|e| e.manifest.id() == id) {
                    scan.problems.push(ExtensionProblem {
                        path,
                        message: format!("{id} 는 이미 다른 폴더에 설치돼 있습니다"),
                    });
                } else {
                    scan.extensions.push(Installed {
                        manifest,
                        path,
                        source,
                    });
                }
            }
            Err(message) => scan.problems.push(ExtensionProblem { path, message }),
        }
    }
}

/// The file `relative` names inside `root`, or `None` when it does not exist, leaves `root`
/// (`..`, an absolute path, a symlink pointing out) or is not a regular file. Everything that
/// serves an extension's files goes through here.
pub fn file_inside(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = manifest::relative_path(relative).ok()?;
    let root = fs::canonicalize(root).ok()?;
    let file = fs::canonicalize(root.join(relative)).ok()?;
    (file.starts_with(&root) && file.is_file()).then_some(file)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    pub(crate) fn write_extension(dir: &Path, folder: &str, manifest: &str) -> PathBuf {
        let path = dir.join(folder);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("package.json"), manifest).unwrap();
        path
    }

    const THEME_EXT: &str = r#"{"name": "night", "publisher": "someone", "version": "2.0.0",
        "contributes": {"themes": [{"label": "Night", "uiTheme": "vs-dark", "path": "t.json"}]}}"#;

    #[test]
    fn scan_lists_both_folders_and_reports_broken_manifests() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("bundled");
        let user = dir.path().join("user");
        write_extension(
            &bundled,
            "tote.themes",
            r#"{"name": "themes", "publisher": "tote", "version": "1.0.0"}"#,
        );
        write_extension(&user, "someone.night@2.0.0", THEME_EXT);
        write_extension(&user, "broken@1", "{ not json");
        write_extension(&user, "nameless@1", r#"{"publisher": "p", "version": "1"}"#);
        fs::create_dir_all(user.join("no-manifest")).unwrap();
        fs::create_dir_all(user.join(".staging-123")).unwrap();
        fs::write(user.join("stray.txt"), "").unwrap();

        let scan = ExtensionStore::new(bundled, user.clone()).scan();
        let ids: Vec<(String, Source)> = scan
            .extensions
            .iter()
            .map(|e| (e.manifest.id(), e.source))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("tote.themes".to_string(), Source::Bundled),
                ("someone.night".to_string(), Source::User)
            ]
        );
        let mut problems: Vec<&Path> = scan.problems.iter().map(|p| p.path.as_path()).collect();
        problems.sort();
        assert_eq!(
            problems,
            vec![
                user.join("broken@1").as_path(),
                user.join("nameless@1").as_path()
            ]
        );
        assert!(scan.problems.iter().all(|p| !p.message.is_empty()));
    }

    #[test]
    fn a_missing_folder_scans_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let scan = ExtensionStore::new(dir.path().join("none"), dir.path().join("none2")).scan();
        assert!(scan.extensions.is_empty() && scan.problems.is_empty());
    }

    #[test]
    fn leftovers_of_an_interrupted_install_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user");
        write_extension(
            &user,
            ".staging-1",
            r#"{"name": "a", "publisher": "p", "version": "1"}"#,
        );
        write_extension(
            &user,
            ".trash-2",
            r#"{"name": "b", "publisher": "p", "version": "1"}"#,
        );
        write_extension(
            &user,
            "p.c@1",
            r#"{"name": "c", "publisher": "p", "version": "1"}"#,
        );
        fs::write(user.join(".DS_Store"), "").unwrap();
        let store = ExtensionStore::new(dir.path().join("bundled"), user.clone());
        store.remove_leftovers();
        let mut left: Vec<String> = fs::read_dir(&user)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec![".DS_Store", "p.c@1"]);
        ExtensionStore::new(dir.path().join("bundled"), dir.path().join("none")).remove_leftovers();
    }

    #[test]
    fn two_user_copies_of_one_id_keep_the_first_and_report_the_other() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user");
        write_extension(&user, "someone.night@1.0.0", THEME_EXT);
        write_extension(&user, "someone.night@2.0.0", THEME_EXT);
        let scan = ExtensionStore::new(dir.path().join("bundled"), user.clone()).scan();
        assert_eq!(scan.extensions.len(), 1);
        assert_eq!(scan.extensions[0].path, user.join("someone.night@1.0.0"));
        assert_eq!(scan.problems.len(), 1);
        assert!(scan.problems[0].message.contains("someone.night"));
    }

    #[test]
    fn file_inside_refuses_escapes_and_links_out() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ext");
        fs::create_dir_all(root.join("themes")).unwrap();
        fs::write(root.join("themes/a.json"), "{}").unwrap();
        fs::write(dir.path().join("secret.json"), "{}").unwrap();
        assert_eq!(
            file_inside(&root, "themes/a.json"),
            Some(root.join("themes/a.json").canonicalize().unwrap())
        );
        assert!(file_inside(&root, "./themes/a.json").is_some());
        for bad in [
            "../secret.json",
            "/etc/passwd",
            "themes/../../secret.json",
            "",
            "missing.json",
        ] {
            assert_eq!(file_inside(&root, bad), None, "{bad:?}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret.json"), root.join("link.json"))
                .unwrap();
            assert_eq!(file_inside(&root, "link.json"), None);
        }
    }
}
