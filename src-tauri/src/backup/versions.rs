//! A memo's earlier versions (spec 「백업」 복원): found by memo ID through each snapshot's
//! `.tote/index.json`, so a renamed memo is followed, and told apart by the manifest's hashes.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Component, Path};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::snapshot::{Manifest, INDEX_FILE, MANIFEST_FILE};
use super::{BackupDir, SnapshotName};
use crate::workspace::index::MemoEntry;
use crate::workspace::TOTE_DIR;

/// One earlier version of a memo: its copy in a snapshot.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Version {
    snapshot: String,
    file: String,
    size: u64,
    sha256: String,
}

/// The part of a snapshot's `.tote/index.json` that finds a memo.
#[derive(Deserialize)]
struct SnapshotIndex {
    memos: BTreeMap<String, MemoEntry>,
}

/// The versions of memo `memo_id`, newest first. Only where the text differs from the next older
/// snapshot holding the memo: of a run of equal copies the oldest stays, the moment that text was
/// first backed up. The newest is not compared with the workspace — it is listed even when the
/// memo still reads the same.
pub fn list(dir: &BackupDir, memo_id: &str) -> io::Result<Vec<Version>> {
    let found: Vec<Version> = dir
        .snapshots()?
        .into_iter()
        .rev()
        .filter_map(|name| version_in(dir, name, memo_id))
        .collect();
    Ok(found
        .iter()
        .enumerate()
        .filter(|(i, version)| {
            found
                .get(i + 1)
                .is_none_or(|older| older.sha256 != version.sha256)
        })
        .map(|(_, version)| version.clone())
        .collect())
}

/// The memo's copy in snapshot `name`. A snapshot without it — taken before the memo existed, or
/// with the file left out — or with an unreadable index or manifest has none.
fn version_in(dir: &BackupDir, name: SnapshotName, memo_id: &str) -> Option<Version> {
    let tote = dir.path_of(name).join(TOTE_DIR);
    let index: SnapshotIndex = read_json(&tote.join(INDEX_FILE))?;
    let file = index.memos.get(memo_id)?.file.clone();
    let manifest: Manifest = read_json(&tote.join(MANIFEST_FILE))?;
    let record = manifest.files.get(&file)?;
    Some(Version {
        snapshot: name.format(),
        size: record.size,
        sha256: record.sha256.clone(),
        file,
    })
}

/// Not `persist::read_json`: that moves an unreadable file aside, and a backup is not changed by
/// looking at it.
fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// The bytes of `file` in snapshot `snapshot`. Both come from the frontend and must each be one
/// path segment, so the read stays inside the snapshot.
pub fn read(dir: &BackupDir, snapshot: &str, file: &str) -> io::Result<Vec<u8>> {
    for segment in [snapshot, file] {
        if !is_one_segment(segment) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("not a single path segment: {segment:?}"),
            ));
        }
    }
    fs::read(dir.root.join(snapshot).join(file))
}

fn is_one_segment(segment: &str) -> bool {
    !segment.contains('/')
        && matches!(
            Path::new(segment)
                .components()
                .collect::<Vec<_>>()
                .as_slice(),
            [Component::Normal(_)]
        )
}

/// Shows the workspace's backup folder in Finder (「백업 폴더 열기」), making it first when no
/// snapshot was taken yet.
pub fn reveal(dir: &BackupDir) -> io::Result<()> {
    fs::create_dir_all(&dir.root)?;
    open_in_finder(&dir.root)
}

#[cfg(target_os = "macos")]
fn open_in_finder(path: &Path) -> io::Result<()> {
    let status = std::process::Command::new("open").arg(path).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "open {}: {status}",
            path.display()
        )))
    }
}

