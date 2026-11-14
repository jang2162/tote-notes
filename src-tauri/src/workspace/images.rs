//! Images a Markdown memo takes in: bytes pasted from the clipboard and files dropped from
//! Finder, written to the workspace's root next to the memos (spec
//! docs/superpowers/specs/2026-11-14-tote-notes-image-paste-design.md 「백엔드 명령」).

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

use serde::Serialize;

use super::names::{is_valid_file_name, split_name};
use super::{MemoInfo, Workspace, WorkspaceError};

/// One image may be this large and no larger (spec 「크기 제한」). `MAX_IMAGE_BYTES` in
/// src/core/images.ts must agree.
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// The extensions an image is known by. `IMAGE_EXTENSIONS` in src/core/images.ts must
/// agree.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// What a dropped image became: the file the memo links to, and the memo info of the copy when
/// one was made (`None` for a file already in the root).
#[derive(Debug, Serialize)]
pub struct ImportedImage {
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<MemoInfo>,
}

/// One plain name tote may create, with an image's extension.
fn image_name(name: &str) -> Result<(), WorkspaceError> {
    let ext = split_name(name).1.to_ascii_lowercase();
    if is_valid_file_name(name) && IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Ok(())
    } else {
        Err(WorkspaceError::InvalidName(name.to_string()))
    }
}

fn too_large(name: &str) -> WorkspaceError {
    WorkspaceError::ImageTooLarge(name.to_string())
}

impl Workspace {
    /// Writes pasted image bytes to the root as `file_name`, or the next free name (` 2`, …).
    /// The write is atomic and counts as tote's own (`add_memo`): the watcher does not report the
    /// new file as another app's.
    pub fn save_image(
        &mut self,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<MemoInfo, WorkspaceError> {
        image_name(file_name)?;
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(too_large(file_name));
        }
        let (stem, ext) = split_name(file_name);
        let file = self.free_name(stem, ext, None);
        self.add_memo(file, false, bytes)
    }

