//! Creating, saving, renaming and removing memo files. Every operation goes through the memo ID,
//! so a save that lands right after a title rename still finds the file.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::index::{file_id, MemoEntry};
use super::names::{is_valid_file_name, join_name, split_name, unique_file_name};
use super::{kind_for, FileKind, MemoInfo, Workspace, WorkspaceError};
use crate::persist::external::MAX_EDITOR_BYTES;
use crate::persist::{atomic_write, conflict, content_hash, read_text};

/// What the editor holds of a memo file: the bytes tote last read for it or wrote from it. A save
/// goes through only while the file still holds them (spec 「외부 변경」), and a change the watcher
/// sees that hashes like them is not news.
#[derive(Clone, Debug)]
pub(super) struct Held {
    pub(super) hash: String,
    /// How long those bytes are: a file of another length is told apart unread.
    len: u64,
    /// The file as it stood holding them. A file that still looks like this is not read to be
    /// compared; `None` once it is known to hold something else.
    seen: Option<Stamp>,
}

impl Held {
    fn of(bytes: &[u8], seen: Option<Stamp>) -> Held {
        let len = bytes.len() as u64;
        Held {
            hash: content_hash(bytes),
            len,
            seen: seen.filter(|stamp| stamp.len == len),
        }
    }
}

/// What tells a file was not written since it was looked at: which file it is, its length and its
/// modification time. Replacing the file by a rename changes the first, writing into it the last.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Stamp {
    file: (u64, u64),
    len: u64,
    modified: Option<SystemTime>,
}

impl Stamp {
    fn of(meta: &fs::Metadata) -> Stamp {
        Stamp {
            file: device_and_inode(meta),
            len: meta.len(),
            modified: meta.modified().ok(),
        }
    }
}

#[cfg(unix)]
fn device_and_inode(meta: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(not(unix))]
fn device_and_inode(_meta: &fs::Metadata) -> (u64, u64) {
    (0, 0)
}

/// A memo this long is not an empty new memo, whatever it holds (`Workspace::delete_memo`).
const BLANK_LIMIT: u64 = 1024 * 1024;

impl Workspace {
    pub fn create_memo(&mut self, ext: &str, contents: &[u8]) -> Result<MemoInfo, WorkspaceError> {
        let file = self.free_name("untitled", ext, None);
        self.add_memo(file, true, contents)
    }

    pub fn memo_path(&self, id: &str) -> Result<PathBuf, WorkspaceError> {
        Ok(self.root.join(&self.entry(id)?.file))
    }

    /// The memo's bytes for the editor, which holds them from here on (`Held`). Refused after its
    /// first bytes when the memo is not text (`read_text`): a video in the workspace under a text
    /// name is not loaded to be turned away by the page.
    pub fn read_memo(&mut self, id: &str) -> Result<Vec<u8>, WorkspaceError> {
        let file = self.entry(id)?.file.clone();
        // Looked at before the read: a write landing in between leaves a stamp that no longer
        // fits, and the next save reads the file to compare instead of trusting it.
        let seen = self.stamp(&file);
        let bytes = read_text(&self.root.join(&file))?;
        self.last_written.insert(file, Held::of(&bytes, seen));
        Ok(bytes)
    }

    /// Writes by ID — unless the file holds something the editor does not (`holds_another`):
    /// refused then as `persist::Conflict`, with the file left as it is. A file deleted under us
    /// is written again: the editor's text is the newest copy there is.
    pub fn write_memo(&mut self, id: &str, contents: &[u8]) -> Result<MemoInfo, WorkspaceError> {
        let file = self.entry(id)?.file.clone();
        if self.holds_another(&file, contents) {
            return Err(conflict().into());
        }
        self.write_file(id, &file, contents)
    }

    /// `write_memo` whatever the file holds: the person chose their text over it (「내 버전」,
    /// 「다시 저장」).
    pub fn overwrite_memo(
        &mut self,
        id: &str,
        contents: &[u8],
    ) -> Result<MemoInfo, WorkspaceError> {
        let file = self.entry(id)?.file.clone();
        self.write_file(id, &file, contents)
    }

