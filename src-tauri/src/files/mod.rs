//! Files for viewers and the large text viewer (spec 「뷰어」 「파일 전달」): a token stands for
//! one file, carries no path, and serves any number of requests — a video seek alone sends
//! dozens of Range requests — until the view that got it closes. Tokens are keyed by window and
//! owner so a closing view, or a closing window, revokes exactly its own.

pub mod range;
pub mod text;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;

/// What a view wants to read, as the frontend names its tabs.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileSource {
    Memo { id: String },
    External { path: PathBuf },
}

struct Token {
    path: PathBuf,
    window: String,
    owner: String,
}

#[derive(Default)]
pub struct TokenStore {
    tokens: Mutex<HashMap<String, Token>>,
}

impl TokenStore {
    pub fn issue(&self, window: &str, owner: &str, path: PathBuf) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.lock().insert(
            token.clone(),
            Token {
                path,
                window: window.to_string(),
                owner: owner.to_string(),
            },
        );
        token
    }

    pub fn resolve(&self, token: &str) -> Option<PathBuf> {
        self.lock().get(token).map(|t| t.path.clone())
    }

    pub fn revoke(&self, window: &str, owner: &str) {
        self.lock()
            .retain(|_, t| !(t.window == window && t.owner == owner));
    }

    pub fn revoke_window(&self, window: &str) {
        self.lock().retain(|_, t| t.window != window);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Token>> {
        self.tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub fn token_url(token: &str) -> String {
    format!("tote-file://localhost/{token}")
}

/// `relative` as a file directly inside `dir` — one plain name, no folders, no `..`, and it
/// must exist as a regular file, not a symbolic link (spec 「뷰어 API」: `resolveRelative`
/// answers for the open file's own folder only, and a link could point anywhere).
pub fn resolve_relative(dir: &Path, relative: &str) -> Option<PathBuf> {
    let name = relative.strip_prefix("./").unwrap_or(relative);
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return None;
    }
    let path = dir.join(name);
    fs::symlink_metadata(&path).ok()?.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn tokens_resolve_until_their_owner_or_window_is_revoked() {
        let store = TokenStore::default();
        let a = store.issue("ws-1", "tab-1:primary", "/a.png".into());
        let b = store.issue("ws-1", "tab-2:primary", "/b.png".into());
        let c = store.issue("ws-2", "tab-1:primary", "/c.png".into());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert_eq!(store.resolve(&a), Some(PathBuf::from("/a.png")));
        store.revoke("ws-1", "tab-1:primary");
        assert_eq!(store.resolve(&a), None);
        assert_eq!(store.resolve(&b), Some(PathBuf::from("/b.png")));
        assert_eq!(store.resolve(&c), Some(PathBuf::from("/c.png")));
        store.revoke_window("ws-1");
        assert_eq!(store.resolve(&b), None);
        assert_eq!(store.resolve(&c), Some(PathBuf::from("/c.png")));
        assert_eq!(token_url(&c), format!("tote-file://localhost/{c}"));
    }

    #[test]
    fn resolve_relative_stays_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("그림.png"), [1u8]).unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/inner.png"), [1u8]).unwrap();
        let parent = dir.path().parent().unwrap();
        let outside = parent.join("outside-for-tote-test.png");
        fs::write(&outside, [1u8]).unwrap();
        assert_eq!(
            resolve_relative(dir.path(), "그림.png"),
            Some(dir.path().join("그림.png"))
        );
        assert_eq!(
            resolve_relative(dir.path(), "./그림.png"),
            Some(dir.path().join("그림.png"))
        );
        for bad in [
            "sub/inner.png",
            "../outside-for-tote-test.png",
            "/etc/passwd",
            "",
            "없음.png",
            "sub",
            "..",
        ] {
            assert_eq!(resolve_relative(dir.path(), bad), None, "{bad:?}");
        }
        // A link in the folder is refused wherever it points: `img.png -> ~/.ssh/id_rsa` would
        // otherwise hand out a file outside it.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, dir.path().join("link.png")).unwrap();
            std::os::unix::fs::symlink(dir.path().join("그림.png"), dir.path().join("inner.png"))
                .unwrap();
            assert_eq!(resolve_relative(dir.path(), "link.png"), None);
            assert_eq!(resolve_relative(dir.path(), "inner.png"), None);
        }
        fs::remove_file(outside).unwrap();
    }

    #[test]
    fn file_sources_deserialise_from_the_frontend_shape() {
        let memo: FileSource = serde_json::from_str(r#"{"kind":"memo","id":"m1"}"#).unwrap();
        assert_eq!(memo, FileSource::Memo { id: "m1".into() });
        let ext: FileSource =
            serde_json::from_str(r#"{"kind":"external","path":"/x/a.mp4"}"#).unwrap();
        assert_eq!(
            ext,
            FileSource::External {
                path: "/x/a.mp4".into()
            }
        );
    }
}
