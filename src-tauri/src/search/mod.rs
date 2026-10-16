//! Workspace search (spec 「워크스페이스 검색」): ripgrep's searcher over the memo files on a few
//! threads at once, each file's matches sent as soon as that file is done. No index.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};
use std::thread;

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{
    BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkContextKind, SinkMatch,
};
use serde::Serialize;

pub use crate::files::text::SearchError;
use crate::files::text::TextQuery;
use crate::persist::{is_binary, BINARY_PROBE_BYTES};
use crate::workspace::{FileKind, MemoInfo};

/// Bigger files are not opened (spec 「워크스페이스 검색」).
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Matches in one search; past it every thread stops and `Done` says `truncated`.
pub const MAX_MATCHES: usize = 2000;
pub const MAX_MATCHES_PER_FILE: usize = 200;
/// Lines shown before and after each match.
pub const CONTEXT_LINES: usize = 1;
/// Characters of a line sent at most — of the matching line and of each context line — so a
/// minified file's one 5MB line does not cross the channel thousands of times. A cut end is
/// marked with `…`. 160 fills the widest search panel twice over; the worst case, 2,000 matches
/// with two context lines each, all Hangul, stays under 3MB.
pub const MAX_LINE_CHARS: usize = 160;
/// Of those, how many come before the match when the matching line has to be cut.
pub const MATCH_LEAD_CHARS: usize = 40;

/// The same shape as the large text viewer's query.
pub type SearchQuery = TextQuery;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchEvent {
    /// One file's matches; only files that have some.
    File {
        memo_id: String,
        file: String,
        matches: Vec<Match>,
    },
    /// The last event of a search.
    Done {
        files_searched: u32,
        truncated: bool,
        cancelled: bool,
    },
}

/// A matching line. A line with several matches is one `Match`, at the first.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Match {
    /// 0-based.
    pub line: u64,
    /// Characters before the match in the whole line, not bytes and not in `text`. CodeMirror
    /// counts UTF-16 units: the same for Hangul and the rest of the BMP, one short for each
    /// emoji or other astral character before the match — the frontend clamps to the line.
    pub column: u64,
    /// The line without its line ending, cut to `MAX_LINE_CHARS` around the match; a cut end
    /// is marked with `…`. `before` and `after` are cut to their first `MAX_LINE_CHARS` the same
    /// way.
    pub text: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

/// The memos a search opens, as (memo ID, file name): text memos only. The kind comes from the
/// extension, so a PDF or an image is never opened to look for a NUL byte.
pub fn text_candidates(memos: impl IntoIterator<Item = MemoInfo>) -> Vec<(String, String)> {
    memos
        .into_iter()
        .filter(|memo| memo.kind == FileKind::Text)
        .map(|memo| (memo.id, memo.file))
        .collect()
}

/// Searches `files` — (memo ID, file name) in `root` — and sends each file's matches to `emit`
/// as soon as that file is done, then one `Done`. Files are taken from a shared queue by as many
/// threads as there are cores, so `File` events come in no fixed order. `cancelled` is asked
/// before each file. An empty query finds nothing.
pub fn search(
    root: &Path,
    files: &[(String, String)],
    query: &SearchQuery,
    cancelled: &(dyn Fn() -> bool + Sync),
    emit: &(dyn Fn(SearchEvent) + Sync),
) -> Result<(), SearchError> {
    let state = State::default();
    if !query.query.is_empty() {
        let matcher = matcher_for(query)?;
        let queue = Mutex::new(files.iter().collect::<VecDeque<_>>());
        let threads = thread::available_parallelism()
            .map_or(1, |n| n.get())
            .min(files.len());
        thread::scope(|scope| {
            for _ in 0..threads {
                scope.spawn(|| work(root, &queue, &matcher, &state, cancelled, emit));
            }
        });
    }
    emit(SearchEvent::Done {
        files_searched: state.searched.load(Ordering::Relaxed),
        truncated: state.truncated.load(Ordering::Relaxed),
        cancelled: state.cancelled.load(Ordering::Relaxed),
    });
    Ok(())
}

fn matcher_for(query: &SearchQuery) -> Result<RegexMatcher, SearchError> {
    let pattern = if query.regex {
        query.query.clone()
    } else {
        regex::escape(&query.query)
    };
    RegexMatcherBuilder::new()
        .case_insensitive(!query.case_sensitive)
        // A match never crosses a line: the searcher reports whole lines.
        .line_terminator(Some(b'\n'))
        .build(&pattern)
        .map_err(|err| SearchError::BadPattern(err.to_string()))
}

