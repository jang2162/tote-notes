//! Taking one snapshot of a workspace.

use std::collections::BTreeMap;
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::{BackupDir, SnapshotName, MAX_FILE_BYTES};
use crate::persist::{content_hash, is_binary, read_json, write_json, BINARY_PROBE_BYTES};
use crate::workspace::index::memo_files;
use crate::workspace::TOTE_DIR;

/// `.tote/manifest.json` inside a snapshot: what each copy holds, so the next snapshot can tell
/// what is unchanged without reading it, and 「이전 버전」 can tell adjacent snapshots apart.
const MANIFEST_FILE: &str = "manifest.json";
const INDEX_FILE: &str = "index.json";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub files: BTreeMap<String, FileRecord>,
    #[serde(default)]
    pub skipped: Vec<Skipped>,
}

/// A copied file as it was in the workspace when the snapshot read it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRecord {
    pub size: u64,
    pub mtime_ms: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Skipped {
    pub file: String,
    pub reason: SkipReason,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    Binary,
    TooLarge,
    /// It changed or went away while the snapshot was reading it; the next snapshot takes it.
    Changed,
}

/// Snapshots the workspace at `workspace_root` into `dir` under the name `now`, returning the new
/// folder, or `None` when there was no file to keep.
pub fn take(
    workspace_root: &Path,
    dir: &BackupDir,
    now: SnapshotName,
) -> io::Result<Option<PathBuf>> {
    take_with(workspace_root, dir, now, |path| fs::read(path))
}

/// `take`, reading workspace files through `read` — the seam tests use to make a file vanish
/// mid-snapshot.
///
/// Built in `.tmp-<name>` and renamed into place, so a crash never leaves a half snapshot that
/// looks finished. A name already taken — the same second twice, or the hour a daylight-saving
/// change repeats — fails with `AlreadyExists` and the next round takes it under a new name.
pub fn take_with(
    workspace_root: &Path,
    dir: &BackupDir,
    now: SnapshotName,
    read: impl Fn(&Path) -> io::Result<Vec<u8>>,
) -> io::Result<Option<PathBuf>> {
    let target = dir.path_of(now);
    if target.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("snapshot {} already exists", now.format()),
        ));
    }
    let previous = dir
        .snapshots()?
        .into_iter()
        .rfind(|&name| name < now)
        .map(|name| dir.path_of(name))
        .and_then(|path| {
            // An unreadable manifest only costs a full copy.
            let manifest = read_json::<Manifest>(&path.join(TOTE_DIR).join(MANIFEST_FILE))
                .ok()
                .flatten()?;
            Some((path, manifest))
        });

    let tmp = dir.tmp_path_of(now);
    match fs::remove_dir_all(&tmp) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
        _ => {}
    }
    let result = fill(workspace_root, &tmp, previous.as_ref(), &read).and_then(|kept| {
        if !kept {
            return Ok(None);
        }
        fs::rename(&tmp, &target)?;
        Ok(Some(target))
    });
    if !matches!(result, Ok(Some(_))) {
        let _ = fs::remove_dir_all(&tmp);
    }
    result
}

/// Copies or links every memo file into `into`, then the index and the manifest. Returns whether
/// any memo file went in.
fn fill(
    workspace_root: &Path,
    into: &Path,
    previous: Option<&(PathBuf, Manifest)>,
    read: &impl Fn(&Path) -> io::Result<Vec<u8>>,
) -> io::Result<bool> {
    fs::create_dir_all(into.join(TOTE_DIR))?;
    let mut manifest = Manifest {
        version: 1,
        files: BTreeMap::new(),
        skipped: Vec::new(),
    };
    for file in memo_files(workspace_root)? {
        let earlier = previous.and_then(|(path, manifest)| {
            let record = manifest.files.get(&file)?;
            Some((path.join(&file), record))
        });
        match keep_file(
            &workspace_root.join(&file),
            &into.join(&file),
            earlier,
            read,
        ) {
            Ok(record) => {
                manifest.files.insert(file, record);
            }
            Err(reason) => manifest.skipped.push(Skipped { file, reason }),
        }
    }
    if manifest.files.is_empty() {
        return Ok(false);
    }
    let index = workspace_root.join(TOTE_DIR).join(INDEX_FILE);
    match fs::copy(&index, into.join(TOTE_DIR).join(INDEX_FILE)) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
        _ => {}
    }
    write_json(&into.join(TOTE_DIR).join(MANIFEST_FILE), &manifest)?;
    Ok(true)
}

