//! Which snapshots to keep (spec 「백업」 보존).

use std::collections::BTreeMap;
use std::fs;
use std::io;

use super::{BackupDir, SnapshotName, KEEP_ALL_FOR, KEEP_DAILY_FOR};

/// The snapshots to delete at `now`: everything from the last 24 hours stays; of the older ones
/// only the last of each local day stays, and none older than 30 days. A day astride the 24 hours
/// keeps its last older snapshot until a later one of that day turns 24 hours old.
pub fn to_remove(snapshots: &[SnapshotName], now: SnapshotName) -> Vec<SnapshotName> {
    let older: Vec<SnapshotName> = snapshots
        .iter()
        .copied()
        .filter(|&name| now.0 - name.0 > KEEP_ALL_FOR)
        .collect();
    let mut last_of_day = BTreeMap::new();
    for &name in &older {
        let last = last_of_day.entry(name.day()).or_insert(name);
        *last = (*last).max(name);
    }
    let mut remove: Vec<SnapshotName> = older
        .into_iter()
        .filter(|&name| now.0 - name.0 > KEEP_DAILY_FOR || last_of_day[&name.day()] != name)
        .collect();
    remove.sort();
    remove
}

/// Deletes what `to_remove` names and returns how many went. Runs after every snapshot. A folder
/// that will not go (Finder holding it, changed permissions) does not stop the rest; the first
/// such error comes back after them, and the next round tries again.
pub fn prune(dir: &BackupDir, now: SnapshotName) -> io::Result<usize> {
    let mut removed = 0;
    let mut first_error = None;
    for name in to_remove(&dir.snapshots()?, now) {
        match fs::remove_dir_all(dir.path_of(name)) {
            Ok(()) => removed += 1,
            Err(err) => {
                first_error.get_or_insert(err);
            }
        }
    }
    match first_error {
        Some(err) => Err(err),
        None => Ok(removed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn at(name: &str) -> SnapshotName {
        SnapshotName::parse(name).unwrap()
    }

    fn names(list: &[&str]) -> Vec<SnapshotName> {
        list.iter().map(|n| at(n)).collect()
    }

    #[test]
    fn keeps_everything_from_the_last_24_hours() {
        let snapshots = names(&[
            "20261011-120000",
            "20261011-130000",
            "20261011-131000",
            "20261011-235000",
            "20261012-000000",
            "20261012-115000",
        ]);
        assert_eq!(to_remove(&snapshots, at("20261012-120000")), vec![]);
    }

    #[test]
    fn keeps_only_the_last_snapshot_of_each_older_day() {
        let snapshots = names(&[
            "20261009-080000",
            "20261009-200000",
            "20261010-090000",
            "20261010-120000",
            "20261010-230000",
            // A day astride the 24 hours: 10:00 is the last of that day's older ones until 13:00
            // turns 24 hours old too.
            "20261011-100000",
            "20261011-130000",
            "20261012-110000",
        ]);
        assert_eq!(
            to_remove(&snapshots, at("20261012-120000")),
            names(&["20261009-080000", "20261010-090000", "20261010-120000"])
        );
        assert_eq!(
            to_remove(&snapshots, at("20261012-130001")),
            names(&[
                "20261009-080000",
                "20261010-090000",
                "20261010-120000",
                "20261011-100000"
            ])
        );
    }

    #[test]
    fn drops_everything_older_than_30_days() {
        // Each is the last of its day, so only age decides; 30 days before now is 20260912-000000.
        let snapshots = names(&[
            "20260810-120000",
            "20260911-235959",
            "20260912-000001",
            "20260913-090000",
        ]);
        assert_eq!(
            to_remove(&snapshots, at("20261012-000000")),
            names(&["20260810-120000", "20260911-235959"])
        );
    }

    #[test]
    fn a_day_boundary_is_the_local_date() {
        let before = at("20261010-235930");
        let after = at("20261011-000030");
        assert_ne!(before.day(), after.day());
        // A minute apart, but on two dates: each is the last of its own day.
        assert_eq!(to_remove(&[before, after], at("20261013-120000")), vec![]);
    }

    #[test]
    fn prune_removes_the_folders_it_names() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = BackupDir::new(tmp.path(), "ws-1");
        for name in ["20260901-120000", "20261011-130000", "20261012-110000"] {
            fs::create_dir_all(dir.path_of(at(name)).join(".tote")).unwrap();
        }
        assert_eq!(prune(&dir, at("20261012-120000")).unwrap(), 1);
        assert_eq!(
            dir.snapshots().unwrap(),
            names(&["20261011-130000", "20261012-110000"])
        );
        assert!(!dir.path_of(at("20260901-120000")).exists());
    }

    #[test]
    fn prune_keeps_going_past_a_folder_it_cannot_remove() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let dir = BackupDir::new(tmp.path(), "ws-1");
        for name in ["20260901-120000", "20260902-120000"] {
            fs::create_dir_all(dir.path_of(at(name)).join(".tote")).unwrap();
            fs::write(dir.path_of(at(name)).join(".tote/manifest.json"), "{}").unwrap();
        }
        // The oldest cannot go: its `.tote` lets nothing inside be removed.
        let stuck = dir.path_of(at("20260901-120000")).join(".tote");
        fs::set_permissions(&stuck, fs::Permissions::from_mode(0o555)).unwrap();

        let result = prune(&dir, at("20261012-120000"));
        fs::set_permissions(&stuck, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert!(!dir.path_of(at("20260902-120000")).exists());
        assert!(dir.path_of(at("20260901-120000")).exists());
    }
}
