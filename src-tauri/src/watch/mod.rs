//! Watching open workspaces and external files for changes other apps make (spec 「외부 변경」).
//! notify's events are gathered for `BATCH_DELAY` on a thread of their own and handed on per
//! target: the files of each workspace folder, and each external file alone.
//!
//! macOS FSEvents shapes what is here (seen with notify's recommended watcher on a `tempdir`,
//! non-recursive, over plain writes, `fs::rename` and tote's atomic writes): event paths are
//! canonical (`/private/var/…` for a `/var/…` folder), the watched folder itself reports a couple
//! of events right after watching starts, and a rename is never paired — each of its paths comes
//! alone as `Modify(Name(Any))`. So folders are canonicalised before they are watched and compared,
//! only entries directly inside a workspace folder count, and renames are found by inode in
//! `Workspace::apply_fs_events`. The pairing below (`RenameMode::Both`, or `From`/`To` by tracker)
//! is for other platforms; nothing on macOS reaches it, so only unit tests hold it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::event::{EventKind, ModifyKind, RenameMode};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher as _};

use crate::app::lock;

/// How long events are gathered after the first one. One save is a handful of events within a
/// few milliseconds — the first one came at most 21ms after a write, rename or atomic write, with
/// eight watchers running and the CPU loaded — so it arrives as one batch.
pub const BATCH_DELAY: Duration = Duration::from_millis(200);

/// Who a batch is for: a window's workspace, or an external file a window shows (by the path the
/// window knows it by).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum WatchTarget {
    Workspace(String),
    External(String, PathBuf),
}

/// The canonical paths one target saw changing during one batch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Batch {
    pub touched: BTreeSet<PathBuf>,
    /// From → to pairs the platform reported as one rename.
    pub renames: Vec<(PathBuf, PathBuf)>,
}

pub struct Watcher {
    notify: Mutex<RecommendedWatcher>,
    targets: Arc<Mutex<Targets>>,
}

#[derive(Default)]
struct Targets {
    /// Watched folder → how many targets need it: a workspace and an external file in it, or
    /// several external files side by side, share one watch.
    folders: HashMap<PathBuf, usize>,
    /// Window label → its workspace folder, canonical.
    workspaces: HashMap<String, PathBuf>,
    /// (window label, path as the window knows it) → the canonical path, and how many times the
    /// window asked for it.
    externals: HashMap<(String, PathBuf), (PathBuf, usize)>,
}