/// What the threads of one search share.
#[derive(Default)]
struct State {
    /// Matches taken so far, counted past `MAX_MATCHES` by the threads that found one too many.
    matches: AtomicUsize,
    searched: AtomicU32,
    truncated: AtomicBool,
    cancelled: AtomicBool,
    /// Every thread stops at its next file or match: the limit was reached or it was cancelled.
    stop: AtomicBool,
}

fn work(
    root: &Path,
    queue: &Mutex<VecDeque<&(String, String)>>,
    matcher: &RegexMatcher,
    state: &State,
    cancelled: &(dyn Fn() -> bool + Sync),
    emit: &(dyn Fn(SearchEvent) + Sync),
) {
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .before_context(CONTEXT_LINES)
        .after_context(CONTEXT_LINES)
        .line_number(true)
        .build();
    loop {
        if state.stop.load(Ordering::Relaxed) {
            return;
        }
        if cancelled() {
            state.cancelled.store(true, Ordering::Relaxed);
            state.stop.store(true, Ordering::Relaxed);
            return;
        }
        let next = queue
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front();
        let Some((memo_id, file)) = next else {
            return;
        };
        // A file another app removed or locked since the list was made is left out, as is
        // one that is not text.
        let Ok(Some(matches)) = search_file(&mut searcher, matcher, &root.join(file), state) else {
            continue;
        };
        if !matches.is_empty() {
            emit(SearchEvent::File {
                memo_id: memo_id.clone(),
                file: file.clone(),
                matches,
            });
        }
    }
}

/// The file's matches; `None` when it is not searched: over `MAX_FILE_BYTES`, or binary by
/// `persist::is_binary` — the definition backup and the editor use, so a NUL further in does not
/// hide a text file, and one in the first 8KB hides the matches before it too.
fn search_file(
    searcher: &mut Searcher,
    matcher: &RegexMatcher,
    path: &Path,
    state: &State,
) -> io::Result<Option<Vec<Match>>> {
    if fs::metadata(path)?.len() > MAX_FILE_BYTES {
        return Ok(None);
    }
    let mut file = File::open(path)?;
    let mut probe = Vec::with_capacity(BINARY_PROBE_BYTES);
    (&mut file)
        .take(BINARY_PROBE_BYTES as u64)
        .read_to_end(&mut probe)?;
    if is_binary(&probe) {
        return Ok(None);
    }
    let mut sink = FileSink {
        matcher,
        state,
        matches: Vec::new(),
        before: Vec::new(),
    };
    searcher.search_reader(matcher, probe.as_slice().chain(file), &mut sink)?;
    state.searched.fetch_add(1, Ordering::Relaxed);
    Ok(Some(sink.matches))
}

/// Collects one file's matches with their context lines.
struct FileSink<'a> {
    matcher: &'a RegexMatcher,
    state: &'a State,
    matches: Vec<Match>,
    /// Context lines seen since the last match, for the next one.
    before: Vec<String>,
}

impl Sink for FileSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _: &Searcher, mat: &SinkMatch<'_>) -> io::Result<bool> {
        let state = self.state;
        if state.stop.load(Ordering::Relaxed) {
            return Ok(false);
        }
        if self.matches.len() == MAX_MATCHES_PER_FILE {
            state.truncated.store(true, Ordering::Relaxed);
            return Ok(false);
        }
        if state.matches.fetch_add(1, Ordering::Relaxed) >= MAX_MATCHES {
            state.truncated.store(true, Ordering::Relaxed);
            state.stop.store(true, Ordering::Relaxed);
            return Ok(false);
        }
        let line = without_line_ending(mat.bytes());
        let start = self
            .matcher
            .find(line)
            .ok()
            .flatten()
            .map_or(0, |m| m.start());
        let column = String::from_utf8_lossy(&line[..start]).chars().count();
        self.matches.push(Match {
            line: mat.line_number().map_or(0, |n| n - 1),
            column: column as u64,
            text: excerpt(line, column),
            before: std::mem::take(&mut self.before),
            after: Vec::new(),
        });
        Ok(true)
    }

    fn context(&mut self, _: &Searcher, context: &SinkContext<'_>) -> io::Result<bool> {
        let text = excerpt(without_line_ending(context.bytes()), 0);
        match context.kind() {
            SinkContextKind::Before => self.before.push(text),
            SinkContextKind::After => {
                if let Some(last) = self.matches.last_mut() {
                    last.after.push(text);
                }
            }
            SinkContextKind::Other => {}
        }
        Ok(true)
    }
}