/// Puts one workspace file at `copy`: a hard link to the previous snapshot's copy when the
/// contents are the same, else a copy of the workspace file. Never a link to the workspace file
/// itself — another app editing it in place would change the backup with it.
fn keep_file(
    source: &Path,
    copy: &Path,
    earlier: Option<(PathBuf, &FileRecord)>,
    read: &impl Fn(&Path) -> io::Result<Vec<u8>>,
) -> Result<FileRecord, SkipReason> {
    let before = fs::metadata(source).map_err(|_| SkipReason::Changed)?;
    if before.len() > MAX_FILE_BYTES {
        return Err(SkipReason::TooLarge);
    }
    let mtime_ms = mtime_ms(&before);
    // Same size and mtime is taken as same contents without reading the file. A tool that changes
    // the contents but keeps both fools this — the accepted cost of not hashing every file every
    // ten minutes.
    if let Some((earlier_copy, record)) = &earlier {
        if record.size == before.len()
            && record.mtime_ms == mtime_ms
            && link_or_copy(earlier_copy, copy).is_ok()
        {
            return Ok((*record).clone());
        }
    }
    // Only the head first: a large media file is known to be binary without reading all of it.
    if starts_binary(source).map_err(|_| SkipReason::Changed)? {
        return Err(SkipReason::Binary);
    }
    let bytes = read(source).map_err(|_| SkipReason::Changed)?;
    if is_binary(&bytes) {
        return Err(SkipReason::Binary);
    }
    let record = FileRecord {
        size: before.len(),
        mtime_ms,
        sha256: content_hash(&bytes),
    };
    if let Some((earlier_copy, earlier_record)) = &earlier {
        if earlier_record.sha256 == record.sha256 && link_or_copy(earlier_copy, copy).is_ok() {
            return Ok(record);
        }
    }
    // `fs::copy` clones on APFS. It reads the file again, so the copy is only kept when the file
    // is still the one that was hashed: a save in between (a new inode) or an in-place edit would
    // leave a copy the manifest's hash does not describe.
    fs::copy(source, copy).map_err(|_| SkipReason::Changed)?;
    match fs::metadata(source) {
        Ok(after) if same_file_state(&before, &after) => Ok(record),
        _ => {
            let _ = fs::remove_file(copy);
            Err(SkipReason::Changed)
        }
    }
}

/// A hard link to an earlier snapshot's copy, or a copy of that copy where links fail (another
/// volume). Either way the workspace is not touched.
fn link_or_copy(earlier_copy: &Path, copy: &Path) -> io::Result<()> {
    let result =
        fs::hard_link(earlier_copy, copy).or_else(|_| fs::copy(earlier_copy, copy).map(drop));
    if result.is_err() {
        let _ = fs::remove_file(copy);
    }
    result
}

fn starts_binary(path: &Path) -> io::Result<bool> {
    let mut head = Vec::with_capacity(BINARY_PROBE_BYTES);
    File::open(path)?
        .take(BINARY_PROBE_BYTES as u64)
        .read_to_end(&mut head)?;
    Ok(is_binary(&head))
}

fn mtime_ms(meta: &Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_millis() as u64)
}