    fn write_file(
        &mut self,
        id: &str,
        file: &str,
        contents: &[u8],
    ) -> Result<MemoInfo, WorkspaceError> {
        self.mark_changed();
        atomic_write(&self.root.join(file), contents)?;
        self.wrote(file, contents);
        self.memo_info(id)
    }

    /// Whether saving `contents` to `file` would write over text the editor has not seen: the file
    /// is there and holds neither what the editor holds (`Held`) nor `contents` itself. A memo the
    /// editor never read counts — a save of it is an edit of nothing.
    ///
    /// The watcher would report the same edit, but up to `watch::BATCH_DELAY` later, and a save in
    /// between would go over it. Between this look and the write's rename there is still a moment
    /// nothing guards.
    fn holds_another(&mut self, file: &str, contents: &[u8]) -> bool {
        let path = self.root.join(file);
        // Gone: written again. Any other failure is the write's to report.
        let Ok(meta) = fs::metadata(&path) else {
            return false;
        };
        let now = Stamp::of(&meta);
        let held = self.last_written.get_mut(file);
        if held.as_ref().is_some_and(|held| held.seen == Some(now)) {
            return false;
        }
        let may_be = |len: u64| len == now.len;
        let held_len = held.as_ref().map(|held| held.len);
        if !held_len.is_some_and(may_be) && !may_be(contents.len() as u64) {
            return true;
        }
        let Ok(disk) = fs::read(&path).map(|bytes| content_hash(&bytes)) else {
            return false;
        };
        match held {
            // Written again with the same bytes: what it looks like now is remembered.
            Some(held) if held.hash == disk => {
                held.seen = Some(now);
                false
            }
            _ => disk != content_hash(contents),
        }
    }

    /// Whether `file` still holds what the editor holds, read to be sure: the watcher reported it.
    /// When it does not, the editor's text stays what the next save is measured against, and the
    /// file is not trusted by its looks again.
    pub(super) fn still_held(&mut self, file: &str) -> bool {
        let path = self.root.join(file);
        let Some(held) = self.last_written.get_mut(file) else {
            return false;
        };
        let meta = fs::metadata(&path).ok();
        let same = meta.as_ref().is_some_and(|meta| meta.len() == held.len)
            && fs::read(&path).is_ok_and(|bytes| content_hash(&bytes) == held.hash);
        held.seen = meta.filter(|_| same).map(|meta| Stamp::of(&meta));
        same
    }

