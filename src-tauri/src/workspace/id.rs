//! What counts as a workspace or memo ID. tote names folders and files after them
//! (`backups/<workspace id>/`, `viewed/<workspace id>.json`, `.trash/<memo id>/`), and they are
//! read from files anyone can edit (`workspace.json`, `index.json`). So an ID is checked twice:
//! where it is read, anything that is not a UUID is replaced by a new one (`is_id`); where it
//! becomes part of a path, anything that is not one plain segment makes no path
//! (`is_safe_segment`). The second holds even if a reader forgets the first.

/// An ID as tote makes them: a hyphenated UUID, as `Uuid::to_string` writes it. Either case, so a
/// workspace made by hand with `uuidgen` keeps its ID.
pub fn is_id(id: &str) -> bool {
    id.len() == uuid::fmt::Hyphenated::LENGTH && uuid::Uuid::try_parse(id).is_ok()
}

/// A name that stays where it is joined: one segment, and not a dot name — `..` climbs out, and
/// the listings skip dot folders, so a memo trashed into one would be lost from sight.
pub fn is_safe_segment(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', '\0'])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::backup::snapshot::take;
    use crate::backup::{BackupDir, SnapshotName};
    use crate::workspace::viewed::ViewedTimes;
    use crate::workspace::{Workspace, TOTE_DIR, TRASH_DIR};

    /// IDs a tampered or broken file could hold. `{OUT}` stands for a folder outside the
    /// workspace and the app data folder, by its absolute path. `Scene` is nested deeper than
    /// the longest climb here, so that even unchecked they stay in the temporary folder.
    const BAD_IDS: &[&str] = &[
        "../outside/package",
        "../../outside/package",
        "../../../outside/package",
        "../../../../outside/package",
        "../../../../../outside/package",
        "{OUT}/package",
        "",
        ".",
        "..",
        "a/b",
        "/",
        "not-a-uuid",
        "0f8fad5bd9cb469fa16570867728950e",
        "{0f8fad5b-d9cb-469f-a165-70867728950e}",
        "0f8fad5b-d9cb-469f-a165-70867728950e/..",
    ];

    #[test]
    fn only_hyphenated_uuids_are_ids() {
        assert!(is_id(&uuid::Uuid::new_v4().to_string()));
        assert!(is_id("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(is_id("0F8FAD5B-D9CB-469F-A165-70867728950E"), "uuidgen's");
        for bad in BAD_IDS {
            assert!(!is_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_safe_segment_is_one_plain_name() {
        for good in ["0f8fad5b-d9cb-469f-a165-70867728950e", "ws-1", "메모"] {
            assert!(is_safe_segment(good), "{good:?}");
        }
        for bad in [
            "", ".", "..", ".hidden", "a/b", "/abs", "a\\b", "../x", "a/..", "a\0b",
        ] {
            assert!(!is_safe_segment(bad), "{bad:?}");
        }
    }

    /// Where `Scene` keeps the workspace root (`root`, the workspace is `root/w`) and the app
    /// data folder (`data`), below the temporary folder.
    const BASE: &str = "a/b/c/d";

    /// A workspace and an app data folder with, next to every folder on the way down to them,
    /// an `outside` holding what a bad ID could reach.
    struct Scene {
        tmp: tempfile::TempDir,
    }

    impl Scene {
        fn new() -> Scene {
            let tmp = tempfile::tempdir().unwrap();
            let scene = Scene { tmp };
            Workspace::create(&scene.base().join("root"), "w").unwrap();
            fs::write(scene.folder().join("메모.md"), "글").unwrap();
            fs::create_dir_all(scene.data()).unwrap();
            let folder = scene.folder();
            let mut levels: Vec<&Path> = folder
                .ancestors()
                .take_while(|level| level.starts_with(scene.tmp.path()))
                .collect();
            let data = scene.data();
            levels.push(&data);
            for level in levels {
                let outside = level.join("outside");
                // Named like the leftovers and the snapshots the backups remove.
                fs::create_dir_all(outside.join("package/.tmp-20261012-150000")).unwrap();
                fs::create_dir_all(outside.join("package/20261012-150000")).unwrap();
                // A JSON object, which the viewed times would read and write over; and not one,
                // which they would set aside.
                fs::write(outside.join("package.json"), r#"{"name":"mine"}"#).unwrap();
                fs::write(outside.join("conf.d.json"), "not json").unwrap();
            }
            scene
        }

        fn base(&self) -> PathBuf {
            self.tmp.path().join(BASE)
        }

        fn folder(&self) -> PathBuf {
            self.base().join("root/w")
        }

        fn data(&self) -> PathBuf {
            self.base().join("data")
        }

        fn bad_id(&self, id: &str) -> String {
            id.replace("{OUT}", &self.tmp.path().join("outside").to_string_lossy())
        }

        /// Whether `path` is where tote keeps the workspace's own state: its memos, `.tote` and
        /// `.trash`, and in the app data folder what is named by an ID.
        fn own(&self, path: &Path) -> bool {
            if let Ok(inside) = path.strip_prefix(self.folder()) {
                // The folder itself is walked into, for the `outside` in it.
                return inside.iter().next().is_some_and(|name| name != "outside");
            }
            ["viewed", "backups"].iter().any(|kind| {
                let Ok(inside) = path.strip_prefix(self.data().join(kind)) else {
                    return false;
                };
                let name = inside.iter().next().and_then(|name| name.to_str());
                name.is_none_or(|name| is_id(name.trim_end_matches(".json")))
            })
        }

        /// Every file in the temporary folder with its bytes, and every folder, but tote's `own`:
        /// what must not change.
        fn outside(&self) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
            let mut found = BTreeMap::new();
            let mut left = vec![self.tmp.path().to_path_buf()];
            while let Some(folder) = left.pop() {
                for entry in fs::read_dir(&folder).unwrap() {
                    let path = entry.unwrap().path();
                    if self.own(&path) {
                        continue;
                    }
                    if path.is_dir() {
                        found.insert(path.clone(), None);
                        left.push(path);
                    } else {
                        found.insert(path.clone(), Some(fs::read(&path).unwrap()));
                    }
                }
            }
            found
        }

        fn set_workspace_id(&self, id: &str) {
            let file = self.folder().join(TOTE_DIR).join("workspace.json");
            fs::write(
                file,
                serde_json::json!({"version": 1, "id": id}).to_string(),
            )
            .unwrap();
        }

        /// What the app does with a workspace it opened: its viewed times are attached and
        /// written, a snapshot is taken, and a memo goes to the trash.
        fn use_workspace(&self) -> Workspace {
            let mut ws = Workspace::open(&self.folder()).unwrap();
            let data = self.data();
            if let Some(file) = ViewedTimes::file_for(&data, ws.id()) {
                ws.attach_viewed(ViewedTimes::load(file));
            }
            let memo = ws.list_memos().unwrap().remove(0);
            ws.memo_viewed(&memo.id, 7).unwrap();
            ws.save_viewed_now().unwrap();
            if let Ok(dir) = BackupDir::for_workspace(&data.join("backups"), ws.id()) {
                dir.remove_leftovers().unwrap();
                take(
                    ws.root(),
                    &dir,
                    SnapshotName::parse("20261012-160000").unwrap(),
                )
                .unwrap();
            }
            ws.trash_memo(&memo.id, 1000).unwrap();
            ws
        }
    }

    #[test]
    fn a_workspace_id_that_is_not_a_uuid_is_replaced_and_reaches_nothing_outside() {
        for bad in BAD_IDS {
            let scene = Scene::new();
            let bad = scene.bad_id(bad);
            scene.set_workspace_id(&bad);
            let before = scene.outside();
            assert_eq!(Workspace::read_id(&scene.folder()), None, "{bad:?}");

            let ws = scene.use_workspace();
            assert_eq!(scene.outside(), before, "{bad:?} changed something outside");
            assert!(is_id(ws.id()), "{bad:?} gave {:?}", ws.id());
            // Written down: the next opening has the same ID, so its backups go on.
            assert_eq!(
                Workspace::read_id(&scene.folder()).as_deref(),
                Some(ws.id())
            );
            assert_eq!(Workspace::open(&scene.folder()).unwrap().id(), ws.id());
            // The state went where it belongs.
            let data = scene.data();
            assert!(data.join(format!("viewed/{}.json", ws.id())).is_file());
            assert!(data
                .join(format!("backups/{}/20261012-160000", ws.id()))
                .is_dir());
        }
    }

    #[test]
    fn a_workspace_id_that_is_a_uuid_is_kept() {
        for id in [
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            "0F8FAD5B-D9CB-469F-A165-70867728950E",
        ] {
            let scene = Scene::new();
            scene.set_workspace_id(id);
            assert_eq!(Workspace::read_id(&scene.folder()).as_deref(), Some(id));
            let ws = scene.use_workspace();
            assert_eq!(ws.id(), id);
            let file = scene.folder().join(TOTE_DIR).join("workspace.json");
            let written: serde_json::Value =
                serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
            assert_eq!(written["id"], id, "not written again");
        }
    }

    #[test]
    fn a_memo_id_that_is_not_a_uuid_is_replaced_and_reaches_nothing_outside() {
        for bad in BAD_IDS {
            let scene = Scene::new();
            // A folder that is not there yet, so that a memo could be moved into it.
            let bad = scene.bad_id(bad).replace("package", "moved");
            let kept = "0f8fad5b-d9cb-469f-a165-70867728950e";
            fs::write(scene.folder().join("둘째.sh"), "echo").unwrap();
            let index = serde_json::json!({"version": 1, "memos": {
                bad.clone(): {"file": "메모.md", "autoTitle": true, "language": "markdown",
                    "pinned": true},
                kept: {"file": "둘째.sh", "autoTitle": false},
            }});
            fs::write(
                scene.folder().join(TOTE_DIR).join("index.json"),
                index.to_string(),
            )
            .unwrap();
            let before = scene.outside();

            let mut ws = Workspace::open(&scene.folder()).unwrap();
            let memos = ws.list_memos().unwrap();
            let memo = memos.iter().find(|m| m.file == "메모.md").unwrap().clone();
            ws.trash_memo(&memo.id, 1000).unwrap();
            assert_eq!(scene.outside(), before, "{bad:?} changed something outside");
            let trashed = scene.folder().join(TRASH_DIR).join(&memo.id);
            assert_eq!(fs::read(trashed.join("메모.md")).unwrap(), "글".as_bytes());

            assert!(memos.iter().all(|memo| is_id(&memo.id)), "{bad:?}");
            assert_eq!(memos.iter().find(|m| m.file == "둘째.sh").unwrap().id, kept);
            // What the entry said of the memo outlives its ID.
            assert!(memo.auto_title && memo.pinned, "{bad:?}");
            assert_eq!(memo.language.as_deref(), Some("markdown"));
            ws.restore_memo(&memo.id).unwrap();
            // Written down: the next opening has the same ID, so its tabs stay.
            let reopened = Workspace::open(&scene.folder()).unwrap();
            assert_eq!(reopened.memo_info(&memo.id).unwrap().file, "메모.md");
            ws.trash_memo(&memo.id, 2000).unwrap();
            ws.purge_trashed(&memo.id).unwrap();
            assert_eq!(scene.outside(), before, "{bad:?} changed something outside");
        }
    }
}