fn same_file_state(before: &Metadata, after: &Metadata) -> bool {
    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.modified().ok() == after.modified().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::MetadataExt;

    use filetime::FileTime;

    use crate::backup::MAX_FILE_BYTES;
    use crate::persist::atomic_write;

    struct Setup {
        _tmp: tempfile::TempDir,
        workspace: PathBuf,
        dir: BackupDir,
    }

    fn setup() -> Setup {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("메모");
        fs::create_dir_all(workspace.join(TOTE_DIR)).unwrap();
        fs::write(
            workspace.join(TOTE_DIR).join("index.json"),
            "{\"version\":1,\"memos\":{}}\n",
        )
        .unwrap();
        let dir = BackupDir::new(&tmp.path().join("backups"), "ws-1");
        Setup {
            _tmp: tmp,
            workspace,
            dir,
        }
    }

    fn at(name: &str) -> SnapshotName {
        SnapshotName::parse(name).unwrap()
    }

    fn manifest(snapshot: &Path) -> Manifest {
        read_json(&snapshot.join(TOTE_DIR).join(MANIFEST_FILE))
            .unwrap()
            .unwrap()
    }

    fn inode(path: &Path) -> (u64, u64) {
        let meta = fs::metadata(path).unwrap();
        (meta.dev(), meta.ino())
    }

    /// Every file below `dir`, as relative paths.
    fn listing(dir: &Path) -> Vec<String> {
        fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(base, &path, out);
                } else {
                    let rel = path.strip_prefix(base).unwrap();
                    out.push(rel.to_string_lossy().into_owned());
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn a_snapshot_is_a_plain_folder_with_the_text_files_and_the_index() {
        let s = setup();
        fs::write(s.workspace.join("a.md"), "# 메모\n").unwrap();
        fs::write(s.workspace.join("b.sh"), "echo hi\n").unwrap();
        fs::write(
            s.workspace.join("pic.png"),
            b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR",
        )
        .unwrap();
        fs::create_dir_all(s.workspace.join(TOTE_DIR).join("sessions")).unwrap();
        fs::write(s.workspace.join(TOTE_DIR).join("sessions/d.json"), "{}").unwrap();

        let name = at("20261012-153000");
        let snapshot = take(&s.workspace, &s.dir, name).unwrap().unwrap();
        assert_eq!(snapshot, s.dir.path_of(name));
        assert_eq!(
            listing(&snapshot),
            [".tote/index.json", ".tote/manifest.json", "a.md", "b.sh"]
        );
        assert_eq!(read(&snapshot.join("a.md")), "# 메모\n");
        assert_eq!(
            read(&snapshot.join(".tote/index.json")),
            "{\"version\":1,\"memos\":{}}\n"
        );
        let m = manifest(&snapshot);
        assert_eq!(m.version, 1);
        assert_eq!(m.files.keys().collect::<Vec<_>>(), ["a.md", "b.sh"]);
        assert_eq!(m.files["a.md"].sha256, content_hash("# 메모\n".as_bytes()));
        assert_eq!(m.files["a.md"].size, "# 메모\n".len() as u64);
        assert_eq!(
            m.skipped,
            vec![Skipped {
                file: "pic.png".into(),
                reason: SkipReason::Binary
            }]
        );
        let text = read(&snapshot.join(".tote/manifest.json"));
        assert!(text.contains("\"mtimeMs\""), "{text}");
        assert!(text.contains("\"reason\": \"binary\""), "{text}");
        assert_eq!(s.dir.snapshots().unwrap(), vec![name]);
    }

    #[test]
    fn unchanged_files_are_hard_linked_to_the_previous_copy_never_to_the_workspace() {
        let s = setup();
        let a = s.workspace.join("a.md");
        let b = s.workspace.join("b.sh");
        fs::write(&a, "그대로\n").unwrap();
        fs::write(&b, "echo 1\n").unwrap();
        let first = take(&s.workspace, &s.dir, at("20261012-150000"))
            .unwrap()
            .unwrap();
        fs::write(&b, "echo changed\n").unwrap();
        let second = take(&s.workspace, &s.dir, at("20261012-151000"))
            .unwrap()
            .unwrap();

        assert_eq!(inode(&first.join("a.md")), inode(&second.join("a.md")));
        assert_ne!(inode(&first.join("a.md")), inode(&a));
        assert_ne!(inode(&second.join("a.md")), inode(&a));
        assert_ne!(inode(&first.join("b.sh")), inode(&second.join("b.sh")));
        assert_ne!(inode(&second.join("b.sh")), inode(&b));
        assert_eq!(read(&first.join("b.sh")), "echo 1\n");
        assert_eq!(read(&second.join("b.sh")), "echo changed\n");

        // Saved again with the same text: a new file and a new mtime, but the same contents, so
        // the hash still finds the previous copy.
        atomic_write(&a, "그대로\n".as_bytes()).unwrap();
        filetime::set_file_mtime(&a, FileTime::from_unix_time(2_000_000_000, 0)).unwrap();
        let third = take(&s.workspace, &s.dir, at("20261012-152000"))
            .unwrap()
            .unwrap();
        assert_eq!(inode(&second.join("a.md")), inode(&third.join("a.md")));
        assert_eq!(manifest(&third).files["a.md"].mtime_ms, 2_000_000_000_000);
    }

    #[test]
    fn a_file_edited_in_place_by_another_app_does_not_change_an_older_snapshot() {
        let s = setup();
        let a = s.workspace.join("a.md");
        fs::write(&a, "before\n").unwrap();
        let first = take(&s.workspace, &s.dir, at("20261012-150000"))
            .unwrap()
            .unwrap();
        OpenOptions::new()
            .append(true)
            .open(&a)
            .unwrap()
            .write_all(b"after\n")
            .unwrap();
        assert_eq!(read(&first.join("a.md")), "before\n");

        let second = take(&s.workspace, &s.dir, at("20261012-151000"))
            .unwrap()
            .unwrap();
        assert_eq!(read(&first.join("a.md")), "before\n");
        assert_eq!(read(&second.join("a.md")), "before\nafter\n");
    }

    #[test]
    fn size_and_mtime_short_circuit_the_hash() {
        let s = setup();
        let a = s.workspace.join("a.md");
        fs::write(&a, "aaaa\n").unwrap();
        let first = take(&s.workspace, &s.dir, at("20261012-150000"))
            .unwrap()
            .unwrap();
        let mtime = FileTime::from_last_modification_time(&fs::metadata(&a).unwrap());
        fs::write(&a, "bbbb\n").unwrap();
        filetime::set_file_mtime(&a, mtime).unwrap();

        // A tool that keeps the mtime while changing the contents fools the next snapshot into
        // keeping the old copy — the accepted cost `keep_file` explains.
        let second = take(&s.workspace, &s.dir, at("20261012-151000"))
            .unwrap()
            .unwrap();
        assert_eq!(read(&second.join("a.md")), "aaaa\n");
        assert_eq!(inode(&first.join("a.md")), inode(&second.join("a.md")));
        assert_eq!(
            manifest(&second).files["a.md"].sha256,
            content_hash(b"aaaa\n")
        );
    }

    #[test]
    fn a_file_replaced_mid_snapshot_is_skipped_not_fatal() {
        let s = setup();
        fs::write(s.workspace.join("a.md"), "a\n").unwrap();
        fs::write(s.workspace.join("b.md"), "b\n").unwrap();
        let gone = |path: &Path| {
            if path.ends_with("b.md") {
                Err(io::Error::from(io::ErrorKind::NotFound))
            } else {
                fs::read(path)
            }
        };
        let first = take_with(&s.workspace, &s.dir, at("20261012-150000"), gone)
            .unwrap()
            .unwrap();
        assert_eq!(read(&first.join("a.md")), "a\n");
        assert!(!first.join("b.md").exists());
        let m = manifest(&first);
        assert_eq!(m.files.keys().collect::<Vec<_>>(), ["a.md"]);
        assert_eq!(
            m.skipped,
            vec![Skipped {
                file: "b.md".into(),
                reason: SkipReason::Changed
            }]
        );

        // The next snapshot picks it up.
        let second = take(&s.workspace, &s.dir, at("20261012-151000"))
            .unwrap()
            .unwrap();
        assert_eq!(read(&second.join("b.md")), "b\n");
        assert!(manifest(&second).skipped.is_empty());
    }

    #[test]
    fn a_file_saved_between_reading_and_copying_is_skipped() {
        let s = setup();
        let a = s.workspace.join("a.md");
        fs::write(&a, "old\n").unwrap();
        fs::write(s.workspace.join("b.md"), "b\n").unwrap();
        // tote saves `a.md` right after the snapshot has read it: the copy would hold text the
        // manifest's hash does not describe.
        let save_after_read = |path: &Path| {
            let bytes = fs::read(path)?;
            if path.ends_with("a.md") {
                atomic_write(path, b"new!\n")?;
            }
            Ok(bytes)
        };
        let snapshot = take_with(&s.workspace, &s.dir, at("20261012-150000"), save_after_read)
            .unwrap()
            .unwrap();
        assert!(!snapshot.join("a.md").exists());
        assert_eq!(
            manifest(&snapshot).skipped,
            vec![Skipped {
                file: "a.md".into(),
                reason: SkipReason::Changed
            }]
        );
    }

    #[test]
    fn files_over_the_limit_are_skipped() {
        let s = setup();
        fs::write(s.workspace.join("a.md"), "a\n").unwrap();
        // Sparse: no 100MB is written.
        File::create(s.workspace.join("big.log"))
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        let snapshot = take(&s.workspace, &s.dir, at("20261012-150000"))
            .unwrap()
            .unwrap();
        assert!(!snapshot.join("big.log").exists());
        assert_eq!(
            manifest(&snapshot).skipped,
            vec![Skipped {
                file: "big.log".into(),
                reason: SkipReason::TooLarge
            }]
        );
    }

    #[test]
    fn a_crash_mid_snapshot_leaves_only_a_tmp_folder_that_the_next_start_removes() {
        let s = setup();
        fs::write(s.workspace.join("a.md"), "a\n").unwrap();
        let kept = take(&s.workspace, &s.dir, at("20261012-001000"))
            .unwrap()
            .unwrap();
        let leftover = s.dir.root.join(".tmp-20261012-000000");
        fs::create_dir_all(leftover.join(TOTE_DIR)).unwrap();
        fs::write(leftover.join("a.md"), "half").unwrap();

        assert_eq!(s.dir.snapshots().unwrap(), vec![at("20261012-001000")]);
        s.dir.remove_leftovers().unwrap();
        assert!(!leftover.exists());
        assert!(kept.join("a.md").is_file());
        assert_eq!(s.dir.snapshots().unwrap(), vec![at("20261012-001000")]);
    }

    #[test]
    fn an_empty_workspace_takes_no_snapshot() {
        let s = setup();
        fs::create_dir_all(s.workspace.join(TOTE_DIR).join("sessions")).unwrap();
        fs::write(s.workspace.join(TOTE_DIR).join("sessions/d.json"), "{}").unwrap();
        assert_eq!(
            take(&s.workspace, &s.dir, at("20261012-150000")).unwrap(),
            None
        );
        assert!(s.dir.snapshots().unwrap().is_empty());
        let left = fs::read_dir(&s.dir.root).map_or(0, |entries| entries.count());
        assert_eq!(left, 0);
    }

    #[test]
    fn a_name_already_taken_fails_and_keeps_the_first() {
        let s = setup();
        fs::write(s.workspace.join("a.md"), "first\n").unwrap();
        let name = at("20261012-150000");
        let first = take(&s.workspace, &s.dir, name).unwrap().unwrap();
        fs::write(s.workspace.join("a.md"), "second, longer\n").unwrap();
        let err = take(&s.workspace, &s.dir, name).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(read(&first.join("a.md")), "first\n");
        assert_eq!(s.dir.snapshots().unwrap(), vec![name]);
        assert!(!s.dir.root.join(".tmp-20261012-150000").exists());
    }
}