    /// Copies a dropped image file into the root under its own name (or the next free one); the
    /// file itself is not touched. A file directly in the root is linked as it is, not copied.
    ///
    /// The bytes go through memory and `add_memo`, not `copy_in` as an import's do: a copy's own
    /// write is only recorded for text (`came_in`), and an image recorded as nobody's comes back
    /// from the watcher as changed by another app. The size limit keeps that buffer small.
    pub fn import_image(&mut self, path: &Path) -> Result<ImportedImage, WorkspaceError> {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| WorkspaceError::InvalidName(path.display().to_string()))?;
        image_name(name)?;
        if self.is_root_file(path) {
            return Ok(ImportedImage {
                file: name.to_string(),
                memo: None,
            });
        }
        let mut source = File::open(path)?;
        // The open file's size, then a read that stops past the limit: a file growing in between
        // is still refused, and never read whole.
        if source.metadata()?.len() > MAX_IMAGE_BYTES {
            return Err(too_large(name));
        }
        let mut bytes = Vec::new();
        (&mut source)
            .take(MAX_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(too_large(name));
        }
        let (stem, ext) = split_name(name);
        let file = self.free_name(stem, ext, None);
        let memo = self.add_memo(file, false, &bytes)?;
        Ok(ImportedImage {
            file: memo.file.clone(),
            memo: Some(memo),
        })
    }

    /// Whether `path` is a regular file directly inside the root, by the real paths: a link is
    /// not one (the preview refuses links, `files::resolve_relative`), nor is a file in a folder
    /// under the root (the workspace is flat).
    fn is_root_file(&self, path: &Path) -> bool {
        let same_folder = || -> io::Result<bool> {
            let parent = path.parent().ok_or(io::ErrorKind::NotFound)?;
            Ok(fs::canonicalize(parent)? == fs::canonicalize(&self.root)?)
        };
        fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
            && same_folder().unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::content_hash;
    use crate::workspace::FileKind;
    use std::collections::BTreeSet;

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let root = tempfile::tempdir().unwrap();
        let ws = Workspace::create(root.path(), "w").unwrap();
        (root, ws)
    }

    /// Every entry of the root but `.tote`, dot files included: a temporary file left behind
    /// would show here.
    fn entries(ws: &Workspace) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(ws.root())
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n != ".tote")
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_pasted_image_takes_the_next_free_name() {
        let (_root, mut ws) = workspace();
        let first = ws.save_image("회의 이미지.png", b"\x89PNG one").unwrap();
        let second = ws.save_image("회의 이미지.png", b"\x89PNG two").unwrap();
        assert_eq!(first.file, "회의 이미지.png");
        assert_eq!(second.file, "회의 이미지 2.png");
        assert_eq!(first.kind, FileKind::Image);
        assert!(!first.auto_title);
        assert_eq!(
            fs::read(ws.root().join("회의 이미지.png")).unwrap(),
            b"\x89PNG one"
        );
        assert_eq!(
            fs::read(ws.root().join("회의 이미지 2.png")).unwrap(),
            b"\x89PNG two"
        );
        // Written through a temporary file and a rename: nothing else is left in the folder.
        assert_eq!(entries(&ws), ["회의 이미지 2.png", "회의 이미지.png"]);
        assert_eq!(ws.memo_info(&second.id).unwrap().file, "회의 이미지 2.png");
    }

    #[test]
    fn a_pasted_image_is_recorded_as_tote_s_own_write() {
        let (_root, mut ws) = workspace();
        let bytes = b"GIF89a image";
        let info = ws.save_image("a.gif", bytes).unwrap();
        assert_eq!(ws.held_hash(&info.file), Some(content_hash(bytes).as_str()));
        let touched = BTreeSet::from([info.file.clone()]);
        // The watcher's event for the write: no news, not another app's file.
        assert!(ws.apply_fs_events(&touched, &[]).unwrap().is_empty());
    }

    #[test]
    fn an_image_over_twenty_megabytes_is_refused_before_anything_is_written() {
        let (_root, mut ws) = workspace();
        let limit = MAX_IMAGE_BYTES as usize;
        assert_eq!(limit, 20 * 1024 * 1024);
        let info = ws.save_image("딱.png", &vec![7u8; limit]).unwrap();
        assert_eq!(
            fs::metadata(ws.root().join(&info.file)).unwrap().len(),
            limit as u64
        );
        let err = ws
            .save_image("넘침.png", &vec![7u8; limit + 1])
            .unwrap_err();
        assert!(
            matches!(err, WorkspaceError::ImageTooLarge(ref name) if name == "넘침.png"),
            "{err:?}"
        );
        assert_eq!(entries(&ws), ["딱.png"]);
    }

    #[test]
    fn a_name_that_is_not_one_plain_image_name_is_refused() {
        let (root, mut ws) = workspace();
        for bad in [
            "../밖.png",
            "a/b.png",
            "/tmp/x.png",
            ".숨김.png",
            "",
            " a.png",
            "a.txt",
            "a.md",
            "a",
            "a:b.png",
        ] {
            let err = ws.save_image(bad, b"x").unwrap_err();
            assert!(
                matches!(err, WorkspaceError::InvalidName(_)),
                "{bad:?}: {err:?}"
            );
        }
        assert!(entries(&ws).is_empty());
        assert!(!root.path().join("밖.png").exists());
        // Case does not matter to the extension.
        assert_eq!(ws.save_image("A.JPG", b"x").unwrap().file, "A.JPG");
        assert_eq!(ws.save_image("b.svg", b"<svg/>").unwrap().file, "b.svg");
    }

    #[test]
    fn a_dropped_file_is_copied_in_and_left_as_it_was() {
        let (outside, mut ws) = workspace();
        let source = outside.path().join("스크린숏.png");
        fs::write(&source, b"\x89PNG shot").unwrap();
        fs::write(ws.root().join("스크린숏.png"), b"taken").unwrap();
        ws.list_memos().unwrap();
        let imported = ws.import_image(&source).unwrap();
        assert_eq!(imported.file, "스크린숏 2.png");
        let memo = imported.memo.expect("a copy");
        assert_eq!(memo.file, "스크린숏 2.png");
        assert_eq!(memo.kind, FileKind::Image);
        assert_eq!(
            fs::read(ws.root().join("스크린숏 2.png")).unwrap(),
            b"\x89PNG shot"
        );
        assert_eq!(fs::read(&source).unwrap(), b"\x89PNG shot");
        assert_eq!(entries(&ws), ["스크린숏 2.png", "스크린숏.png"]);
        // The copy is tote's own write, as a pasted image is.
        let touched = BTreeSet::from([memo.file.clone()]);
        assert!(ws.apply_fs_events(&touched, &[]).unwrap().is_empty());
    }

    #[test]
    fn a_file_directly_in_the_root_is_linked_not_copied() {
        let (_root, mut ws) = workspace();
        fs::write(ws.root().join("그림.png"), b"pic").unwrap();
        let imported = ws.import_image(&ws.root().join("그림.png")).unwrap();
        assert_eq!(imported.file, "그림.png");
        assert!(imported.memo.is_none());
        assert_eq!(entries(&ws), ["그림.png"]);
    }

    #[test]
    fn a_file_in_a_folder_under_the_root_is_copied_up() {
        let (_root, mut ws) = workspace();
        fs::create_dir(ws.root().join("sub")).unwrap();
        fs::write(ws.root().join("sub/아래.png"), b"down").unwrap();
        let imported = ws.import_image(&ws.root().join("sub/아래.png")).unwrap();
        assert_eq!(imported.file, "아래.png");
        assert!(imported.memo.is_some());
        assert_eq!(fs::read(ws.root().join("아래.png")).unwrap(), b"down");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_root_is_copied_as_a_file() {
        let (outside, mut ws) = workspace();
        let target = outside.path().join("target.png");
        fs::write(&target, b"real").unwrap();
        std::os::unix::fs::symlink(&target, ws.root().join("link.png")).unwrap();
        let imported = ws.import_image(&ws.root().join("link.png")).unwrap();
        assert_eq!(imported.file, "link 2.png");
        assert_eq!(fs::read(ws.root().join("link 2.png")).unwrap(), b"real");
    }

    #[test]
    fn a_dropped_file_over_twenty_megabytes_or_not_an_image_is_refused() {
        let (outside, mut ws) = workspace();
        let big = outside.path().join("큰.png");
        File::create(&big)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        let err = ws.import_image(&big).unwrap_err();
        assert!(
            matches!(err, WorkspaceError::ImageTooLarge(ref name) if name == "큰.png"),
            "{err:?}"
        );
        let text = outside.path().join("글.txt");
        fs::write(&text, b"x").unwrap();
        let err = ws.import_image(&text).unwrap_err();
        assert!(matches!(err, WorkspaceError::InvalidName(_)), "{err:?}");
        let missing = ws
            .import_image(&outside.path().join("없음.png"))
            .unwrap_err();
        assert!(
            matches!(missing, WorkspaceError::Io(ref io) if io.kind() == io::ErrorKind::NotFound)
        );
        assert!(entries(&ws).is_empty());
    }
}
