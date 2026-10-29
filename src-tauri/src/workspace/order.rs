//! Where each workspace sits in the switcher and whether it is hidden: `.tote-workspaces.json`
//! directly under the workspace root (spec 「저장」). The name starts with `.`, so `Workspace::list`
//! never takes it for a workspace.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{Workspace, WorkspaceSummary};
use crate::appdata::lenient;
use crate::persist::write_json;

pub const ORDER_FILE: &str = ".tote-workspaces.json";

/// A workspace as the order file names it: its ID with the folder name it had. The name tells
/// apart a folder duplicated in Finder, which keeps the original's ID.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorkspaceOrder {
    pub order: Vec<Entry>,
    pub hidden: Vec<Entry>,
}

#[derive(Deserialize)]
struct OrderFile {
    version: u32,
    #[serde(default, deserialize_with = "lenient")]
    order: Vec<Entry>,
    #[serde(default, deserialize_with = "lenient")]
    hidden: Vec<Entry>,
}

#[derive(Serialize)]
struct OrderFileRef<'a> {
    version: u32,
    order: &'a [Entry],
    hidden: &'a [Entry],
}

/// A workspace in its place. `id` is `None` when its `workspace.json` cannot be read.
#[derive(Clone, Debug, PartialEq)]
pub struct Arranged {
    pub summary: WorkspaceSummary,
    pub id: Option<String>,
    pub hidden: bool,
}

/// Missing, unreadable or of an unknown version reads as no order. Not `persist::read_json`: that
/// moves an unreadable file aside, and a file a newer build wrote on another device must survive
/// this build looking at it. Only `save` replaces it.
pub fn load(root: &Path) -> WorkspaceOrder {
    let Ok(bytes) = fs::read(root.join(ORDER_FILE)) else {
        return WorkspaceOrder::default();
    };
    match serde_json::from_slice::<OrderFile>(&bytes) {
        Ok(file) if file.version == 1 => WorkspaceOrder {
            order: file.order,
            hidden: file.hidden,
        },
        _ => WorkspaceOrder::default(),
    }
}

pub fn save(root: &Path, order: &WorkspaceOrder) -> io::Result<()> {
    write_json(
        &root.join(ORDER_FILE),
        &OrderFileRef {
            version: 1,
            order: &order.order,
            hidden: &order.hidden,
        },
    )
}

/// `summaries` in `Workspace::list` order (by name) with each one's ID. Those `order` places come
/// first in its order; then the rest with an ID, by name; then those without one, by name. The
/// returned order is the place.
pub fn arrange(
    summaries: Vec<(WorkspaceSummary, Option<String>)>,
    order: &WorkspaceOrder,
) -> Vec<Arranged> {
    let places = matches(&summaries, &order.order);
    let hidden = matches(&summaries, &order.hidden);
    let mut arranged: Vec<(Option<usize>, Arranged)> = summaries
        .into_iter()
        .enumerate()
        .map(|(i, (summary, id))| {
            (
                places[i],
                Arranged {
                    summary,
                    id,
                    hidden: hidden[i].is_some(),
                },
            )
        })
        .collect();
    // Stable, so each group of the unplaced keeps its name order.
    arranged.sort_by_key(|(place, a)| (place.is_none(), a.id.is_none(), *place));
    arranged.into_iter().map(|(_, a)| a).collect()
}

/// The workspaces under `root` in their places, read from disk without changing anything.
pub fn arranged(root: &Path) -> Vec<Arranged> {
    let summaries = Workspace::list(root)
        .into_iter()
        .map(|summary| {
            let id = Workspace::read_id(&summary.path);
            (summary, id)
        })
        .collect();
    arrange(summaries, &load(root))
}

