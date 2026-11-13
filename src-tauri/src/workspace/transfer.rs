//! A memo copied within its workspace, or moved to another workspace (conveniences spec
//! 「메모 복제」·「다른 워크스페이스로 옮기기」).

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

use super::index::MemoEntry;
use super::names::split_name;
use super::ops::copy_in;
use super::{new_id, MemoInfo, Workspace, WorkspaceError};

/// The file system calls a move makes, apart so a test can make one fail where the disk would:
/// a rename across volumes, a copy cut short, a source that cannot be removed.
pub struct FileOps {
    pub rename: fn(&Path, &Path) -> io::Result<()>,
    pub copy: fn(&Path, &Path) -> io::Result<()>,
    pub remove: fn(&Path) -> io::Result<()>,
}

impl FileOps {
    pub const SYSTEM: FileOps = FileOps {
        rename: system_rename,
        copy: system_copy,
        remove: system_remove,
    };
}

fn system_rename(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

/// As an import copies (`copy_in`): through a temporary file beside `to`, renamed in once whole.
fn system_copy(from: &Path, to: &Path) -> io::Result<()> {
    copy_in(&mut File::open(from)?, to)
}

fn system_remove(path: &Path) -> io::Result<()> {
    fs::remove_file(path)
}

impl Workspace {
    /// A copy of memo `id` beside it, named `<name> 2.<ext>` (or the next free number): a new ID,
    /// a name the person sees as theirs (no automatic titles), the original's language and not its
    /// pin. `contents` is what the editor holds of it, unsaved text included; without it the file
    /// is copied as it is, whatever its kind or size.
    pub fn duplicate_memo(
        &mut self,
        id: &str,
        contents: Option<&[u8]>,
    ) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?.clone();
        let (stem, ext) = split_name(&entry.file);
        let file = self.free_name(stem, ext, None);
        let copy = match contents {
            Some(bytes) => self.add_memo(file, false, bytes)?,
            None => {
                let mut source = File::open(self.root.join(&entry.file))?;
                self.add_copy(file, false, &mut source)?
            }
        };
        if let (Some(language), Some(added)) = (entry.language, self.index.get_mut(&copy.id)) {
            added.language = Some(language);
            self.index.save()?;
        }
        self.memo_info(&copy.id)
    }

    /// Moves memo `id` into `target` under a new ID (conveniences spec 「색인과 ID」), keeping its
    /// automatic titles, language and pin, under the first free name there. Returns it as
    /// `target` lists it. The order of writes keeps the text somewhere whatever fails or wherever
    /// the app dies (spec 「쓰기 순서와 실패」): the file first — renamed, or across volumes copied,
    /// checked byte for byte and only then removed — then `target`'s index, then this one's.
    pub fn move_memo_to(
        &mut self,
        id: &str,
        target: &mut Workspace,
        ops: &FileOps,
    ) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?.clone();
        let (stem, ext) = split_name(&entry.file);
        let file = target.free_name(stem, ext, None);
        let from = self.root.join(&entry.file);
        let to = target.root.join(&file);
        self.mark_changed();
        target.mark_changed();
        let copied = match (ops.rename)(&from, &to) {
            Ok(()) => false,
            Err(err) if err.kind() == io::ErrorKind::CrossesDevices => {
                copy_checked(ops, &from, &to)?;
                true
            }
            Err(err) => return Err(err.into()),
        };
        // Recorded as tote's own before the target's watcher hears of it.
        target.came_in(&file);
        let moved_id = new_id();
        target.index.insert(
            moved_id.clone(),
            MemoEntry {
                file,
                auto_title: entry.auto_title,
                language: entry.language,
                pinned: entry.pinned,
            },
        );
        // A failed index write does not stop the rest: the file is in the target already, and
        // the source must forget it (spec 「쓰기 순서와 실패」).
        let target_saved = target.index.save();
        if copied {
            if let Err(err) = (ops.remove)(&from) {
                // Both copies stay, each a memo of its workspace: nothing is lost.
                target_saved?;
                return Err(err.into());
            }
        }
        self.went_out(&entry.file);
        self.index.remove(id);
        self.previews.borrow_mut().remove(id);
        if let Some(viewed) = self.viewed.as_mut() {
            viewed.retain(|each| each != id);
        }
        let source_saved = self.index.save();
        target_saved?;
        source_saved?;
        target.memo_info(&moved_id)
    }
}