    /// The files the editor holds something of, for looking at them all again (`Flag::Rescan`).
    pub fn held_files(&self) -> Vec<String> {
        self.last_written.keys().cloned().collect()
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
    /// is not a name the person typed. A language the editor `detected` leaves a memo the person
    /// named as it is: a tab may detect before it hears of a rename another window made.
    pub fn set_language(
        &mut self,
        id: &str,
        language: &str,
        ext: &str,
        detected: bool,
    ) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?.clone();
        if detected && !entry.auto_title {
            return self.memo_info(id);
        }
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

    /// Pins the memo to the top of the memo list, or lets it go (spec 2026-10-30 「고정」). The
    /// index keeps it, so it follows the memo through renames and into backups.
    pub fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<MemoInfo, WorkspaceError> {
        let entry = self
            .index
            .get_mut(id)
            .ok_or_else(|| WorkspaceError::UnknownMemo(id.to_string()))?;
        if entry.pinned != pinned {
            entry.pinned = pinned;
            self.mark_changed();
            self.index.save()?;
        }
        self.memo_info(id)
    }

    /// Removes an empty memo for good — the new memo a tab closed without a word in it (spec
    /// 「세션」). `false`, with the memo left in place, when its file holds text: another app wrote
    /// into it and the watcher has not said so yet.
    pub fn delete_memo(&mut self, id: &str) -> Result<bool, WorkspaceError> {
        let file = self.entry(id)?.file.clone();
        if !is_blank(&self.root.join(&file))? {
            return Ok(false);
        }
        self.mark_changed();
        match fs::remove_file(self.root.join(&file)) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        self.went_out(&file);
        self.index.remove(id);
        self.index.save()?;
        if let Some(viewed) = self.viewed.as_mut() {
            viewed.retain(|each| each != id);
        }
        Ok(true)
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
    /// The bytes go from file to file (`copy_in`), so `tote --import` of a file of gigabytes holds
    /// a buffer of it and never the whole.
    pub fn import_file(&mut self, path: &Path) -> Result<MemoInfo, WorkspaceError> {
        let mut source = File::open(path)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| WorkspaceError::InvalidName(path.display().to_string()))?;
        if !is_valid_file_name(name) {
            return Err(WorkspaceError::InvalidName(name.to_string()));
        }
        let (stem, ext) = split_name(name);
        let file = self.free_name(stem, ext, None);
        self.add_copy(file, false, &mut source)
    }

    /// `create_memo` with the bytes of a file on disk — the text `tote -` parked — copied as
    /// `import_file` copies; the file itself is not touched.
    pub fn create_memo_from_file(
        &mut self,
        ext: &str,
        path: &Path,
    ) -> Result<MemoInfo, WorkspaceError> {
        let mut source = File::open(path)?;
        let file = self.free_name("untitled", ext, None);
        self.add_copy(file, true, &mut source)
    }

    /// `add_memo` for bytes that are read as they are written. What counts as tote's own write
    /// is hashed from the new file once it is there, as for a memo back from the trash
    /// (`came_in`): a copy the editor would not open is not read again at all.
    fn add_copy(
        &mut self,
        file: String,
        auto_title: bool,
        source: &mut impl Read,
    ) -> Result<MemoInfo, WorkspaceError> {
        self.mark_changed();
        copy_in(source, &self.root.join(&file))?;
        self.came_in(&file);
        let id = uuid::Uuid::new_v4().to_string();
        self.index.insert(
            id.clone(),
            MemoEntry {
                file,
                auto_title,
                language: None,
                pinned: false,
            },
        );
        self.index.save()?;
        self.memo_info(&id)
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
                pinned: false,
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

    /// tote wrote `contents` to `file`: the editor holds them, and the watcher's next event there
    /// is this write.
    fn wrote(&mut self, file: &str, contents: &[u8]) {
        let seen = self.stamp(file);
        self.last_written
            .insert(file.to_string(), Held::of(contents, seen));
        self.track_inode(file);
    }

    /// tote renamed `from` to `to`; the contents did not change, so neither does what the editor
    /// holds. A file tote has neither read nor written since opening is hashed now, or the rename
    /// would look like another app's edit — unless the editor would not open it anyway.
    fn moved(&mut self, from: &str, to: &str) {
        let held = self.last_written.remove(from).or_else(|| self.held_now(to));
        if let Some(held) = held {
            self.last_written.insert(to.to_string(), held);
        }
        self.inodes.remove(from);
        self.track_inode(to);
    }

    /// tote moved `file` in from outside the folder the watcher looks at (a memo back from the
    /// trash): its next event there is this move, as for `moved`.
    pub(super) fn came_in(&mut self, file: &str) {
        match self.held_now(file) {
            Some(held) => self.last_written.insert(file.to_string(), held),
            None => self.last_written.remove(file),
        };
        self.track_inode(file);
    }

    /// `file` left the workspace by tote's hand (removed, or moved to the trash): nothing of it is
    /// tote's own any more.
    pub(super) fn went_out(&mut self, file: &str) {
        self.last_written.remove(file);
        self.inodes.remove(file);
    }

    /// `file` as it is now, when the editor would open it.
    fn held_now(&self, file: &str) -> Option<Held> {
        let path = self.root.join(file);
        let meta = fs::metadata(&path).ok()?;
        (meta.len() <= MAX_EDITOR_BYTES && kind_for(file) == FileKind::Text)
            .then(|| fs::read(&path).ok())
            .flatten()
            .map(|bytes| Held::of(&bytes, Some(Stamp::of(&meta))))
    }

    fn stamp(&self, file: &str) -> Option<Stamp> {
        fs::metadata(self.root.join(file))
            .ok()
            .map(|meta| Stamp::of(&meta))
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
    pub(super) fn free_name(&self, stem: &str, ext: &str, own: Option<&str>) -> String {
        let own = own.map(|file| self.root.join(file));
        unique_file_name(stem, ext, |candidate| {
            let path = self.root.join(candidate);
            path.symlink_metadata().is_ok()
                && own.as_deref().is_none_or(|own| !same_file(own, &path))
        })
    }
}

/// Whether the file at `path` is blank as the editor counts it (`isBlank` in src/app/docs.ts):
/// nothing but white space, a byte order mark aside. A missing file is; bytes that are not UTF-8
/// and a file over `BLANK_LIMIT` are not.
fn is_blank(path: &Path) -> io::Result<bool> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(err) => return Err(err),
    };
    if meta.len() > BLANK_LIMIT {
        return Ok(false);
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(err) => return Err(err),
    };
    Ok(std::str::from_utf8(&bytes)
        .is_ok_and(|text| text.chars().all(|c| c.is_whitespace() || c == '\u{feff}')))
}

/// Copies what is left of `source` into a new file at `to` a buffer at a time, the way
/// `atomic_write` puts bytes there: into a temporary file beside it (one `is_temp_file` knows, so
/// no listing takes it for a memo and the next open of the workspace removes one left behind),
/// renamed in once it is whole and on disk. A copy cut short leaves nothing. The new file has a
/// new file's permissions, not the source's: a locked original imports as a memo that saves.
fn copy_in(source: &mut impl Read, to: &Path) -> io::Result<()> {
    let temp = to.with_file_name(format!(".tote-tmp-{}", uuid::Uuid::new_v4().simple()));
    let copied = File::create_new(&temp)
        .and_then(|mut file| {
            io::copy(source, &mut file)?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&temp, to));
    if copied.is_err() {
        let _ = fs::remove_file(&temp);
    }
    copied
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
    fn a_detected_language_leaves_a_name_the_person_chose() {
        let (_root, mut ws) = workspace();
        let named = ws.import_memo("notes.md", b"#!/bin/sh").unwrap();
        let info = ws
            .set_language(&named.id, "shellscript", "sh", true)
            .unwrap();
        assert_eq!((info.file.as_str(), info.language), ("notes.md", None));
        // Picked in the status bar: it changes.
        let info = ws
            .set_language(&named.id, "shellscript", "sh", false)
            .unwrap();
        assert_eq!(info.file, "notes.sh");
        let titled = ws.create_memo("md", b"#!/bin/sh").unwrap();
        let info = ws
            .set_language(&titled.id, "shellscript", "sh", true)
            .unwrap();
        assert_eq!(info.language.as_deref(), Some("shellscript"));
        assert!(info.file.ends_with(".sh"), "{}", info.file);
    }

    #[test]
    fn pinned_survives_a_rename() {
        let (_root, mut ws) = workspace();
        let memo = ws.import_memo("가.md", b"x").unwrap();
        assert!(!memo.pinned);
        assert!(ws.set_pinned(&memo.id, true).unwrap().pinned);
        ws.rename_memo(&memo.id, "나.md").unwrap();
        assert!(ws.memo_info(&memo.id).unwrap().pinned);
        let reopened = Workspace::open(ws.root()).unwrap();
        assert!(reopened.memo_info(&memo.id).unwrap().pinned);
        assert!(!ws.set_pinned(&memo.id, false).unwrap().pinned);
        let index = fs::read_to_string(ws.root().join(".tote/index.json")).unwrap();
        assert!(!index.contains("pinned"), "{index}");
    }

    #[test]
    fn deleting_a_pinned_memo_drops_its_entry() {
        let (_root, mut ws) = workspace();
        let memo = ws.import_memo("가.md", b"").unwrap();
        ws.set_pinned(&memo.id, true).unwrap();
        assert!(ws.delete_memo(&memo.id).unwrap());
        assert!(matches!(
            ws.set_pinned(&memo.id, true),
            Err(WorkspaceError::UnknownMemo(_))
        ));
        let index = fs::read_to_string(ws.root().join(".tote/index.json")).unwrap();
        assert!(!index.contains("pinned"), "{index}");
    }

    #[test]
    fn a_memo_that_is_not_text_is_refused_unread() {
        let (_root, mut ws) = workspace();
        let video = ws.import_memo("녹화.ts", b"G\0\x11\x10").unwrap();
        let err = ws.read_memo(&video.id).unwrap_err();
        let WorkspaceError::Io(io) = &err else {
            panic!("{err}");
        };
        assert!(crate::persist::is_not_text(io), "{err}");
        let text = ws.import_memo("a.ts", b"const a = 1;").unwrap();
        assert_eq!(ws.read_memo(&text.id).unwrap(), b"const a = 1;");
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
        ws.set_language(&memo.id, "python", "py", false).unwrap();
        check(&mut ws, "language");
        ws.import_memo("b.sh", b"echo").unwrap();
        check(&mut ws, "import");
        let outside = root.path().join("c.txt");
        fs::write(&outside, "c").unwrap();
        ws.import_file(&outside).unwrap();
        check(&mut ws, "import file");
        // Only an empty memo is removed.
        ws.write_memo(&memo.id, b"").unwrap();
        ws.take_changed();
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
        let info = ws
            .set_language(&memo.id, "shellscript", "sh", false)
            .unwrap();
        assert_eq!(info.file, "deploy.sh");
        assert_eq!(info.language.as_deref(), Some("shellscript"));
        assert!(info.auto_title); // a language is not a name the person chose
        assert_eq!(listed(&ws), vec!["deploy.sh"]);
        // The same extension only records the language; a taken name gets a number.
        let info = ws.set_language(&memo.id, "bash", "sh", false).unwrap();
        assert_eq!(
            (info.file.as_str(), info.language.as_deref()),
            ("deploy.sh", Some("bash"))
        );
        ws.import_memo("deploy.py", b"").unwrap();
        let info = ws.set_language(&memo.id, "python", "py", false).unwrap();
        assert_eq!(info.file, "deploy 2.py");
        assert!(matches!(
            ws.set_language("nope", "x", "x", false),
            Err(WorkspaceError::UnknownMemo(_))
        ));
        assert!(matches!(
            ws.set_language(&memo.id, "x", "a/b", false),
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
        ws.set_language(&memo.id, "python", "py", false).unwrap();
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

    /// Another app's write the watcher has not reported yet.
    fn elsewhere(ws: &Workspace, file: &str, contents: &str) {
        fs::write(ws.root().join(file), contents).unwrap();
    }

    fn refused(result: Result<MemoInfo, WorkspaceError>) -> bool {
        matches!(&result, Err(WorkspaceError::Io(err)) if crate::persist::is_conflict(err))
    }

    fn on_disk(ws: &Workspace, file: &str) -> String {
        fs::read_to_string(ws.root().join(file)).unwrap()
    }

    #[test]
    fn a_save_over_another_apps_edit_is_refused() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"ours").unwrap();
        // The same length, written in place: only the time tells.
        elsewhere(&ws, &memo.file, "them");
        ws.take_changed();
        assert!(refused(ws.write_memo(&memo.id, b"ours!")));
        assert_eq!(on_disk(&ws, &memo.file), "them");
        assert!(!ws.take_changed(), "nothing was written");
        // Asked again, the answer is the same: the refusal did not make the file tote's.
        assert!(refused(ws.write_memo(&memo.id, b"ours!")));
        // 「내 버전」 writes over it, and the saves after that are tote's own again.
        ws.overwrite_memo(&memo.id, b"ours!").unwrap();
        assert_eq!(on_disk(&ws, &memo.file), "ours!");
        ws.write_memo(&memo.id, b"ours!!").unwrap();
        assert_eq!(on_disk(&ws, &memo.file), "ours!!");

        // Replaced by a rename, as an atomic save does it.
        let temp = ws.root().join(".other-app-tmp");
        fs::write(&temp, "replaced").unwrap();
        fs::rename(&temp, ws.root().join(&memo.file)).unwrap();
        assert!(refused(ws.write_memo(&memo.id, b"ours!!!")));
        assert_eq!(on_disk(&ws, &memo.file), "replaced");
    }

    #[test]
    fn the_watchers_report_does_not_make_another_apps_edit_ours() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"ours").unwrap();
        elsewhere(&ws, &memo.file, "theirs");
        let seen = [memo.file.clone()].into();
        assert_eq!(
            ws.apply_fs_events(&seen, &[]).unwrap(),
            vec![super::super::Change::Modified {
                id: memo.id.clone()
            }]
        );
        // The editor still holds the old text until it reads the file.
        assert!(refused(ws.write_memo(&memo.id, b"ours!")));
        assert_eq!(on_disk(&ws, &memo.file), "theirs");
        assert_eq!(ws.read_memo(&memo.id).unwrap(), b"theirs");
        ws.write_memo(&memo.id, b"theirs!").unwrap();
        assert_eq!(on_disk(&ws, &memo.file), "theirs!");
    }