impl Watcher {
    pub fn new(on_batch: impl Fn(WatchTarget, Batch) + Send + 'static) -> notify::Result<Watcher> {
        let (sender, events) = mpsc::channel();
        let notify = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })?;
        let targets = Arc::new(Mutex::new(Targets::default()));
        let shared = targets.clone();
        // The thread ends when the watcher is dropped: that drops the sender with it.
        std::thread::Builder::new()
            .name("tote-watch".into())
            .spawn(move || gather(&events, &shared, on_batch))?;
        Ok(Watcher {
            notify: Mutex::new(notify),
            targets,
        })
    }

    /// The files directly in `root`; a label already watching another folder moves to this one.
    pub fn watch_workspace(&self, label: &str, root: &Path) -> notify::Result<()> {
        let root = fs::canonicalize(root)?;
        let mut targets = lock(&self.targets);
        if targets.workspaces.get(label) == Some(&root) {
            return Ok(());
        }
        self.hold(&mut targets, &root)?;
        if let Some(old) = targets.workspaces.insert(label.to_string(), root) {
            self.release(&mut targets, &old);
        }
        Ok(())
    }

    pub fn unwatch_workspace(&self, label: &str) {
        let mut targets = lock(&self.targets);
        if let Some(root) = targets.workspaces.remove(label) {
            self.release(&mut targets, &root);
        }
    }

    /// The file at `path` (which may not exist yet), for the window `label`: its folder is
    /// watched and only this path is passed on. Counted, so each call needs an `unwatch_external`.
    pub fn watch_external(&self, label: &str, path: &Path) -> notify::Result<()> {
        let key = (label.to_string(), path.to_path_buf());
        let mut targets = lock(&self.targets);
        if let Some((_, count)) = targets.externals.get_mut(&key) {
            *count += 1;
            return Ok(());
        }
        let canonical = canonical_file(path)?;
        self.hold(&mut targets, parent(&canonical))?;
        targets.externals.insert(key, (canonical, 1));
        Ok(())
    }

    pub fn unwatch_external(&self, label: &str, path: &Path) {
        let key = (label.to_string(), path.to_path_buf());
        let mut targets = lock(&self.targets);
        let Some((canonical, count)) = targets.externals.get_mut(&key) else {
            return;
        };
        *count -= 1;
        if *count == 0 {
            let canonical = canonical.clone();
            targets.externals.remove(&key);
            self.release(&mut targets, parent(&canonical));
        }
    }

    /// The window is gone: its workspace and every external file it asked for.
    pub fn unwatch_window(&self, label: &str) {
        self.unwatch_workspace(label);
        let mut targets = lock(&self.targets);
        let theirs: Vec<(String, PathBuf)> = targets
            .externals
            .keys()
            .filter(|(owner, _)| owner == label)
            .cloned()
            .collect();
        for key in theirs {
            if let Some((canonical, _)) = targets.externals.remove(&key) {
                self.release(&mut targets, parent(&canonical));
            }
        }
    }

    fn hold(&self, targets: &mut Targets, folder: &Path) -> notify::Result<()> {
        if let Some(count) = targets.folders.get_mut(folder) {
            *count += 1;
            return Ok(());
        }
        lock(&self.notify).watch(folder, RecursiveMode::NonRecursive)?;
        targets.folders.insert(folder.to_path_buf(), 1);
        Ok(())
    }

    fn release(&self, targets: &mut Targets, folder: &Path) {
        let Some(count) = targets.folders.get_mut(folder) else {
            return;
        };
        *count -= 1;
        if *count == 0 {
            targets.folders.remove(folder);
            if let Err(err) = lock(&self.notify).unwatch(folder) {
                eprintln!("tote: could not stop watching {}: {err}", folder.display());
            }
        }
    }
}

/// `path` with its folder canonicalised; the file itself need not exist.
fn canonical_file(path: &Path) -> io::Result<PathBuf> {
    match (path.parent(), path.file_name()) {
        (Some(folder), Some(name)) if !folder.as_os_str().is_empty() => {
            Ok(fs::canonicalize(folder)?.join(name))
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a file path: {}", path.display()),
        )),
    }
}

/// The folder of a path `canonical_file` made, which always has one.
fn parent(path: &Path) -> &Path {
    path.parent().unwrap_or(path)
}

/// Runs on the watch thread until the watcher is dropped: waits for an event, gathers what follows
/// within `BATCH_DELAY`, and hands each target its part.
fn gather(
    events: &Receiver<notify::Result<Event>>,
    targets: &Mutex<Targets>,
    on_batch: impl Fn(WatchTarget, Batch),
) {
    while let Ok(first) = events.recv() {
        let deadline = Instant::now() + BATCH_DELAY;
        let mut gathered = Vec::new();
        let mut next = Some(first);
        let mut open = true;
        while let Some(received) = next.take() {
            match received {
                Ok(event) => gathered.push(event),
                Err(err) => eprintln!("tote: watching for outside changes: {err}"),
            }
            next = match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(event) => Some(event),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => {
                    open = false;
                    None
                }
            };
        }
        // Handed on after the lock is let go, so the receiver may watch or unwatch in turn.
        let batches = route(&lock(targets), &gathered);
        for (target, batch) in batches {
            on_batch(target, batch);
        }
        if !open {
            return;
        }
    }
}