/// Copies `from` to `to` (another volume) and reads both back to see the copy is whole. A copy
/// that fails or differs is removed, and the source is left as it was.
fn copy_checked(ops: &FileOps, from: &Path, to: &Path) -> io::Result<()> {
    let checked = (ops.copy)(from, to).and_then(|()| match same_bytes(from, to)? {
        true => Ok(()),
        false => Err(io::Error::other(format!(
            "the copy at {} does not match the original",
            to.display()
        ))),
    });
    if checked.is_err() {
        let _ = fs::remove_file(to);
    }
    checked
}

/// Whether the two files hold the same bytes, read a buffer at a time: a memo may be gigabytes.
fn same_bytes(a: &Path, b: &Path) -> io::Result<bool> {
    let (mut a, mut b) = (File::open(a)?, File::open(b)?);
    if a.metadata()?.len() != b.metadata()?.len() {
        return Ok(false);
    }
    let (mut x, mut y) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let n = a.read(&mut x)?;
        if n == 0 {
            return Ok(true);
        }
        b.read_exact(&mut y[..n])?;
        if x[..n] != y[..n] {
            return Ok(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::FileKind;

    fn two() -> (tempfile::TempDir, Workspace, Workspace) {
        let root = tempfile::tempdir().unwrap();
        let a = Workspace::create(root.path(), "가").unwrap();
        let b = Workspace::create(root.path(), "나").unwrap();
        (root, a, b)
    }

    fn files(ws: &mut Workspace) -> Vec<String> {
        let mut list: Vec<String> = ws
            .list_memos()
            .unwrap()
            .into_iter()
            .map(|m| m.file)
            .collect();
        list.sort();
        list
    }

    #[test]
    fn a_duplicate_takes_the_next_number_and_the_language_but_not_the_pin() {
        let (_root, mut ws, _) = two();
        let memo = ws.import_memo("회의록.md", b"# agenda").unwrap();
        ws.set_language(&memo.id, "markdown", "md", false).unwrap();
        ws.set_pinned(&memo.id, true).unwrap();
        let first = ws.duplicate_memo(&memo.id, None).unwrap();
        assert_eq!(first.file, "회의록 2.md");
        assert_ne!(first.id, memo.id);
        assert!(!first.auto_title);
        assert_eq!(first.language.as_deref(), Some("markdown"));
        assert!(!first.pinned);
        assert_eq!(
            fs::read(ws.root().join("회의록 2.md")).unwrap(),
            b"# agenda"
        );
        let second = ws.duplicate_memo(&memo.id, None).unwrap();
        assert_eq!(second.file, "회의록 3.md");
        // Of a copy, the number goes on the copy's name.
        let third = ws.duplicate_memo(&first.id, None).unwrap();
        assert_eq!(third.file, "회의록 2 2.md");
        // The index on disk has them, as the next open reads it.
        let reopened = Workspace::open(ws.root()).unwrap();
        let again = reopened.memo_info(&first.id).unwrap();
        assert_eq!(again.language.as_deref(), Some("markdown"));
        assert!(!again.auto_title && !again.pinned);
    }

    #[test]
    fn a_memo_with_an_automatic_title_duplicates_under_a_name_of_its_own() {
        let (_root, mut ws, _) = two();
        let memo = ws.create_memo("md", b"draft").unwrap();
        assert!(memo.auto_title);
        let copy = ws.duplicate_memo(&memo.id, None).unwrap();
        assert!(!copy.auto_title);
        assert_eq!(copy.file, "untitled 2.md");
    }

    #[test]
    fn a_duplicate_holds_the_text_it_is_given_not_the_file() {
        let (_root, mut ws, _) = two();
        let memo = ws.import_memo("a.txt", b"saved").unwrap();
        let copy = ws
            .duplicate_memo(&memo.id, Some(b"saved and typed"))
            .unwrap();
        assert_eq!(
            fs::read(ws.root().join(&copy.file)).unwrap(),
            b"saved and typed"
        );
        assert_eq!(fs::read(ws.root().join("a.txt")).unwrap(), b"saved");
        // Written by tote: the watcher's report of it is no news.
        assert!(ws.held_hash(&copy.file).is_some());
    }

    #[test]
    fn a_file_that_is_not_text_is_duplicated_as_it_is() {
        let (_root, mut ws, _) = two();
        let bytes = [0u8, 1, 2, 0, 255];
        let memo = ws.import_memo("pic.png", &bytes).unwrap();
        let copy = ws.duplicate_memo(&memo.id, None).unwrap();
        assert_eq!(copy.file, "pic 2.png");
        assert_eq!(copy.kind, FileKind::Image);
        assert_eq!(fs::read(ws.root().join("pic 2.png")).unwrap(), bytes);
    }

    #[test]
    fn duplicating_an_unknown_memo_is_refused() {
        let (_root, mut ws, _) = two();
        assert!(matches!(
            ws.duplicate_memo("nope", None),
            Err(WorkspaceError::UnknownMemo(_))
        ));
    }

    #[test]
    fn a_move_renames_the_file_into_the_target_under_a_new_id() {
        let (_root, mut a, mut b) = two();
        let memo = a.import_memo("회의록.md", b"# agenda").unwrap();
        a.set_language(&memo.id, "markdown", "md", false).unwrap();
        a.set_pinned(&memo.id, true).unwrap();
        let moved = a.move_memo_to(&memo.id, &mut b, &FileOps::SYSTEM).unwrap();
        assert_ne!(moved.id, memo.id);
        assert_eq!(moved.file, "회의록.md");
        assert!(!moved.auto_title);
        assert_eq!(moved.language.as_deref(), Some("markdown"));
        assert!(moved.pinned);
        assert!(!a.root().join("회의록.md").exists());
        assert_eq!(fs::read(b.root().join("회의록.md")).unwrap(), b"# agenda");
        assert!(a.list_memos().unwrap().is_empty());
        assert!(matches!(
            a.memo_info(&memo.id),
            Err(WorkspaceError::UnknownMemo(_))
        ));
        // Nothing of the file is the source's own any more, and the target counts it as tote's.
        assert_eq!(a.held_hash("회의록.md"), None);
        assert!(!a.inodes().contains_key("회의록.md"));
        assert!(b.held_hash("회의록.md").is_some());
        assert!(b.inodes().contains_key("회의록.md"));
        // Both indexes are on disk.
        let (mut a2, b2) = (
            Workspace::open(a.root()).unwrap(),
            Workspace::open(b.root()).unwrap(),
        );
        assert!(a2.list_memos().unwrap().is_empty());
        let there = b2.memo_info(&moved.id).unwrap();
        assert_eq!(there.language.as_deref(), Some("markdown"));
        assert!(there.pinned && !there.auto_title);
    }

    #[test]
    fn a_memo_with_an_automatic_title_keeps_it_through_a_move() {
        let (_root, mut a, mut b) = two();
        let memo = a.create_memo("md", b"draft").unwrap();
        let moved = a.move_memo_to(&memo.id, &mut b, &FileOps::SYSTEM).unwrap();
        assert!(moved.auto_title);
    }

    #[test]
    fn a_name_the_target_has_gets_a_number() {
        let (_root, mut a, mut b) = two();
        b.import_memo("a.md", b"theirs").unwrap();
        let memo = a.import_memo("a.md", b"mine").unwrap();
        let moved = a.move_memo_to(&memo.id, &mut b, &FileOps::SYSTEM).unwrap();
        assert_eq!(moved.file, "a 2.md");
        assert_eq!(fs::read(b.root().join("a.md")).unwrap(), b"theirs");
        assert_eq!(fs::read(b.root().join("a 2.md")).unwrap(), b"mine");
        assert_eq!(files(&mut b), vec!["a 2.md", "a.md"]);
    }

    fn across_volumes(_: &Path, _: &Path) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::CrossesDevices))
    }

    #[test]
    fn across_volumes_the_file_is_copied_checked_and_then_removed() {
        let (_root, mut a, mut b) = two();
        let memo = a.import_memo("a.md", b"text").unwrap();
        let ops = FileOps {
            rename: across_volumes,
            ..FileOps::SYSTEM
        };
        let moved = a.move_memo_to(&memo.id, &mut b, &ops).unwrap();
        assert_eq!(fs::read(b.root().join(&moved.file)).unwrap(), b"text");
        assert!(!a.root().join("a.md").exists());
        assert!(a.list_memos().unwrap().is_empty());
        assert_eq!(files(&mut b), vec!["a.md"]);
        assert!(b.held_hash("a.md").is_some());
    }

    fn copy_cut_short(from: &Path, to: &Path) -> io::Result<()> {
        let bytes = fs::read(from)?;
        fs::write(to, &bytes[..bytes.len() / 2])?;
        Err(io::Error::other("the disk is full"))
    }

    fn copy_that_differs(_: &Path, to: &Path) -> io::Result<()> {
        fs::write(to, b"something else")
    }

    #[test]
    fn a_copy_that_fails_or_differs_leaves_the_memo_where_it_was() {
        for copy in [
            copy_cut_short as fn(&Path, &Path) -> io::Result<()>,
            copy_that_differs,
        ] {
            let (_root, mut a, mut b) = two();
            let memo = a.import_memo("a.md", b"the only text").unwrap();
            let ops = FileOps {
                rename: across_volumes,
                copy,
                ..FileOps::SYSTEM
            };
            assert!(a.move_memo_to(&memo.id, &mut b, &ops).is_err());
            assert_eq!(fs::read(a.root().join("a.md")).unwrap(), b"the only text");
            assert_eq!(a.memo_info(&memo.id).unwrap().file, "a.md");
            assert!(b.list_memos().unwrap().is_empty());
            // No half copy left in the target folder, under any name.
            assert_eq!(super::super::index::memo_files(b.root()).unwrap().len(), 0);
            assert!(Workspace::open(a.root())
                .unwrap()
                .memo_info(&memo.id)
                .is_ok());
        }
    }

    fn cannot_remove(_: &Path) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }

    #[test]
    fn a_source_that_cannot_be_removed_leaves_the_memo_in_both() {
        let (_root, mut a, mut b) = two();
        let memo = a.import_memo("a.md", b"text").unwrap();
        let ops = FileOps {
            rename: across_volumes,
            remove: cannot_remove,
            ..FileOps::SYSTEM
        };
        assert!(a.move_memo_to(&memo.id, &mut b, &ops).is_err());
        assert_eq!(a.memo_info(&memo.id).unwrap().file, "a.md");
        assert_eq!(fs::read(a.root().join("a.md")).unwrap(), b"text");
        assert_eq!(files(&mut b), vec!["a.md"]);
        assert_eq!(fs::read(b.root().join("a.md")).unwrap(), b"text");
    }

    fn refused(_: &Path, _: &Path) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }

    #[test]
    fn a_rename_that_fails_changes_nothing() {
        let (_root, mut a, mut b) = two();
        let memo = a.import_memo("a.md", b"text").unwrap();
        let ops = FileOps {
            rename: refused,
            ..FileOps::SYSTEM
        };
        assert!(a.move_memo_to(&memo.id, &mut b, &ops).is_err());
        assert_eq!(a.memo_info(&memo.id).unwrap().file, "a.md");
        assert!(a.held_hash("a.md").is_some());
        assert!(b.list_memos().unwrap().is_empty());
    }

    #[test]
    fn a_file_moved_before_either_index_was_written_is_a_memo_of_the_target() {
        // The app died right after the rename: both workspaces bring their index in line with
        // their files as they open, and the text is in the target.
        let (_root, mut a, b) = two();
        let memo = a.import_memo("a.md", b"text").unwrap();
        fs::rename(a.root().join("a.md"), b.root().join("a.md")).unwrap();
        drop(a);
        let a = Workspace::open(&b.root().with_file_name("가")).unwrap();
        let mut b = Workspace::open(b.root()).unwrap();
        assert!(a.memo_info(&memo.id).is_err());
        assert_eq!(files(&mut b), vec!["a.md"]);
    }

    #[test]
    fn moving_an_unknown_memo_is_refused_and_moves_nothing() {
        let (_root, mut a, mut b) = two();
        assert!(matches!(
            a.move_memo_to("nope", &mut b, &FileOps::SYSTEM),
            Err(WorkspaceError::UnknownMemo(_))
        ));
    }
}
