//! Which snapshots to keep (spec 「백업」 보존).

use std::collections::BTreeMap;
use std::fs;
use std::io;

use super::{BackupDir, SnapshotName, KEEP_ALL_FOR, KEEP_DAILY_FOR};

/// The snapshots to delete at `now`: everything from the last 24 hours stays; older ones keep only
/// the last of their local day, and nothing older than 30 days stays. A day's last snapshot is
/// the last of all its snapshots, so a day still partly inside the 24 hours is already down to the
/// one it will keep.
pub fn to_remove(snapshots: &[SnapshotName], now: SnapshotName) -> Vec<SnapshotName> {
    let mut last_of_day = BTreeMap::new();
    for &name in snapshots {
        let last = last_of_day.entry(name.day()).or_insert(name);
        *last = (*last).max(name);
    }
    let mut remove: Vec<SnapshotName> = snapshots
        .iter()
        .copied()
        .filter(|&name| {
            let age = now.0 - name.0;
            if age <= KEEP_ALL_FOR {
                return false;
            }
            age > KEEP_DAILY_FOR || last_of_day[&name.day()] != name
        })
        .collect();
    remove.sort();
    remove
}

/// Deletes what `to_remove` names and returns how many went. Runs after every snapshot.
pub fn prune(dir: &BackupDir, now: SnapshotName) -> io::Result<usize> {
    let remove = to_remove(&dir.snapshots()?, now);
    for &name in &remove {
        fs::remove_dir_all(dir.path_of(name))?;
    }
    Ok(remove.len())
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
            "20261012-110000",
        ]);
        assert_eq!(
            to_remove(&snapshots, at("20261012-120000")),
            names(&["20261009-080000", "20261010-090000", "20261010-120000"])
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
}