/// Splits one batch of events among the targets. Targets that saw nothing get nothing.
fn route(targets: &Targets, events: &[Event]) -> Vec<(WatchTarget, Batch)> {
    let mut paths = Vec::new();
    let mut pairs = Vec::new();
    let mut froms: BTreeMap<usize, PathBuf> = BTreeMap::new();
    for event in events {
        match (&event.kind, event.tracker(), &event.paths[..]) {
            // Reading a file, or its permissions, tags or times changing: not a change to it.
            (EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_)), ..) => {}
            (EventKind::Modify(ModifyKind::Name(RenameMode::Both)), _, [from, to]) => {
                pairs.push((from.clone(), to.clone()));
            }
            (EventKind::Modify(ModifyKind::Name(RenameMode::From)), Some(tracker), [from]) => {
                froms.insert(tracker, from.clone());
            }
            (EventKind::Modify(ModifyKind::Name(RenameMode::To)), Some(tracker), [to]) => {
                match froms.remove(&tracker) {
                    Some(from) => pairs.push((from, to.clone())),
                    None => paths.push(to.clone()),
                }
            }
            _ => paths.extend(event.paths.iter().cloned()),
        }
    }
    // A rename whose other end was not in this batch: each end only says the path changed.
    paths.extend(froms.into_values());

    let mut batches: BTreeMap<WatchTarget, Batch> = BTreeMap::new();
    for (label, root) in &targets.workspaces {
        let target = WatchTarget::Workspace(label.clone());
        for (from, to) in &pairs {
            match (in_workspace(root, from), in_workspace(root, to)) {
                (true, true) => batch(&mut batches, &target)
                    .renames
                    .push((from.clone(), to.clone())),
                (true, false) => touch(&mut batches, &target, from),
                (false, true) => touch(&mut batches, &target, to),
                (false, false) => {}
            }
        }
        for path in paths.iter().filter(|path| in_workspace(root, path)) {
            touch(&mut batches, &target, path);
        }
    }
    for ((label, known_as), (canonical, _)) in &targets.externals {
        let target = WatchTarget::External(label.clone(), known_as.clone());
        let ends = pairs.iter().flat_map(|(from, to)| [from, to]);
        if ends.chain(&paths).any(|path| path == canonical) {
            touch(&mut batches, &target, canonical);
        }
    }
    batches.into_iter().collect()
}

/// An entry directly in the workspace folder that can be a memo. The folder itself, `.tote/` and
/// everything below it, tote's temporary files and other dot files are not.
fn in_workspace(root: &Path, path: &Path) -> bool {
    path.parent() == Some(root)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| !name.starts_with('.'))
}

fn batch<'a>(batches: &'a mut BTreeMap<WatchTarget, Batch>, target: &WatchTarget) -> &'a mut Batch {
    batches.entry(target.clone()).or_default()
}