#[cfg(not(target_os = "macos"))]
fn open_in_finder(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "지원하지 않음"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    use filetime::FileTime;

    use crate::backup::snapshot::take;
    use crate::backup::SnapshotName;
    use crate::persist::content_hash;
    use crate::workspace::Workspace;

    struct Setup {
        _tmp: tempfile::TempDir,
        ws: Workspace,
        dir: BackupDir,
    }

    fn setup() -> Setup {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::create(tmp.path(), "메모").unwrap();
        let dir = BackupDir::new(&tmp.path().join("backups"), ws.id());
        Setup { _tmp: tmp, ws, dir }
    }

    fn snap(s: &Setup, name: &str) {
        let taken = take(s.ws.root(), &s.dir, SnapshotName::parse(name).unwrap()).unwrap();
        assert!(taken.folder.is_some(), "{name}");
    }

    /// A write within the same millisecond as the last snapshot's read would keep size and mtime
    /// when the length does not change; a distinct mtime makes the snapshot hash it.
    fn touch(path: &Path, unix_secs: i64) {
        filetime::set_file_mtime(path, FileTime::from_unix_time(unix_secs, 0)).unwrap();
    }

    fn version(snapshot: &str, file: &str, text: &str) -> Version {
        Version {
            snapshot: snapshot.into(),
            file: file.into(),
            size: text.len() as u64,
            sha256: content_hash(text.as_bytes()),
        }
    }

    #[test]
    fn versions_follow_a_renamed_memo_and_skip_unchanged_neighbours() {
        let mut s = setup();
        let memo = s.ws.import_memo("a.md", "내용 1".as_bytes()).unwrap();
        snap(&s, "20261012-100000");
        s.ws.rename_memo(&memo.id, "회의.md").unwrap();
        snap(&s, "20261012-101000");
        s.ws.write_memo(&memo.id, "내용 2".as_bytes()).unwrap();
        touch(&s.ws.root().join("회의.md"), 2_000_000_000);
        snap(&s, "20261012-102000");
        // Another memo changing does not make this one's unchanged copies count.
        s.ws.import_memo("b.md", b"other").unwrap();
        snap(&s, "20261012-103000");

        assert_eq!(
            list(&s.dir, &memo.id).unwrap(),
            vec![
                version("20261012-102000", "회의.md", "내용 2"),
                version("20261012-100000", "a.md", "내용 1"),
            ]
        );
        assert_eq!(
            read(&s.dir, "20261012-100000", "a.md").unwrap(),
            "내용 1".as_bytes()
        );
        assert_eq!(list(&s.dir, "no-such-memo").unwrap(), vec![]);
    }

    #[test]
    fn the_newest_snapshot_is_listed_even_if_equal_to_the_workspace() {
        let mut s = setup();
        let memo = s.ws.import_memo("a.md", "하나".as_bytes()).unwrap();
        snap(&s, "20261012-100000");
        s.ws.write_memo(&memo.id, "둘째".as_bytes()).unwrap();
        touch(&s.ws.root().join("a.md"), 2_000_000_000);
        snap(&s, "20261012-101000");

        let listed = list(&s.dir, &memo.id).unwrap();
        assert_eq!(
            listed,
            vec![
                version("20261012-101000", "a.md", "둘째"),
                version("20261012-100000", "a.md", "하나"),
            ]
        );
        assert_eq!(
            listed[0].sha256,
            content_hash(&fs::read(s.ws.root().join("a.md")).unwrap())
        );
    }

    #[test]
    fn read_refuses_a_path_segment_that_leaves_the_snapshot() {
        let mut s = setup();
        s.ws.import_memo("a.md", b"x").unwrap();
        snap(&s, "20261012-100000");
        fs::write(s.dir.root.join("x"), "outside").unwrap();
        for (snapshot, file) in [
            ("../x", "a.md"),
            ("20261012-100000", "../x"),
            ("20261012-100000", "/etc/hosts"),
            ("20261012-100000", ".tote/index.json"),
            ("..", "x"),
            (".", "x"),
            ("", "x"),
            ("20261012-100000", ""),
        ] {
            let err = read(&s.dir, snapshot, file).unwrap_err();
            assert_eq!(
                err.kind(),
                io::ErrorKind::InvalidInput,
                "{snapshot:?} {file:?}"
            );
        }
    }
}
