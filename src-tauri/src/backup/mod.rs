//! Workspace snapshots under `backups/<workspace id>/<YYYYMMDD-HHMMSS>/` (spec 「백업」): plain
//! folders Finder can open, hard-linked to the previous snapshot where nothing changed, and pruned
//! to every snapshot of the last day plus one a day for a month.

pub mod retention;
pub mod snapshot;
pub mod versions;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use time::format_description::FormatItem;
use time::macros::format_description;
use time::{Date, OffsetDateTime, PrimitiveDateTime, UtcOffset};

/// Snapshots are taken this often, and only when something changed.
pub const INTERVAL: Duration = Duration::from_secs(600);
/// Every snapshot this young is kept.
pub const KEEP_ALL_FOR: Duration = Duration::from_secs(24 * 60 * 60);
/// Older ones keep the last of each day until they are this old.
pub const KEEP_DAILY_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Larger files stay out of snapshots: the editor does not open them, so 「이전 버전」 has no use
/// for them, and copying them every ten minutes eats the disk.
pub const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

const TMP_PREFIX: &str = ".tmp-";
const NAME_FORMAT: &[FormatItem<'static>] =
    format_description!("[year][month][day]-[hour][minute][second]");

/// The snapshots of one workspace: `backups/<workspace id>/`.
pub struct BackupDir {
    root: PathBuf,
}

impl BackupDir {
    pub fn new(backups_dir: &Path, workspace_id: &str) -> BackupDir {
        BackupDir {
            root: backups_dir.join(workspace_id),
        }
    }

    pub fn path_of(&self, name: SnapshotName) -> PathBuf {
        self.root.join(name.format())
    }

    /// Finished snapshots, oldest first. A half-made `.tmp-*` folder, or anything else that is not
    /// named like a snapshot, is not one. No folder yet means no snapshots.
    pub fn snapshots(&self) -> io::Result<Vec<SnapshotName>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err),
        };
        let mut names = Vec::new();
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str().and_then(SnapshotName::parse) {
                names.push(name);
            }
        }
        names.sort();
        Ok(names)
    }

    /// Removes the `.tmp-*` folders of snapshots the app died while taking.
    pub fn remove_leftovers(&self) -> io::Result<()> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err),
        };
        for entry in entries {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with(TMP_PREFIX) {
                fs::remove_dir_all(entry.path())?;
            }
        }
        Ok(())
    }

    fn tmp_path_of(&self, name: SnapshotName) -> PathBuf {
        self.root.join(format!("{TMP_PREFIX}{}", name.format()))
    }
}

/// When a snapshot was taken, to the second, as the device's wall clock read then — the folder
/// name a person sees in Finder, and the local date that retention counts days by.
///
/// The name carries no UTC offset, so the time is held as if it were UTC: a parsed name and `now`
/// then compare on the same footing. Across a daylight-saving change an age is off by an hour,
/// which the 24-hour and 30-day windows absorb.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SnapshotName(OffsetDateTime);

impl SnapshotName {
    pub fn now() -> SnapshotName {
        let local = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
        let wall = PrimitiveDateTime::new(local.date(), local.time());
        let wall = wall.replace_nanosecond(0).unwrap_or(wall);
        SnapshotName(wall.assume_offset(UtcOffset::UTC))
    }

    /// `YYYYMMDD-HHMMSS`.
    pub fn format(&self) -> String {
        self.0
            .format(NAME_FORMAT)
            .expect("a four-digit year always formats")
    }

    pub fn parse(name: &str) -> Option<SnapshotName> {
        let wall = PrimitiveDateTime::parse(name, NAME_FORMAT).ok()?;
        Some(SnapshotName(wall.assume_utc()))
    }

    /// The local date it was taken on.
    pub fn day(&self) -> Date {
        self.0.date()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_names_round_trip_and_sort() {
        let name = SnapshotName::parse("20261012-153000").unwrap();
        assert_eq!(name.format(), "20261012-153000");
        assert_eq!(name.day(), time::macros::date!(2026 - 10 - 12));
        let later = SnapshotName::parse("20261013-000000").unwrap();
        assert!(name < later);
        let mut names = vec![later, name];
        names.sort();
        assert_eq!(names, vec![name, later]);
        for bad in [
            "20261012-1530",
            "20261012-153000x",
            ".tmp-20261012-153000",
            "2026101x-153000",
            "20261312-153000",
            "",
        ] {
            assert_eq!(SnapshotName::parse(bad), None, "{bad:?}");
        }
        let now = SnapshotName::now();
        assert_eq!(SnapshotName::parse(&now.format()), Some(now));
    }
}
