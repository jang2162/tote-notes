//! Creating, saving, renaming and removing memo files. Every operation goes through the memo ID,
//! so a save that lands right after a title rename still finds the file.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::index::{file_id, MemoEntry};
use super::names::{is_valid_file_name, join_name, split_name, unique_file_name};
use super::{kind_for, FileKind, MemoInfo, Workspace, WorkspaceError};
use crate::persist::external::MAX_EDITOR_BYTES;
use crate::persist::{atomic_write, content_hash};

impl Workspace {
    pub fn create_memo(&mut self, ext: &str, contents: &[u8]) -> Result<MemoInfo, WorkspaceError> {
        let file = self.free_name("untitled", ext, None);
        self.add_memo(file, true, contents)
    }

    pub fn memo_path(&self, id: &str) -> Result<PathBuf, WorkspaceError> {
        Ok(self.root.join(&self.entry(id)?.file))
    }

    pub fn read_memo(&self, id: &str) -> Result<Vec<u8>, WorkspaceError> {
        let file = &self.entry(id)?.file;
        Ok(fs::read(self.root.join(file))?)
    }

    /// Writes by ID. A file deleted under us is written again: the editor's text is the newest
    /// copy there is.
    pub fn write_memo(&mut self, id: &str, contents: &[u8]) -> Result<MemoInfo, WorkspaceError> {
        let file = self.entry(id)?.file.clone();
        self.mark_changed();
        atomic_write(&self.root.join(&file), contents)?;
        self.wrote(&file, contents);
        self.memo_info(id)
    }