fn touch(batches: &mut BTreeMap<WatchTarget, Batch>, target: &WatchTarget, path: &Path) {
    batch(batches, target).touched.insert(path.to_path_buf());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;

    /// FSEvents delivers within tens of milliseconds; two seconds is the plan's bound. A test
    /// that misses it is reported, not retried.
    const WAIT: Duration = Duration::from_secs(2);
    /// How long "nothing else came" is watched for.
    const QUIET: Duration = Duration::from_millis(500);

    fn watcher() -> (Watcher, Receiver<(WatchTarget, Batch)>) {
        let (sender, batches) = mpsc::channel();
        let watcher = Watcher::new(move |target, batch| {
            let _ = sender.send((target, batch));
        })
        .unwrap();
        (watcher, batches)
    }

    #[test]
    fn a_write_in_the_folder_arrives_as_one_batch_within_a_second() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let (watcher, batches) = watcher();
        // The folder as the person named it: `/var/…`, while events come for `/private/var/…`.
        watcher.watch_workspace("ws-1", dir.path()).unwrap();
        let started = Instant::now();
        fs::write(dir.path().join("메모.md"), "x").unwrap();
        let (target, batch) = batches.recv_timeout(WAIT).expect("a batch");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(target, WatchTarget::Workspace("ws-1".into()));
        assert_eq!(batch.touched, BTreeSet::from([root.join("메모.md")]));
        assert!(batches.recv_timeout(QUIET).is_err(), "one batch");
    }

    #[test]
    fn events_under_dot_tote_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        // Not the tempdir itself: its `.tmp…` name is a dot name, so the dot rule alone would drop
        // the folder's own events (FSEvents sends some for a fresh tempdir as watching starts).
        // On macOS notify already drops what is below `.tote/`; `route`'s own rule for both is
        // held by `only_memo_entries_directly_in_the_folder_count`.
        let folder = dir.path().join("ws");
        fs::create_dir_all(folder.join(".tote")).unwrap();
        let root = fs::canonicalize(&folder).unwrap();
        let (watcher, batches) = watcher();
        watcher.watch_workspace("ws-1", &folder).unwrap();
        fs::write(folder.join(".tote/index.json"), "{}").unwrap();
        fs::write(folder.join(".tote-tmp-0"), "half").unwrap();
        fs::write(folder.join(".DS_Store"), "finder").unwrap();
        // Something that does count, so the test ends without waiting out a silence.
        fs::write(folder.join("memo.md"), "x").unwrap();
        let (_, batch) = batches.recv_timeout(WAIT).expect("a batch");
        assert_eq!(batch.touched, BTreeSet::from([root.join("memo.md")]));
        assert!(batch.renames.is_empty());
    }

    #[test]
    fn an_external_file_is_reported_alone() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let (watcher, batches) = watcher();
        watcher.watch_external("ws-1", &a).unwrap();
        fs::write(&b, "b2").unwrap();
        assert!(batches.recv_timeout(QUIET).is_err(), "nothing for b.txt");
        fs::write(&a, "a2").unwrap();
        let (target, batch) = batches.recv_timeout(WAIT).expect("a batch");
        // Named by the path the window gave, so it finds its tab.
        assert_eq!(target, WatchTarget::External("ws-1".into(), a.clone()));
        let canonical = fs::canonicalize(&a).unwrap();
        assert_eq!(batch.touched, BTreeSet::from([canonical]));
    }

    fn event(kind: EventKind, paths: &[&str], tracker: Option<usize>) -> Event {
        let mut event = Event::new(kind);
        for path in paths {
            event = event.add_path(PathBuf::from(path));
        }
        match tracker {
            Some(tracker) => event.set_tracker(tracker),
            None => event,
        }
    }

    #[test]
    fn only_memo_entries_directly_in_the_folder_count() {
        let mut targets = Targets::default();
        targets.workspaces.insert("w".into(), PathBuf::from("/r"));
        let data = EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content));
        let events = [
            event(
                EventKind::Create(notify::event::CreateKind::Folder),
                &["/r"],
                None,
            ),
            event(data, &["/r/.tote/index.json"], None),
            event(data, &["/r/.tote"], None),
            event(data, &["/r/sub/inner.md"], None),
            event(data, &["/r/.tote-tmp-0"], None),
            event(data, &["/elsewhere/memo.md"], None),
            event(
                EventKind::Modify(ModifyKind::Metadata(notify::event::MetadataKind::Extended)),
                &["/r/tagged.md"],
                None,
            ),
            event(data, &["/r/memo.md"], None),
        ];
        assert_eq!(
            route(&targets, &events),
            vec![(
                WatchTarget::Workspace("w".into()),
                Batch {
                    touched: BTreeSet::from([PathBuf::from("/r/memo.md")]),
                    renames: vec![],
                }
            )]
        );
    }

    #[test]
    fn renames_are_paired_by_mode_or_tracker() {
        let mut targets = Targets::default();
        targets.workspaces.insert("w".into(), PathBuf::from("/r"));
        let name = |mode| EventKind::Modify(ModifyKind::Name(mode));
        let events = [
            event(name(RenameMode::Both), &["/r/a", "/r/b"], None),
            event(name(RenameMode::From), &["/r/c"], Some(7)),
            event(name(RenameMode::From), &["/r/e"], Some(8)),
            event(name(RenameMode::To), &["/r/d"], Some(7)),
            // tote's own write lands by rename: the temporary end is not a memo.
            event(name(RenameMode::Both), &["/r/.tote-tmp-0", "/r/f"], None),
        ];
        let path = PathBuf::from;
        assert_eq!(
            route(&targets, &events),
            vec![(
                WatchTarget::Workspace("w".into()),
                Batch {
                    touched: BTreeSet::from([path("/r/e"), path("/r/f")]),
                    renames: vec![(path("/r/a"), path("/r/b")), (path("/r/c"), path("/r/d"))],
                }
            )]
        );
    }
}