/// `line` as text, cut to `MAX_LINE_CHARS` characters keeping `MATCH_LEAD_CHARS` before the
/// character at `column` where it can; `…` marks each end that was cut.
fn excerpt(line: &[u8], column: usize) -> String {
    let text = String::from_utf8_lossy(line);
    let len = text.chars().count();
    if len <= MAX_LINE_CHARS {
        return text.into_owned();
    }
    let start = column
        .saturating_sub(MATCH_LEAD_CHARS)
        .min(len - MAX_LINE_CHARS);
    let mut cut = String::new();
    if start > 0 {
        cut.push('…');
    }
    cut.extend(text.chars().skip(start).take(MAX_LINE_CHARS));
    if start + MAX_LINE_CHARS < len {
        cut.push('…');
    }
    cut
}

fn without_line_ending(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    fn info(id: &str, file: &str) -> MemoInfo {
        MemoInfo {
            id: id.to_string(),
            file: file.to_string(),
            auto_title: false,
            language: None,
            modified_ms: 0,
            size: 0,
            kind: crate::workspace::kind_for(file),
        }
    }

    #[test]
    fn only_text_memos_are_candidates() {
        let memos = ["a.md", "b.pdf", "c.png", "d"]
            .into_iter()
            .map(|file| info(file.split('.').next().unwrap(), file));
        assert_eq!(
            text_candidates(memos),
            vec![
                ("a".to_string(), "a.md".to_string()),
                ("d".to_string(), "d".to_string())
            ]
        );
    }

    fn query(text: &str, case_sensitive: bool, regex: bool) -> SearchQuery {
        SearchQuery {
            query: text.to_string(),
            case_sensitive,
            regex,
        }
    }

    /// Writes `files` (name, contents) into a new folder; memo IDs are `m-<name>`.
    fn workspace(files: &[(&str, &[u8])]) -> (tempfile::TempDir, Vec<(String, String)>) {
        let dir = tempfile::tempdir().unwrap();
        let mut listed = Vec::new();
        for (name, contents) in files {
            fs::write(dir.path().join(name), contents).unwrap();
            listed.push((format!("m-{name}"), name.to_string()));
        }
        (dir, listed)
    }

    fn run_with(
        root: &Path,
        files: &[(String, String)],
        query: &SearchQuery,
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> (Result<(), SearchError>, Vec<SearchEvent>) {
        let events = Mutex::new(Vec::new());
        let result = search(root, files, query, cancelled, &|event| {
            events.lock().unwrap().push(event)
        });
        (result, events.into_inner().unwrap())
    }

    fn run(root: &Path, files: &[(String, String)], query: &SearchQuery) -> Vec<SearchEvent> {
        let (result, events) = run_with(root, files, query, &|| false);
        result.unwrap();
        events
    }

    /// The `File` events, sorted by file name: threads finish in any order.
    fn found(events: &[SearchEvent]) -> Vec<(String, Vec<Match>)> {
        let mut files: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                SearchEvent::File { file, matches, .. } => Some((file.clone(), matches.clone())),
                SearchEvent::Done { .. } => None,
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        files
    }

    fn done(events: &[SearchEvent]) -> (u32, bool, bool) {
        match events.last() {
            Some(&SearchEvent::Done {
                files_searched,
                truncated,
                cancelled,
            }) => (files_searched, truncated, cancelled),
            other => panic!("the last event is not Done: {other:?}"),
        }
    }

    fn lines_of(events: &[SearchEvent]) -> Vec<(String, u64)> {
        found(events)
            .into_iter()
            .flat_map(|(file, matches)| matches.into_iter().map(move |m| (file.clone(), m.line)))
            .collect()
    }

    #[test]
    fn finds_literal_and_regex_matches_with_context() {
        let (dir, files) = workspace(&[
            ("a.md", "첫 줄\n가나foo bar\n셋째 줄\n".as_bytes()),
            ("b.txt", b"x\r\nfoo\r\ny\r\n"),
            ("c.md", b"nothing here\n"),
        ]);
        let expected = vec![
            (
                "a.md".to_string(),
                vec![Match {
                    line: 1,
                    // Characters, not bytes: the two Hangul syllables before it are six bytes.
                    column: 2,
                    text: "가나foo bar".to_string(),
                    before: vec!["첫 줄".to_string()],
                    after: vec!["셋째 줄".to_string()],
                }],
            ),
            (
                "b.txt".to_string(),
                vec![Match {
                    line: 1,
                    column: 0,
                    text: "foo".to_string(),
                    before: vec!["x".to_string()],
                    after: vec!["y".to_string()],
                }],
            ),
        ];
        for q in [query("foo", false, false), query("fo+", false, true)] {
            let events = run(dir.path(), &files, &q);
            assert_eq!(found(&events), expected, "{q:?}");
            assert_eq!(done(&events), (3, false, false), "{q:?}");
            assert_eq!(events.len(), 3, "two File events and Done: {events:?}");
        }
        let events = run(dir.path(), &files, &query("foo", false, false));
        assert!(events.iter().any(|e| matches!(
            e,
            SearchEvent::File { memo_id, file, .. } if memo_id == "m-a.md" && file == "a.md"
        )));
    }

    #[test]
    fn long_lines_are_cut_around_the_match() {
        let a = "a".repeat(1000);
        let b = "b".repeat(1000);
        let x = "가".repeat(500);
        let short = "c".repeat(MAX_LINE_CHARS - 3);
        let contents = format!("{x}\n{a}foo{b}\n{x}\n\n{a}foo\n\n{short}foo\n");
        let (dir, files) = workspace(&[("a.md", contents.as_bytes())]);
        let events = run(dir.path(), &files, &query("foo", false, false));
        let matches = &found(&events)[0].1;
        let cut = |s: &str| format!("{}…", &s[..s.char_indices().nth(MAX_LINE_CHARS).unwrap().0]);

        // In the middle: MATCH_LEAD_CHARS before it, the rest after, both ends marked.
        assert_eq!(
            matches[0].column, 1000,
            "the column counts in the whole line"
        );
        assert_eq!(
            matches[0].text,
            format!(
                "…{}foo{}…",
                &a[..MATCH_LEAD_CHARS],
                &b[..MAX_LINE_CHARS - MATCH_LEAD_CHARS - 3]
            )
        );
        assert_eq!(
            matches[0].before,
            vec![cut(&x)],
            "Hangul is cut by characters"
        );
        assert_eq!(matches[0].after, vec![cut(&x)]);

        // At the end of the line: the last MAX_LINE_CHARS characters, only the start marked.
        assert_eq!(matches[1].column, 1000);
        assert_eq!(matches[1].text, format!("…{}foo", &a[..MAX_LINE_CHARS - 3]));

        // Exactly MAX_LINE_CHARS is not cut.
        assert_eq!(matches[2].text, format!("{short}foo"));
    }

    #[test]
    fn a_literal_that_looks_like_a_regex_is_literal() {
        let (dir, files) = workspace(&[("a.md", b"axb\na.b\n(x\n")]);
        let lines = |q: &str| lines_of(&run(dir.path(), &files, &query(q, false, false)));
        assert_eq!(lines("a.b"), vec![("a.md".to_string(), 1)]);
        assert_eq!(lines("("), vec![("a.md".to_string(), 2)]);
        // The same text as a regex: `.` matches the x too.
        let regex = lines_of(&run(dir.path(), &files, &query("a.b", false, true)));
        assert_eq!(regex.len(), 2);
    }

    #[test]
    fn case_insensitive_by_default() {
        let (dir, files) = workspace(&[("a.md", b"FOO\nfoo\nFoo\n")]);
        let insensitive = lines_of(&run(dir.path(), &files, &query("foo", false, false)));
        assert_eq!(insensitive.len(), 3);
        let sensitive = lines_of(&run(dir.path(), &files, &query("foo", true, false)));
        assert_eq!(sensitive, vec![("a.md".to_string(), 1)]);
    }

    #[test]
    fn binary_and_oversize_files_are_skipped() {
        // The NUL comes after a match: skipped by `persist::is_binary`'s first 8KB, the same test
        // backup and the editor use, not just cut short at the NUL.
        let (dir, files) = workspace(&[("bin.md", b"foo\n\0rest\n"), ("ok.md", b"foo\n")]);
        // Filled with newlines, not sparse: a sparse file reads as NULs and would be skipped as
        // binary, whatever its size. The match at the start is there to be not found.
        fs::write(dir.path().join("big.md"), {
            let mut bytes = b"foo\n".to_vec();
            bytes.resize(MAX_FILE_BYTES as usize + 1, b'\n');
            bytes
        })
        .unwrap();
        let mut files = files;
        files.push(("m-big.md".to_string(), "big.md".to_string()));
        let events = run(dir.path(), &files, &query("foo", false, false));
        assert_eq!(lines_of(&events), vec![("ok.md".to_string(), 0)]);
        assert_eq!(done(&events), (1, false, false));
    }

    #[test]
    fn results_stop_at_the_limits_and_say_truncated() {
        let lines = |n: usize| -> Vec<u8> {
            (0..n)
                .map(|i| format!("foo {i}\n"))
                .collect::<String>()
                .into_bytes()
        };
        let q = query("foo", false, false);

        let (dir, files) = workspace(&[("many.md", &lines(300))]);
        let events = run(dir.path(), &files, &q);
        let matches = &found(&events)[0].1;
        assert_eq!(matches.len(), MAX_MATCHES_PER_FILE);
        assert_eq!(matches.last().unwrap().line, 199);
        assert_eq!(done(&events), (1, true, false));

        // Exactly the per-file limit is everything: not truncated.
        let (dir, files) = workspace(&[("full.md", &lines(MAX_MATCHES_PER_FILE))]);
        let events = run(dir.path(), &files, &q);
        assert_eq!(found(&events)[0].1.len(), MAX_MATCHES_PER_FILE);
        assert_eq!(done(&events), (1, false, false));

        // 20 × 150 = 3,000: the search stops at exactly 2,000, the last file cut short.
        let names: Vec<String> = (0..20).map(|i| format!("f{i:02}.md")).collect();
        let body = lines(150);
        let specs: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &body[..])).collect();
        let (dir, files) = workspace(&specs);
        let events = run(dir.path(), &files, &q);
        let total: usize = found(&events).iter().map(|(_, m)| m.len()).sum();
        assert_eq!(total, MAX_MATCHES);
        assert!(done(&events).1, "truncated");
    }

    #[test]
    fn a_cancelled_search_ends_with_cancelled() {
        let names: Vec<String> = (0..32).map(|i| format!("f{i:02}.md")).collect();
        let specs: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b"foo\n"[..])).collect();
        let (dir, files) = workspace(&specs);
        let asked = AtomicUsize::new(0);
        // A newer search arrives right after the first file is picked.
        let cancelled = || asked.fetch_add(1, Ordering::SeqCst) > 0;
        let (result, events) =
            run_with(dir.path(), &files, &query("foo", false, false), &cancelled);
        result.unwrap();
        let (searched, truncated, was_cancelled) = done(&events);
        assert!(was_cancelled);
        assert!(!truncated);
        assert!(searched <= 1, "searched {searched} files after the cancel");
        assert!(found(&events).len() <= 1);
    }

    #[test]
    fn an_invalid_regex_is_a_bad_pattern() {
        let (dir, files) = workspace(&[("a.md", b"(\n")]);
        let (result, events) = run_with(dir.path(), &files, &query("(", false, true), &|| false);
        assert!(
            matches!(result, Err(SearchError::BadPattern(_))),
            "{result:?}"
        );
        assert!(events.is_empty(), "{events:?}");
    }

    #[test]
    fn an_empty_query_finds_nothing() {
        let (dir, files) = workspace(&[("a.md", b"anything\n")]);
        for regex in [false, true] {
            let events = run(dir.path(), &files, &query("", false, regex));
            assert_eq!(
                events,
                vec![SearchEvent::Done {
                    files_searched: 0,
                    truncated: false,
                    cancelled: false
                }]
            );
        }
    }

    #[test]
    fn files_are_searched_in_parallel() {
        if thread::available_parallelism().map_or(1, |n| n.get()) < 2 {
            return;
        }
        let names: Vec<String> = (0..64).map(|i| format!("f{i:02}.md")).collect();
        let specs: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b"foo\n"[..])).collect();
        let (dir, files) = workspace(&specs);
        let threads = Mutex::new(HashSet::new());
        search(
            dir.path(),
            &files,
            &query("foo", false, false),
            &|| false,
            &|event| {
                if let SearchEvent::File { .. } = event {
                    threads.lock().unwrap().insert(thread::current().id());
                    // A file this small is searched in microseconds: without the pause one thread
                    // could take every file before the others start.
                    thread::sleep(Duration::from_millis(5));
                }
            },
        )
        .unwrap();
        assert!(threads.lock().unwrap().len() >= 2);
    }

    #[test]
    fn events_serialize_with_the_field_names_the_frontend_reads() {
        let file = serde_json::to_value(SearchEvent::File {
            memo_id: "m".into(),
            file: "a.md".into(),
            matches: vec![],
        })
        .unwrap();
        assert_eq!(
            file,
            serde_json::json!({ "kind": "file", "memoId": "m", "file": "a.md", "matches": [] })
        );
        let done = serde_json::to_value(SearchEvent::Done {
            files_searched: 3,
            truncated: true,
            cancelled: false,
        })
        .unwrap();
        assert_eq!(
            done,
            serde_json::json!({ "kind": "done", "filesSearched": 3, "truncated": true, "cancelled": false })
        );
    }
}