    #[test]
    fn an_edit_the_files_looks_do_not_show_is_refused_once_the_watcher_has_read_it() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"ours").unwrap();
        let path = ws.root().join(&memo.file);
        // Written in place with the same length and the time put back, as on a file system whose
        // times are too coarse to tell two writes apart: nothing a look at the file shows.
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        std::io::Write::write_all(&mut &file, b"them").unwrap();
        file.set_modified(before).unwrap();
        drop(file);
        // The watcher reads what it reports, and from then on the file is not trusted by its looks.
        let seen = [memo.file.clone()].into();
        assert_eq!(ws.apply_fs_events(&seen, &[]).unwrap().len(), 1);
        assert!(refused(ws.write_memo(&memo.id, b"ours!")));
        assert_eq!(on_disk(&ws, &memo.file), "them");
    }

    #[test]
    fn a_save_goes_through_when_the_file_holds_what_the_editor_has() {
        let (_root, mut ws) = workspace();
        // A new memo, then tote's own writes one after another.
        let memo = ws.create_memo("md", b"").unwrap();
        ws.write_memo(&memo.id, "# 회의".as_bytes()).unwrap();
        ws.write_memo(&memo.id, "# 회의\n".as_bytes()).unwrap();
        // tote's own renames: the title, the language, a name the person typed.
        ws.retitle_memo(&memo.id, "회의").unwrap();
        ws.write_memo(&memo.id, "# 회의\n1".as_bytes()).unwrap();
        ws.set_language(&memo.id, "python", "py", false).unwrap();
        ws.write_memo(&memo.id, "# 회의\n2".as_bytes()).unwrap();
        ws.rename_memo(&memo.id, "안건.md").unwrap();
        ws.write_memo(&memo.id, "# 회의\n3".as_bytes()).unwrap();
        // Back from the trash.
        ws.trash_memo(&memo.id, 1).unwrap();
        let back = ws.restore_memo(&memo.id).unwrap();
        ws.write_memo(&memo.id, "# 회의\n4".as_bytes()).unwrap();
        assert_eq!(on_disk(&ws, &back.file), "# 회의\n4");
        // Made with its text, as `tote -` makes one.
        let piped = ws.import_memo("log.txt", b"piped").unwrap();
        ws.write_memo(&piped.id, b"piped, edited").unwrap();

        // Another app's edit the editor has read is what it holds now.
        elsewhere(&ws, &piped.file, "theirs");
        assert_eq!(ws.read_memo(&piped.id).unwrap(), b"theirs");
        ws.write_memo(&piped.id, b"theirs, edited").unwrap();
        // Written again with the same bytes (a sync tool, `touch`): nothing the editor lacks.
        elsewhere(&ws, &piped.file, "theirs, edited");
        ws.write_memo(&piped.id, b"more").unwrap();
        // Another app wrote the very text about to be saved.
        elsewhere(&ws, &piped.file, "the same");
        ws.write_memo(&piped.id, b"the same").unwrap();
        assert_eq!(on_disk(&ws, &piped.file), "the same");

        // Another app renamed it: the name changed, the text did not.
        fs::rename(ws.root().join("log.txt"), ws.root().join("일지.txt")).unwrap();
        let seen = ["log.txt".to_string(), "일지.txt".to_string()].into();
        ws.apply_fs_events(&seen, &[]).unwrap();
        ws.write_memo(&piped.id, b"renamed").unwrap();
        assert_eq!(on_disk(&ws, "일지.txt"), "renamed");
    }

    #[test]
    fn a_memo_copied_in_is_saved_without_being_read_first() {
        let (root, mut ws) = workspace();
        // Imported from a file, and the text `tote -` parked: the tab that takes one over may
        // save before it ever reads the memo.
        let outside = root.path().join("deploy.sh");
        fs::write(&outside, "echo hi\n").unwrap();
        let imported = ws.import_file(&outside).unwrap();
        ws.write_memo(&imported.id, b"echo hi\necho more\n")
            .unwrap();
        let piped = ws.create_memo_from_file("md", &outside).unwrap();
        ws.write_memo(&piped.id, b"# piped\n").unwrap();
        assert_eq!(on_disk(&ws, &piped.file), "# piped\n");

        // A copy the editor would not open (by its kind here; one over the editor's limit goes
        // the same way) is not hashed, so the editor holds nothing of it: a save is refused until
        // it is read — 「텍스트로 열기」 — and the watcher still reports a change to it.
        let picture = root.path().join("그림.png");
        fs::write(&picture, "not really a picture").unwrap();
        let unread = ws.import_file(&picture).unwrap();
        assert_eq!(ws.last_written(&unread.file), None);
        assert!(refused(ws.write_memo(&unread.id, b"blind")));
        assert_eq!(on_disk(&ws, &unread.file), "not really a picture");
        assert_eq!(ws.read_memo(&unread.id).unwrap(), b"not really a picture");
        ws.write_memo(&unread.id, b"read, then edited").unwrap();
    }

    #[test]
    fn a_save_follows_a_rename_the_memo_list_found_before_the_watcher() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"ours").unwrap();
        fs::rename(ws.root().join(&memo.file), ws.root().join("이름.md")).unwrap();
        // The listing pairs the rename by inode; what the editor holds goes with the name.
        let listed_as = ws.list_memos().unwrap();
        assert_eq!(listed_as[0].file, "이름.md");
        ws.write_memo(&memo.id, b"ours, edited").unwrap();
        assert_eq!(on_disk(&ws, "이름.md"), "ours, edited");
        assert_eq!(listed(&ws), vec!["이름.md"]);
        // The watcher's batch for the rename, late, has nothing left to say.
        let seen = ["untitled.md".to_string(), "이름.md".to_string()].into();
        assert_eq!(ws.apply_fs_events(&seen, &[]).unwrap(), vec![]);
    }

    #[test]
    fn a_memo_whose_id_the_index_replaced_is_saved_once_read() {
        let (_root, ws) = workspace();
        fs::write(ws.root().join("옛.md"), "old").unwrap();
        fs::write(
            ws.root().join(".tote/index.json"),
            r#"{"version":1,"memos":{"../밖":{"file":"옛.md","autoTitle":false}}}"#,
        )
        .unwrap();
        // Opening gives the entry an ID tote makes; nothing is held of any file yet.
        let mut ws = Workspace::open(ws.root()).unwrap();
        let memo = ws.list_memos().unwrap().remove(0);
        assert_ne!(memo.id, "../밖");
        assert_eq!(ws.read_memo(&memo.id).unwrap(), b"old");
        ws.write_memo(&memo.id, b"old, edited").unwrap();
        assert_eq!(on_disk(&ws, "옛.md"), "old, edited");
    }

    #[test]
    fn a_memo_there_before_the_workspace_opened_is_saved_once_read() {
        let (_root, ws) = workspace();
        fs::write(ws.root().join("옛.md"), "old").unwrap();
        let mut ws = Workspace::open(ws.root()).unwrap();
        let old = ws.list_memos().unwrap().remove(0);
        // Never read: there is no text of it the save could be an edit of.
        assert!(refused(ws.write_memo(&old.id, b"blind")));
        assert_eq!(ws.read_memo(&old.id).unwrap(), b"old");
        ws.write_memo(&old.id, b"old, edited").unwrap();
        assert_eq!(on_disk(&ws, "옛.md"), "old, edited");
    }

    #[test]
    fn delete_leaves_a_file_another_app_wrote_into() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        elsewhere(&ws, &memo.file, "theirs");
        ws.take_changed();
        assert!(!ws.delete_memo(&memo.id).unwrap());
        assert_eq!(on_disk(&ws, &memo.file), "theirs");
        assert_eq!(ws.memo_info(&memo.id).unwrap().file, memo.file);
        assert!(!ws.take_changed(), "nothing was removed");
        // Blank as the editor counts it — spaces, line ends, a byte order mark — still goes.
        elsewhere(&ws, &memo.file, "\u{feff} \n\t\u{3000}\r\n");
        assert!(ws.delete_memo(&memo.id).unwrap());
        assert!(listed(&ws).is_empty());
        // Bytes that are not text are not blank.
        let binary = ws.create_memo("md", b"").unwrap();
        fs::write(ws.root().join(&binary.file), [0xff, 0xfe]).unwrap();
        assert!(!ws.delete_memo(&binary.id).unwrap());
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
    fn a_file_is_copied_in_as_it_is_read_not_held_whole() {
        /// 4 MiB that, once half is handed out, looks at what the copy has put in the folder so
        /// far: nothing when the source is read to its end before anything is written.
        struct Source<'a> {
            left: usize,
            folder: &'a Path,
            halfway: Option<Vec<(String, u64)>>,
        }
        const TOTAL: usize = 4 << 20;
        fn entries(folder: &Path) -> Vec<(String, u64)> {
            fs::read_dir(folder)
                .unwrap()
                .map(|entry| {
                    let entry = entry.unwrap();
                    let name = entry.file_name().into_string().unwrap();
                    (name, entry.metadata().unwrap().len())
                })
                .collect()
        }
        impl Read for Source<'_> {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.left <= TOTAL / 2 && self.halfway.is_none() {
                    self.halfway = Some(entries(self.folder));
                }
                let n = buf.len().min(self.left).min(64 << 10);
                buf[..n].fill(b'a');
                self.left -= n;
                Ok(n)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let to = dir.path().join("큰 파일.log");
        let mut source = Source {
            left: TOTAL,
            folder: dir.path(),
            halfway: None,
        };
        copy_in(&mut source, &to).unwrap();
        assert_eq!(
            entries(dir.path()),
            vec![("큰 파일.log".to_string(), TOTAL as u64)]
        );
        // Halfway there was one file, a temporary one no listing shows, with what had come so far.
        let halfway = source.halfway.unwrap();
        assert_eq!(halfway.len(), 1, "{halfway:?}");
        let (name, size) = &halfway[0];
        assert!(crate::persist::is_temp_file(name), "{name}");
        assert!(
            *size >= (TOTAL / 4) as u64,
            "{size} bytes were on disk halfway"
        );

        // A source that fails leaves nothing behind, and no memo.
        struct Broken(bool);
        impl Read for Broken {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if std::mem::replace(&mut self.0, true) {
                    return Err(io::Error::other("the disk went"));
                }
                buf.fill(b'b');
                Ok(buf.len())
            }
        }
        let (_root, mut ws) = workspace();
        assert!(matches!(
            ws.add_copy("깨진.txt".into(), false, &mut Broken(false)),
            Err(WorkspaceError::Io(_))
        ));
        assert!(listed(&ws).is_empty());
        assert!(ws.list_memos().unwrap().is_empty());
        let hidden: Vec<String> = entries(ws.root())
            .into_iter()
            .map(|(name, _)| name)
            .filter(|name| name != ".tote")
            .collect();
        assert!(hidden.is_empty(), "{hidden:?}");
    }

    #[test]
    fn a_file_copied_in_counts_as_totes_own_write() {
        let (root, mut ws) = workspace();
        let outside = root.path().join("deploy.sh");
        let text = "echo hi\n".repeat(20_000); // more than one buffer of the copy
        fs::write(&outside, &text).unwrap();
        let memo = ws.import_file(&outside).unwrap();
        // Before any read: reading the memo would make it the editor's just as well.
        assert_eq!(
            ws.last_written("deploy.sh"),
            Some(content_hash(text.as_bytes()).as_str())
        );
        // The watcher's event for the copy is not taken for another app's change.
        let touched = std::collections::BTreeSet::from(["deploy.sh".to_string()]);
        assert_eq!(ws.apply_fs_events(&touched, &[]).unwrap(), vec![]);
        assert_eq!(ws.read_memo(&memo.id).unwrap(), text.as_bytes());

        // Text parked by `tote -` becomes an untitled memo the same way, and stays where it was.
        let parked = root.path().join("0123abcd.txt");
        fs::write(&parked, "# 파이프한 글\n").unwrap();
        let memo = ws.create_memo_from_file("md", &parked).unwrap();
        assert_eq!((memo.file.as_str(), memo.auto_title), ("untitled.md", true));
        assert_eq!(
            ws.read_memo(&memo.id).unwrap(),
            "# 파이프한 글\n".as_bytes()
        );
        assert!(parked.exists());
        assert!(matches!(
            ws.create_memo_from_file("md", Path::new("/nonexistent/a.txt")),
            Err(WorkspaceError::Io(_))
        ));
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