/// For each workspace, the index of the entry it matches, if any (spec 「맞추는 순서」): first an
/// entry with both the ID and the name; then, when only one folder under the root has the ID, an
/// entry with that ID alone (the folder was renamed). Each entry and each workspace is matched at
/// most once, so of two folders sharing an ID neither takes an entry naming some third name.
fn matches(
    summaries: &[(WorkspaceSummary, Option<String>)],
    entries: &[Entry],
) -> Vec<Option<usize>> {
    let mut found: Vec<Option<usize>> = vec![None; summaries.len()];
    let mut used = vec![false; entries.len()];
    for (i, (summary, id)) in summaries.iter().enumerate() {
        let Some(id) = id else { continue };
        if let Some(e) = (0..entries.len())
            .find(|&e| !used[e] && entries[e].id == *id && entries[e].name == summary.name)
        {
            used[e] = true;
            found[i] = Some(e);
        }
    }
    for (i, (_, id)) in summaries.iter().enumerate() {
        let Some(id) = id else { continue };
        if found[i].is_some()
            || summaries
                .iter()
                .filter(|(_, other)| other.as_ref() == Some(id))
                .count()
                != 1
        {
            continue;
        }
        if let Some(e) = (0..entries.len()).find(|&e| !used[e] && entries[e].id == *id) {
            used[e] = true;
            found[i] = Some(e);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{Workspace, TOTE_DIR};
    use std::fs;

    fn names(arranged: &[Arranged]) -> Vec<&str> {
        arranged.iter().map(|a| a.summary.name.as_str()).collect()
    }

    fn hidden_names(arranged: &[Arranged]) -> Vec<&str> {
        arranged
            .iter()
            .filter(|a| a.hidden)
            .map(|a| a.summary.name.as_str())
            .collect()
    }

    fn entry(root: &Path, name: &str) -> Entry {
        Entry {
            id: Workspace::read_id(&root.join(name)).unwrap(),
            name: name.into(),
        }
    }

    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for item in fs::read_dir(from).unwrap() {
            let item = item.unwrap();
            let target = to.join(item.file_name());
            if item.file_type().unwrap().is_dir() {
                copy_dir(&item.path(), &target);
            } else {
                fs::copy(item.path(), target).unwrap();
            }
        }
    }

    fn no_set_aside_files(root: &Path) -> bool {
        fs::read_dir(root).unwrap().all(|item| {
            !item
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".corrupt-")
        })
    }

    #[test]
    fn no_file_is_name_order_and_nothing_hidden() {
        let root = tempfile::tempdir().unwrap();
        Workspace::create(root.path(), "나").unwrap();
        Workspace::create(root.path(), "가").unwrap();
        let arranged = arranged(root.path());
        assert_eq!(names(&arranged), ["가", "나"]);
        assert!(arranged.iter().all(|a| !a.hidden));
    }

    #[test]
    fn the_saved_order_and_flags_are_followed() {
        let root = tempfile::tempdir().unwrap();
        for name in ["가", "나", "다"] {
            Workspace::create(root.path(), name).unwrap();
        }
        let r = root.path();
        save(
            r,
            &WorkspaceOrder {
                order: vec![entry(r, "다"), entry(r, "가")],
                hidden: vec![entry(r, "가")],
            },
        )
        .unwrap();
        let arranged = arranged(r);
        assert_eq!(names(&arranged), ["다", "가", "나"]);
        assert_eq!(hidden_names(&arranged), ["가"]);
    }

    #[test]
    fn a_renamed_folder_keeps_its_place() {
        let root = tempfile::tempdir().unwrap();
        for name in ["가", "나", "다"] {
            Workspace::create(root.path(), name).unwrap();
        }
        let r = root.path();
        save(
            r,
            &WorkspaceOrder {
                order: vec![entry(r, "나"), entry(r, "가")],
                hidden: vec![entry(r, "가")],
            },
        )
        .unwrap();
        fs::rename(r.join("가"), r.join("라")).unwrap();
        // By name alone it would be 나·다·라: the id puts 라 where 가 was, ahead of 다.
        let arranged = arranged(r);
        assert_eq!(names(&arranged), ["나", "라", "다"]);
        assert_eq!(hidden_names(&arranged), ["라"]);
    }

    #[test]
    fn a_duplicated_folder_keeps_its_own_place_and_flag() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        Workspace::create(r, "가").unwrap();
        copy_dir(&r.join("가"), &r.join("가 사본"));
        let id = Workspace::read_id(&r.join("가")).unwrap();
        assert_eq!(Workspace::read_id(&r.join("가 사본")).as_ref(), Some(&id));
        let at = |name: &str| Entry {
            id: id.clone(),
            name: name.into(),
        };

        save(
            r,
            &WorkspaceOrder {
                order: vec![at("가 사본"), at("가")],
                hidden: vec![at("가 사본")],
            },
        )
        .unwrap();
        let arranged_now = arranged(r);
        assert_eq!(names(&arranged_now), ["가 사본", "가"]);
        assert_eq!(hidden_names(&arranged_now), ["가 사본"]);

        // Two folders share the id and neither has the name: neither may claim the entry.
        save(
            r,
            &WorkspaceOrder {
                order: vec![at("옛 이름")],
                hidden: vec![at("옛 이름")],
            },
        )
        .unwrap();
        let arranged_now = arranged(r);
        assert_eq!(names(&arranged_now), ["가", "가 사본"]);
        assert!(arranged_now.iter().all(|a| !a.hidden));
    }

    #[test]
    fn an_unknown_version_reads_as_default_and_is_left_alone() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let file = r.join(ORDER_FILE);
        let newer: &[u8] =
            br#"{"version":2,"order":[{"id":"i","name":"n"}],"hidden":[{"id":"i","name":"n"}]}"#;
        for bytes in [newer, b"nope".as_slice()] {
            fs::write(&file, bytes).unwrap();
            assert_eq!(load(r), WorkspaceOrder::default());
            assert_eq!(fs::read(&file).unwrap(), bytes);
            assert!(no_set_aside_files(r));
        }
    }

    #[test]
    fn one_bad_field_falls_back_alone() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        fs::write(
            r.join(ORDER_FILE),
            r#"{"version":1,"order":"x","hidden":[{"id":"i","name":"n"}]}"#,
        )
        .unwrap();
        assert_eq!(
            load(r),
            WorkspaceOrder {
                order: vec![],
                hidden: vec![Entry {
                    id: "i".into(),
                    name: "n".into()
                }],
            }
        );
    }

    #[test]
    fn a_workspace_without_a_readable_id_goes_last() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        Workspace::create(r, "가").unwrap();
        Workspace::create(r, "나").unwrap();
        let meta = r.join("가").join(TOTE_DIR).join("workspace.json");
        fs::write(&meta, "nope").unwrap();
        let arranged = arranged(r);
        assert_eq!(names(&arranged), ["나", "가"]);
        assert_eq!(arranged[1].id, None);
        assert_eq!(fs::read(&meta).unwrap(), b"nope");
        assert!(no_set_aside_files(meta.parent().unwrap()));
    }

    #[test]
    fn the_order_file_is_not_a_workspace() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        Workspace::create(r, "가").unwrap();
        save(
            r,
            &WorkspaceOrder {
                order: vec![entry(r, "가")],
                hidden: vec![],
            },
        )
        .unwrap();
        assert!(r.join(ORDER_FILE).is_file());
        let listed = Workspace::list(r);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "가");
    }

    #[test]
    fn save_then_load_round_trips() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let order = WorkspaceOrder {
            order: vec![
                Entry {
                    id: "b".into(),
                    name: "나".into(),
                },
                Entry {
                    id: "a".into(),
                    name: "가".into(),
                },
            ],
            hidden: vec![Entry {
                id: "a".into(),
                name: "가".into(),
            }],
        };
        save(r, &order).unwrap();
        assert_eq!(load(r), order);
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(r.join(ORDER_FILE)).unwrap()).unwrap();
        assert_eq!(json["version"], 1);
    }
}
