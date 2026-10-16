//! One memo or file in one place: which window holds each open tab, across every window
//! (spec 「한 메모는 한 자리에」). A window claims a tab before showing it; a claim another window
//! holds is refused with that window's label, so the caller can bring that window forward instead.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// What a tab is, the same in every window. A memo is one of its workspace's; an external file is
/// one place whatever workspace a window shows.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum TabKey {
    Memo { workspace: PathBuf, id: String },
    External { path: PathBuf },
}

/// What the frontend names a tab by; the window's workspace completes a memo's key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TabRef {
    Memo { id: String },
    External { path: PathBuf },
}

#[derive(Default)]
pub struct Places {
    /// Key → the label of the window holding it.
    owners: HashMap<TabKey, String>,
}

impl Places {
    /// Err(owner) when another window has it; claiming one's own again is Ok.
    pub fn claim(&mut self, label: &str, key: TabKey) -> Result<(), String> {
        match self.owners.get(&key) {
            Some(owner) if owner != label => Err(owner.clone()),
            Some(_) => Ok(()),
            None => {
                self.owners.insert(key, label.to_string());
                Ok(())
            }
        }
    }

    /// Frees `key` only when `label` owns it.
    pub fn release(&mut self, label: &str, key: &TabKey) {
        if self.owners.get(key).is_some_and(|owner| owner == label) {
            self.owners.remove(key);
        }
    }

    pub fn release_window(&mut self, label: &str) {
        self.owners.retain(|_, owner| owner != label);
    }

    /// Hands `key` from `from` to `to`; false, changing nothing, when `from` does not own it.
    pub fn transfer(&mut self, key: &TabKey, from: &str, to: &str) -> bool {
        match self.owners.get_mut(key) {
            Some(owner) if owner == from => {
                *owner = to.to_string();
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memo(workspace: &str, id: &str) -> TabKey {
        TabKey::Memo {
            workspace: PathBuf::from(workspace),
            id: id.into(),
        }
    }

    fn external(path: &str) -> TabKey {
        TabKey::External {
            path: PathBuf::from(path),
        }
    }

    #[test]
    fn the_first_claim_wins() {
        let mut places = Places::default();
        assert_eq!(places.claim("w1", memo("/w/가", "a")), Ok(()));
        assert_eq!(
            places.claim("w2", memo("/w/가", "a")),
            Err("w1".to_string())
        );
        assert_eq!(places.claim("w1", memo("/w/가", "a")), Ok(()));
    }

    #[test]
    fn an_external_file_is_one_place_across_workspaces() {
        // Windows of two workspaces: the key of an external file has no workspace in it.
        let mut places = Places::default();
        assert_eq!(places.claim("w1", external("/tmp/a.sh")), Ok(()));
        assert_eq!(
            places.claim("w2", external("/tmp/a.sh")),
            Err("w1".to_string())
        );
    }

    #[test]
    fn memos_of_two_workspaces_with_the_same_id_do_not_collide() {
        let mut places = Places::default();
        assert_eq!(places.claim("w1", memo("/w/가", "a")), Ok(()));
        assert_eq!(places.claim("w2", memo("/w/나", "a")), Ok(()));
    }

    #[test]
    fn release_only_frees_the_owners_claim() {
        let mut places = Places::default();
        places.claim("w1", memo("/w/가", "a")).unwrap();
        places.release("w2", &memo("/w/가", "a"));
        assert_eq!(
            places.claim("w2", memo("/w/가", "a")),
            Err("w1".to_string())
        );
        places.release("w1", &memo("/w/가", "a"));
        assert_eq!(places.claim("w2", memo("/w/가", "a")), Ok(()));
    }

    #[test]
    fn a_closed_window_frees_its_claims() {
        let mut places = Places::default();
        places.claim("w1", memo("/w/가", "a")).unwrap();
        places.claim("w1", external("/tmp/a.sh")).unwrap();
        places.claim("w3", memo("/w/가", "b")).unwrap();
        places.release_window("w1");
        assert_eq!(places.claim("w2", memo("/w/가", "a")), Ok(()));
        assert_eq!(places.claim("w2", external("/tmp/a.sh")), Ok(()));
        assert_eq!(
            places.claim("w2", memo("/w/가", "b")),
            Err("w3".to_string())
        );
    }

    #[test]
    fn transfer_moves_a_claim_to_the_new_window() {
        let mut places = Places::default();
        places.claim("w1", memo("/w/가", "a")).unwrap();
        assert!(!places.transfer(&memo("/w/가", "a"), "w3", "w2"));
        assert!(places.transfer(&memo("/w/가", "a"), "w1", "w2"));
        assert_eq!(
            places.claim("w1", memo("/w/가", "a")),
            Err("w2".to_string())
        );
        assert!(!places.transfer(&memo("/w/가", "a"), "w1", "w3"));
    }
}