    /// Renames an automatically titled memo to `<stem>.<its extension>`; memos the person named
    /// are left alone. `stem` comes from the frontend's title rule and is checked again here
    /// because a file name is the one thing that must never leave the workspace folder.
    pub fn retitle_memo(&mut self, id: &str, stem: &str) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?.clone();
        if !entry.auto_title {
            return self.memo_info(id);
        }
        let ext = split_name(&entry.file).1.to_string();
        if !is_valid_file_name(&join_name(stem, &ext)) {
            return Err(WorkspaceError::InvalidName(stem.to_string()));
        }
        let file = self.free_name(stem, &ext, Some(&entry.file));
        self.move_memo(id, &entry.file, file, true)
    }

    /// A name the person chose: used as is, and the memo stops getting automatic titles.
    pub fn rename_memo(&mut self, id: &str, file: &str) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?.clone();
        let file = file.trim();
        if !is_valid_file_name(file) {
            return Err(WorkspaceError::InvalidName(file.to_string()));
        }
        let to = self.root.join(file);
        if to.symlink_metadata().is_ok() && !same_file(&self.root.join(&entry.file), &to) {
            return Err(WorkspaceError::AlreadyExists(to));
        }
        self.move_memo(id, &entry.file, file.to_string(), false)
    }

    /// The language chosen in the status bar (spec 「편집기」): the file takes the language's
    /// extension and the index remembers the id. Automatic titles go on as before — a language
    /// is not a name the person typed.
    pub fn set_language(
        &mut self,
        id: &str,
        language: &str,
        ext: &str,
    ) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?.clone();
        let (stem, current) = split_name(&entry.file);
        let file = if current.eq_ignore_ascii_case(ext) {
            entry.file.clone()
        } else {
            if !is_valid_file_name(&join_name(stem, ext)) {
                return Err(WorkspaceError::InvalidName(ext.to_string()));
            }
            self.free_name(stem, ext, Some(&entry.file))
        };
        self.mark_changed();
        if file != entry.file {
            fs::rename(self.root.join(&entry.file), self.root.join(&file))?;
            self.moved(&entry.file, &file);
        }
        if let Some(entry) = self.index.get_mut(id) {
            entry.file = file;
            entry.language = Some(language.to_string());
        }
        self.index.save()?;
        self.memo_info(id)
    }

    pub fn delete_memo(&mut self, id: &str) -> Result<(), WorkspaceError> {
        let file = self.entry(id)?.file.clone();
        self.mark_changed();
        match fs::remove_file(self.root.join(&file)) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        self.last_written.remove(&file);
        self.inodes.remove(&file);
        self.index.remove(id);
        self.index.save()?;
        Ok(())
    }

    /// Copies `contents` in as a new memo named `file_name` (`a.sh`, `a 2.sh`, …). The person
    /// chose that name, so automatic titles stay off.
    pub fn import_memo(
        &mut self,
        file_name: &str,
        contents: &[u8],
    ) -> Result<MemoInfo, WorkspaceError> {
        if !is_valid_file_name(file_name) {
            return Err(WorkspaceError::InvalidName(file_name.to_string()));
        }
        let (stem, ext) = split_name(file_name);
        let file = self.free_name(stem, ext, None);
        self.add_memo(file, false, contents)
    }

    /// `import_memo` with the bytes and the name of a file on disk; the file itself is not touched.
    pub fn import_file(&mut self, path: &Path) -> Result<MemoInfo, WorkspaceError> {
        let contents = fs::read(path)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| WorkspaceError::InvalidName(path.display().to_string()))?;
        self.import_memo(name, &contents)
    }

    fn add_memo(
        &mut self,
        file: String,
        auto_title: bool,
        contents: &[u8],
    ) -> Result<MemoInfo, WorkspaceError> {
        self.mark_changed();
        atomic_write(&self.root.join(&file), contents)?;
        self.wrote(&file, contents);
        let id = uuid::Uuid::new_v4().to_string();
        self.index.insert(
            id.clone(),
            MemoEntry {
                file,
                auto_title,
                language: None,
            },
        );
        self.index.save()?;
        self.memo_info(&id)
    }

    fn move_memo(
        &mut self,
        id: &str,
        from: &str,
        to: String,
        auto_title: bool,
    ) -> Result<MemoInfo, WorkspaceError> {
        // Title updates fire on every cursor move off the first line, nearly always with the same
        // title; skip the fsync'd index write then.
        if from == to
            && self
                .index
                .get(id)
                .is_some_and(|e| e.auto_title == auto_title)
        {
            return self.memo_info(id);
        }
        self.mark_changed();
        if from != to {
            fs::rename(self.root.join(from), self.root.join(&to))?;
            self.moved(from, &to);
        }
        if let Some(entry) = self.index.get_mut(id) {
            // The extension decides the language (spec 「편집기」): a new one drops the picked one.
            if !split_name(from).1.eq_ignore_ascii_case(split_name(&to).1) {
                entry.language = None;
            }
            entry.file = to;
            entry.auto_title = auto_title;
        }
        self.index.save()?;
        self.memo_info(id)
    }

    /// tote wrote `contents` to `file`: the watcher's next event there is this write.
    fn wrote(&mut self, file: &str, contents: &[u8]) {
        self.last_written
            .insert(file.to_string(), content_hash(contents));
        self.track_inode(file);
    }

    /// tote renamed `from` to `to`; the contents did not change, so neither does what counts as
    /// tote's own. A file tote has not written since opening is hashed now, or the rename would
    /// look like another app's edit — unless the editor would not open it anyway.
    fn moved(&mut self, from: &str, to: &str) {
        let hash = self.last_written.remove(from).or_else(|| {
            let path = self.root.join(to);
            let meta = fs::metadata(&path).ok()?;
            (meta.len() <= MAX_EDITOR_BYTES && kind_for(to) == FileKind::Text)
                .then(|| fs::read(&path).ok().map(|bytes| content_hash(&bytes)))
                .flatten()
        });
        if let Some(hash) = hash {
            self.last_written.insert(to.to_string(), hash);
        }
        self.inodes.remove(from);
        self.track_inode(to);
    }

    pub(super) fn track_inode(&mut self, file: &str) {
        match file_id(&self.root.join(file)) {
            Some(id) => self.inodes.insert(file.to_string(), id),
            None => self.inodes.remove(file),
        };
    }

    /// `stem.ext`, then `stem 2.ext`, … — the first name no other file in the folder uses. The
    /// file system decides what "uses" means: on APFS `Memo.md`, `memo.md` and a decomposed
    /// Hangul spelling all collide. `own` (the memo's current file) never counts as taken, which
    /// lets a memo change only the case of its name.
    fn free_name(&self, stem: &str, ext: &str, own: Option<&str>) -> String {
        let own = own.map(|file| self.root.join(file));
        unique_file_name(stem, ext, |candidate| {
            let path = self.root.join(candidate);
            path.symlink_metadata().is_ok()
                && own.as_deref().is_none_or(|own| !same_file(own, &path))
        })
    }
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let root = tempfile::tempdir().unwrap();
        let ws = Workspace::create(root.path(), "w").unwrap();
        (root, ws)
    }

    fn listed(ws: &Workspace) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(ws.root())
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn every_write_marks_the_workspace_changed() {
        let (root, mut ws) = workspace();
        assert!(ws.take_changed(), "opening marks it for the first backup");
        let check = |ws: &mut Workspace, what: &str| {
            assert!(ws.take_changed(), "{what}");
            assert!(!ws.take_changed(), "{what}, asked again");
        };
        let memo = ws.create_memo("md", b"").unwrap();
        check(&mut ws, "create");
        ws.write_memo(&memo.id, b"# memo\n").unwrap();
        check(&mut ws, "write");
        ws.retitle_memo(&memo.id, "제목").unwrap();
        check(&mut ws, "retitle");
        ws.rename_memo(&memo.id, "이름.md").unwrap();
        check(&mut ws, "rename");
        ws.set_language(&memo.id, "python", "py").unwrap();
        check(&mut ws, "language");
        ws.import_memo("b.sh", b"echo").unwrap();
        check(&mut ws, "import");
        let outside = root.path().join("c.txt");
        fs::write(&outside, "c").unwrap();
        ws.import_file(&outside).unwrap();
        check(&mut ws, "import file");
        ws.delete_memo(&memo.id).unwrap();
        check(&mut ws, "delete");

        let other = ws.import_memo("d.md", b"d").unwrap();
        assert!(ws.take_changed());
        ws.read_memo(&other.id).unwrap();
        ws.list_memos().unwrap();
        ws.memo_info(&other.id).unwrap();
        assert!(!ws.take_changed(), "reads change nothing");
    }

    #[test]
    fn set_language_renames_the_extension_and_records_the_language() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"#!/bin/sh\necho").unwrap();
        ws.retitle_memo(&memo.id, "deploy").unwrap();
        let info = ws.set_language(&memo.id, "shellscript", "sh").unwrap();
        assert_eq!(info.file, "deploy.sh");
        assert_eq!(info.language.as_deref(), Some("shellscript"));
        assert!(info.auto_title); // a language is not a name the person chose
        assert_eq!(listed(&ws), vec!["deploy.sh"]);
        // The same extension only records the language; a taken name gets a number.
        let info = ws.set_language(&memo.id, "bash", "sh").unwrap();
        assert_eq!(
            (info.file.as_str(), info.language.as_deref()),
            ("deploy.sh", Some("bash"))
        );
        ws.import_memo("deploy.py", b"").unwrap();
        let info = ws.set_language(&memo.id, "python", "py").unwrap();
        assert_eq!(info.file, "deploy 2.py");
        assert!(matches!(
            ws.set_language("nope", "x", "x"),
            Err(WorkspaceError::UnknownMemo(_))
        ));
        assert!(matches!(
            ws.set_language(&memo.id, "x", "a/b"),
            Err(WorkspaceError::InvalidName(_))
        ));
    }

    #[test]
    fn new_memos_start_untitled_and_count_up() {
        let (_root, mut ws) = workspace();
        let a = ws.create_memo("md", b"").unwrap();
        let b = ws.create_memo("md", b"").unwrap();
        assert_eq!(
            (a.file.as_str(), b.file.as_str()),
            ("untitled.md", "untitled 2.md")
        );
        assert!(a.auto_title);
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn writes_follow_the_memo_through_a_rename() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        ws.write_memo(&memo.id, "# 회의".as_bytes()).unwrap();
        ws.retitle_memo(&memo.id, "회의").unwrap();
        let info = ws.write_memo(&memo.id, "# 회의\n안건".as_bytes()).unwrap();
        assert_eq!(info.file, "회의.md");
        assert_eq!(ws.read_memo(&memo.id).unwrap(), "# 회의\n안건".as_bytes());
        assert_eq!(listed(&ws), vec!["회의.md"]);
        // A vanished file is created again under its name.
        fs::remove_file(ws.root().join("회의.md")).unwrap();
        ws.write_memo(&memo.id, b"back").unwrap();
        assert!(ws.root().join("회의.md").exists());
        assert_eq!(ws.read_memo(&memo.id).unwrap(), b"back");
    }

    #[test]
    fn an_unchanged_title_does_not_rewrite_the_index() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        ws.retitle_memo(&memo.id, "회의").unwrap();
        let index = ws.root().join(".tote/index.json");
        fs::remove_file(&index).unwrap();
        ws.retitle_memo(&memo.id, "회의").unwrap();
        assert!(!index.exists());
        ws.retitle_memo(&memo.id, "다른").unwrap();
        assert!(index.exists());
    }

    #[test]
    fn a_title_already_taken_gets_a_number() {
        let (_root, mut ws) = workspace();
        let a = ws.create_memo("md", b"").unwrap();
        let b = ws.create_memo("md", b"").unwrap();
        assert_eq!(ws.retitle_memo(&a.id, "회의").unwrap().file, "회의.md");
        assert_eq!(ws.retitle_memo(&b.id, "회의").unwrap().file, "회의 2.md");
        // Its own number is not a reason to rename again.
        assert_eq!(ws.retitle_memo(&b.id, "회의").unwrap().file, "회의 2.md");
    }

    #[test]
    fn a_case_only_title_change_renames_the_same_file() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        ws.retitle_memo(&memo.id, "memo").unwrap();
        assert_eq!(ws.retitle_memo(&memo.id, "Memo").unwrap().file, "Memo.md");
        assert_eq!(listed(&ws), vec!["Memo.md"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_title_that_differs_only_in_unicode_normalisation_counts_as_taken() {
        // Finder may write Korean names decomposed (NFD) while typed titles are composed (NFC);
        // APFS treats them as one name, so the memo must not take it.
        let (_root, mut ws) = workspace();
        let nfd = "\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}.md"; // 한글.md, decomposed
        fs::write(ws.root().join(nfd), "").unwrap();
        let memo = ws.create_memo("md", b"").unwrap();
        assert_eq!(ws.retitle_memo(&memo.id, "한글").unwrap().file, "한글 2.md");
    }

    #[test]
    fn titles_leave_manually_named_memos_alone() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        ws.rename_memo(&memo.id, "내 이름.md").unwrap();
        let info = ws.retitle_memo(&memo.id, "다른 제목").unwrap();
        assert_eq!(info.file, "내 이름.md");
        assert!(!info.auto_title);
    }

    #[test]
    fn titles_that_would_escape_the_folder_are_refused() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        for bad in ["../밖", "a/b", "", ".숨김"] {
            assert!(matches!(
                ws.retitle_memo(&memo.id, bad),
                Err(WorkspaceError::InvalidName(_))
            ));
        }
        assert_eq!(listed(&ws), vec!["untitled.md"]);
    }

    #[test]
    fn renaming_to_another_extension_forgets_the_language() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        ws.set_language(&memo.id, "python", "py").unwrap();
        // The same extension in another case still names the same language.
        let info = ws.rename_memo(&memo.id, "script.PY").unwrap();
        assert_eq!(info.language.as_deref(), Some("python"));
        let info = ws.rename_memo(&memo.id, "script.sh").unwrap();
        assert_eq!((info.file.as_str(), info.language), ("script.sh", None));
    }

    #[test]
    fn rename_refuses_a_name_another_file_has() {
        let (_root, mut ws) = workspace();
        let a = ws.create_memo("md", b"").unwrap();
        ws.import_memo("deploy.sh", b"echo").unwrap();
        assert!(matches!(
            ws.rename_memo(&a.id, "deploy.sh"),
            Err(WorkspaceError::AlreadyExists(_))
        ));
        assert!(matches!(
            ws.rename_memo(&a.id, "a/b.md"),
            Err(WorkspaceError::InvalidName(_))
        ));
    }

    #[test]
    fn delete_removes_file_and_entry_even_if_the_file_is_gone() {
        let (_root, mut ws) = workspace();
        let a = ws.create_memo("md", b"").unwrap();
        let b = ws.create_memo("md", b"").unwrap();
        ws.delete_memo(&a.id).unwrap();
        fs::remove_file(ws.root().join(&b.file)).unwrap();
        ws.delete_memo(&b.id).unwrap();
        assert!(listed(&ws).is_empty());
        assert!(matches!(
            ws.memo_info(&a.id),
            Err(WorkspaceError::UnknownMemo(_))
        ));
    }

    #[test]
    fn imports_keep_the_name_and_never_auto_title() {
        let (root, mut ws) = workspace();
        let outside = root.path().join("deploy.sh");
        fs::write(&outside, "echo hi\n").unwrap();
        let first = ws.import_file(&outside).unwrap();
        let second = ws.import_memo("deploy.sh", b"echo edited\n").unwrap();
        assert_eq!(
            (first.file.as_str(), second.file.as_str()),
            ("deploy.sh", "deploy 2.sh")
        );
        assert!(!first.auto_title && !second.auto_title);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "echo hi\n");
        assert_eq!(ws.read_memo(&second.id).unwrap(), b"echo edited\n");

        // The original's permissions do not follow the copy: a locked file imports as writable.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = root.path().join("locked.txt");
            fs::write(&locked, "x").unwrap();
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o444)).unwrap();
            let memo = ws.import_file(&locked).unwrap();
            ws.write_memo(&memo.id, b"y").unwrap();
            assert_eq!(ws.read_memo(&memo.id).unwrap(), b"y");
        }
    }

    #[test]
    fn unknown_ids_are_reported() {
        let (_root, mut ws) = workspace();
        assert!(matches!(
            ws.read_memo("x"),
            Err(WorkspaceError::UnknownMemo(_))
        ));
        assert!(matches!(
            ws.write_memo("x", b""),
            Err(WorkspaceError::UnknownMemo(_))
        ));
        assert!(matches!(
            ws.import_file(Path::new("/nonexistent/a.txt")),
            Err(WorkspaceError::Io(_))
        ));
    }

    #[test]
    fn memo_path_is_the_file_under_the_root() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        assert_eq!(
            ws.memo_path(&memo.id).unwrap(),
            ws.root().join("untitled.md")
        );
        assert!(matches!(
            ws.memo_path("nope"),
            Err(WorkspaceError::UnknownMemo(_))
        ));
    }
}
