//! The large text viewer's backend (spec 「크기별 단계」): a scan that gives the line count and
//! a byte offset every CHECKPOINT_LINES lines, so the viewer fetches whole pages of lines by
//! Range and splits them itself, and a search that streams the file and returns a page of
//! matches at a time.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::persist::{is_binary, NotText, BINARY_PROBE_BYTES};

pub const CHECKPOINT_LINES: u64 = 1000;
pub const SEARCH_PAGE: usize = 200;
const READ_CHUNK: usize = 1 << 20;
const CANCEL_CHECK_LINES: u64 = 1000;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextScan {
    pub size: u64,
    /// As the editor counts: the text after the last `\n` is a line, even when empty.
    pub line_count: u64,
    /// Byte offset of the first byte of line 0, CHECKPOINT_LINES, 2·CHECKPOINT_LINES, …
    pub checkpoints: Vec<u64>,
    /// In bytes (`\r` included).
    pub longest_line: u64,
}

pub fn scan(path: &Path) -> io::Result<TextScan> {
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    scan_reader(file, size)
}

/// The first `size` bytes of `reader`. A log still being written grows while it is read; what
/// came after the size the viewer was told is not part of this scan.
fn scan_reader(reader: impl Read, size: u64) -> io::Result<TextScan> {
    let mut reader = reader.take(size);
    // A file over the editor's limit comes here unread: a video named `.ts` is turned away by its
    // first bytes (`persist::read_text`'s rule) instead of being scanned to its end.
    let mut head = Vec::with_capacity(BINARY_PROBE_BYTES);
    (&mut reader)
        .take(BINARY_PROBE_BYTES as u64)
        .read_to_end(&mut head)?;
    if is_binary(&head) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, NotText));
    }
    let mut reader = head.as_slice().chain(reader);
    let mut buf = vec![0u8; READ_CHUNK];
    let mut offset: u64 = 0;
    let mut line: u64 = 0;
    let mut line_start: u64 = 0;
    let mut longest: u64 = 0;
    let mut checkpoints = vec![0u64];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let mut from = 0;
        while let Some(i) = memchr::memchr(b'\n', &buf[from..n]) {
            let end = offset + (from + i) as u64;
            longest = longest.max(end - line_start);
            line += 1;
            line_start = end + 1;
            if line.is_multiple_of(CHECKPOINT_LINES) {
                checkpoints.push(line_start);
            }
            from += i + 1;
        }
        offset += n as u64;
    }
    longest = longest.max(size - line_start);
    Ok(TextScan {
        size,
        line_count: line + 1,
        checkpoints,
        longest_line: longest,
    })
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextQuery {
    pub query: String,
    pub case_sensitive: bool,
    pub regex: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TextMatch {
    pub line: u64,
    /// Byte offset inside the line.
    pub column: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TextSearch {
    pub matches: Vec<TextMatch>,
    /// The whole file was searched; `false` with `cancelled == false` means the page filled up —
    /// ask again from the line after the last match.
    pub done: bool,
    pub cancelled: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("not a valid pattern: {0}")]
    BadPattern(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Matches from `from_line` on, at most `limit`, line by line through the file. `cancelled` is
/// asked every CANCEL_CHECK_LINES lines, and at every chunk read of a line longer than one; a
/// newer search from the same window answers true.
pub fn search(
    path: &Path,
    query: &TextQuery,
    from_line: u64,
    limit: usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<TextSearch, SearchError> {
    let matcher = Matcher::new(query)?;
    let mut buf = Vec::new();
    let from = Page { from_line, limit };
    Ok(search_reader(
        File::open(path)?,
        &matcher,
        from,
        cancelled,
        READ_CHUNK,
        &mut buf,
    )?)
}

struct Matcher {
    re: regex::bytes::Regex,
    /// An empty query matches nothing; the file is still read to its end.
    idle: bool,
    /// The most bytes one match takes, for a query that is plain text: a match there depends on
    /// nothing outside itself, so a line longer than the buffer is searched a window at a time
    /// (`search_window`). `None` for a regex: `^`, `$`, `\b` and `.*` look at, or run through, the
    /// whole line, so the whole line is held as before, however long.
    longest: Option<usize>,
}

impl Matcher {
    fn new(query: &TextQuery) -> Result<Matcher, SearchError> {
        let pattern = if query.regex {
            query.query.clone()
        } else {
            regex::escape(&query.query)
        };
        let re = regex::bytes::RegexBuilder::new(&pattern)
            .case_insensitive(!query.case_sensitive)
            .build()
            .map_err(|err| SearchError::BadPattern(err.to_string()))?;
        // Without case a character may match one of another length (`k` the Kelvin sign, three
        // bytes), never more than UTF-8's four.
        let longest = match (query.regex, query.case_sensitive) {
            (true, _) => None,
            (false, true) => Some(query.query.len()),
            (false, false) => Some(query.query.chars().count() * 4),
        };
        Ok(Matcher {
            re,
            idle: query.query.is_empty(),
            longest,
        })
    }
}

struct Page {
    from_line: u64,
    limit: usize,
}

/// `search` over `reader`, read `chunk` bytes at a time into `buf`. What `buf` holds is the part
/// of the line being read that is not searched yet: all of it for a line that fits or for a
/// regex, and for plain text in a longer line only its end (`search_window`) — so a file that is
/// one line of gigabytes is searched in about two chunks of memory.
fn search_reader(
    mut reader: impl Read,
    matcher: &Matcher,
    page: Page,
    cancelled: &dyn Fn() -> bool,
    chunk: usize,
    buf: &mut Vec<u8>,
) -> io::Result<TextSearch> {
    let answer = |matches, done, cancelled| TextSearch {
        matches,
        done,
        cancelled,
    };
    let mut matches = Vec::new();
    let mut line: u64 = 0;
    // How many bytes of the line being read were searched and dropped from `buf`.
    let mut dropped: u64 = 0;
    buf.clear();
    loop {
        // No `\n` among the bytes carried over: they were looked through when they were read.
        let carried = buf.len();
        // `read_to_end` stops short of the chunk only where the file ends.
        let at_end = (&mut reader).take(chunk as u64).read_to_end(buf)? < chunk;
        let mut start = 0;
        let mut look = carried;
        loop {
            let end = match memchr::memchr(b'\n', &buf[look..]) {
                Some(i) => look + i,
                // The last line has no `\n`; nothing after the last `\n` is no line.
                None if at_end && start < buf.len() => buf.len(),
                None => break,
            };
            if line >= page.from_line && !matcher.idle {
                // A CRLF line matches as the viewer shows it, without the \r (the fake does the same).
                let text = &buf[start..end];
                let text = text.strip_suffix(b"\r").unwrap_or(text);
                for found in matcher.re.find_iter(text) {
                    matches.push(TextMatch {
                        line,
                        column: dropped + found.start() as u64,
                    });
                    if matches.len() >= page.limit {
                        return Ok(answer(matches, false, false));
                    }
                }
            }
            line += 1;
            dropped = 0;
            start = (end + 1).min(buf.len());
            look = start;
            if line.is_multiple_of(CANCEL_CHECK_LINES) && cancelled() {
                return Ok(answer(matches, false, true));
            }
        }
        if at_end {
            return Ok(answer(matches, true, false));
        }
        // From here `buf[start..]` is the line being read, its end not seen yet. With no line
        // ended in a whole chunk it is a long one, and the per-line check would not come.
        if start == 0 && cancelled() {
            return Ok(answer(matches, false, true));
        }
        if line < page.from_line || matcher.idle {
            // Not searched: only its `\n` is looked for.
            start = buf.len();
        } else if let Some(longest) = matcher.longest {
            let hold = longest.max(1);
            if buf.len() - start >= chunk + hold {
                let resume = search_window(&buf[start..], matcher, hold, |column| {
                    matches.push(TextMatch {
                        line,
                        column: dropped + column,
                    });
                    matches.len() < page.limit
                });
                let Some(resume) = resume else {
                    return Ok(answer(matches, false, false));
                };
                dropped += resume as u64;
                start += resume;
            }
        }
        buf.drain(..start);
    }
}

/// Searches `window`, the start of what is left of a line whose end is not read yet, for the plain
/// text of `matcher`, and returns where the search goes on from once more of the line is read;
/// `None` when `found` — given each match's offset in `window` — says to stop.
///
/// Only matches that start more than `hold` bytes before the window's end are taken. Such a match
/// lies whole inside the window, short of its last byte (which may be the `\r` of a CRLF the
/// viewer does not show), so the bytes still to come cannot change it; a later one may run past
/// the end and is left for the next window, which starts no later than it does.
fn search_window(
    window: &[u8],
    matcher: &Matcher,
    hold: usize,
    mut found: impl FnMut(u64) -> bool,
) -> Option<usize> {
    let safe = window.len() - hold;
    let mut resume = safe;
    for each in matcher.re.find_iter(window) {
        if each.start() >= safe {
            break;
        }
        if !found(each.start() as u64) {
            return None;
        }
        // Matches do not overlap: the next one starts at this one's end or later.
        resume = safe.max(each.end());
    }
    Some(resume)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn file(lines: &[&str]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.log");
        fs::write(&path, lines.join("\n")).unwrap();
        (dir, path)
    }

    #[test]
    fn a_scan_turns_a_binary_file_away_by_its_first_bytes() {
        /// 50MB of NULs that counts what was taken from it.
        struct Video(u64);
        impl Read for Video {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                buf.fill(0);
                self.0 += buf.len() as u64;
                Ok(buf.len())
            }
        }
        let mut video = Video(0);
        let err = scan_reader(&mut video, 50 * 1024 * 1024).unwrap_err();
        assert!(crate::persist::is_not_text(&err), "{err}");
        assert!(
            video.0 <= BINARY_PROBE_BYTES as u64,
            "read {} bytes",
            video.0
        );
        // The head of a text file is scanned with the rest.
        let text = "a\n".repeat(BINARY_PROBE_BYTES);
        let scan = scan_reader(text.as_bytes(), text.len() as u64).unwrap();
        assert_eq!(scan.line_count, BINARY_PROBE_BYTES as u64 + 1);
        assert_eq!(scan.size, text.len() as u64);
    }

    #[test]
    fn scan_counts_lines_checkpoints_and_the_longest_line() {
        let lines: Vec<String> = (0..2500).map(|i| format!("line {i}")).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let (_dir, path) = file(&refs);
        let scan = scan(&path).unwrap();
        assert_eq!(scan.line_count, 2500);
        assert_eq!(scan.size, fs::metadata(&path).unwrap().len());
        // Checkpoints at lines 0, 1000, 2000 — byte offsets of their first byte.
        assert_eq!(scan.checkpoints.len(), 3);
        assert_eq!(scan.checkpoints[0], 0);
        let text = fs::read_to_string(&path).unwrap();
        let offset_of_line = |n: usize| {
            text.split_inclusive('\n')
                .take(n)
                .map(str::len)
                .sum::<usize>() as u64
        };
        assert_eq!(scan.checkpoints[1], offset_of_line(1000));
        assert_eq!(scan.checkpoints[2], offset_of_line(2000));
        assert_eq!(scan.longest_line, "line 2499".len() as u64);
    }

    #[test]
    fn scan_handles_a_trailing_newline_an_empty_file_and_crlf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "a\nbb\n").unwrap();
        let s = scan(&path).unwrap();
        assert_eq!((s.line_count, s.longest_line), (3, 2)); // the empty line after the last \n counts, as the editor counts it
        fs::write(&path, "").unwrap();
        let s = scan(&path).unwrap();
        assert_eq!((s.line_count, s.checkpoints.len()), (1, 1));
        fs::write(&path, "a\r\nbbb\r\n").unwrap();
        assert_eq!(scan(&path).unwrap().longest_line, 4); // \r stays in the line; the viewer strips it
    }

    #[test]
    fn scan_stops_at_the_size_it_started_with_while_the_file_grows() {
        // A log being written: more bytes arrive than the size read when the scan began.
        let grown = b"a\nbb\nccc\ndddd\n";
        let s = scan_reader(&grown[..], 4).unwrap();
        assert_eq!(s.size, 4);
        assert_eq!((s.line_count, s.longest_line), (2, 2)); // "a", "bb"
        assert_eq!(s.checkpoints, vec![0]);
    }

    #[test]
    fn search_matches_a_crlf_line_without_its_cr() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crlf.txt");
        fs::write(&path, "a needle\r\nb\r\nlast needle\r").unwrap();
        let q = TextQuery {
            query: "needle$".into(),
            case_sensitive: true,
            regex: true,
        };
        let found = search(&path, &q, 0, 10, &|| false).unwrap();
        assert_eq!(
            found
                .matches
                .iter()
                .map(|m| (m.line, m.column))
                .collect::<Vec<_>>(),
            vec![(0, 2), (2, 5)]
        );
    }

    #[test]
    fn search_finds_literal_and_regex_matches_with_case_options_and_pages() {
        let (_dir, path) = file(&["Error one", "fine", "error two", "ERROR three", "x"]);
        let q = |query: &str, case_sensitive: bool, regex: bool| TextQuery {
            query: query.into(),
            case_sensitive,
            regex,
        };
        let all = search(&path, &q("error", false, false), 0, 10, &|| false).unwrap();
        assert_eq!(
            all.matches
                .iter()
                .map(|m| (m.line, m.column))
                .collect::<Vec<_>>(),
            vec![(0, 0), (2, 0), (3, 0)]
        );
        assert!(all.done && !all.cancelled);
        let sensitive = search(&path, &q("error", true, false), 0, 10, &|| false).unwrap();
        assert_eq!(sensitive.matches.len(), 1);
        let regex = search(&path, &q("e.r", true, true), 0, 10, &|| false).unwrap();
        assert_eq!(regex.matches.len(), 1); // "error two" only (e·r·r)
        let paged = search(&path, &q("e", false, false), 0, 2, &|| false).unwrap();
        assert_eq!(paged.matches.len(), 2);
        assert!(!paged.done);
        let next = search(
            &path,
            &q("e", false, false),
            paged.matches.last().unwrap().line + 1,
            10,
            &|| false,
        )
        .unwrap();
        assert!(next.done);
        // A literal that looks like a regex is still a literal.
        let literal = search(&path, &q("e.r", false, false), 0, 10, &|| false).unwrap();
        assert!(literal.matches.is_empty());
        assert!(matches!(
            search(&path, &q("(", false, true), 0, 10, &|| false),
            Err(SearchError::BadPattern(_))
        ));
    }

    // The extensions smoke left the real searcher unverified on a big log; the E2E runs the fake's.
    #[test]
    fn search_finds_an_exact_line_and_a_regex_in_a_synthetic_big_log() {
        let lines: Vec<String> = (0..100_000).map(|n| format!("{n} lorem ipsum")).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let (_dir, path) = file(&refs);
        let q = |query: &str, regex: bool| TextQuery {
            query: query.into(),
            case_sensitive: false,
            regex,
        };
        let at = |found: &TextSearch| {
            found
                .matches
                .iter()
                .map(|m| (m.line, m.column))
                .collect::<Vec<_>>()
        };
        let exact = search(&path, &q("99990", false), 0, 1000, &|| false).unwrap();
        assert_eq!(at(&exact), vec![(99_990, 0)]);
        assert!(exact.done);
        // `^1000+ ` is 1000, 10000 — a number, then the space; 100 and 10001 are not.
        let regex = search(&path, &q("^1000+ ", true), 0, 1000, &|| false).unwrap();
        assert_eq!(at(&regex), vec![(1000, 0), (10_000, 0)]);
        let literal = search(&path, &q("^1000+ ", false), 0, 1000, &|| false).unwrap();
        assert!(literal.matches.is_empty());
    }

    fn query(text: &str, case_sensitive: bool, regex: bool) -> TextQuery {
        TextQuery {
            query: text.into(),
            case_sensitive,
            regex,
        }
    }

    /// The search a whole line at a time, each line in memory: what `search_reader` must answer
    /// whatever its chunk.
    fn by_whole_lines(text: &[u8], matcher: &Matcher, page: &Page) -> TextSearch {
        let mut matches = Vec::new();
        let mut rest = text;
        let mut line = 0;
        while !rest.is_empty() {
            let end = memchr::memchr(b'\n', rest);
            let this = &rest[..end.unwrap_or(rest.len())];
            rest = end.map_or(&[][..], |end| &rest[end + 1..]);
            if line >= page.from_line && !matcher.idle {
                for found in matcher
                    .re
                    .find_iter(this.strip_suffix(b"\r").unwrap_or(this))
                {
                    matches.push(TextMatch {
                        line,
                        column: found.start() as u64,
                    });
                    if matches.len() >= page.limit {
                        return TextSearch {
                            matches,
                            done: false,
                            cancelled: false,
                        };
                    }
                }
            }
            line += 1;
        }
        TextSearch {
            matches,
            done: true,
            cancelled: false,
        }
    }

    /// `text` searched in chunks of every size from one byte up must answer as `by_whole_lines`.
    fn same_in_every_chunk(text: &[u8], q: &TextQuery, from_line: u64, limit: usize) {
        let matcher = Matcher::new(q).unwrap();
        let expected = by_whole_lines(text, &matcher, &Page { from_line, limit });
        for chunk in 1..=text.len() + 1 {
            let mut buf = Vec::new();
            let page = Page { from_line, limit };
            let found = search_reader(text, &matcher, page, &|| false, chunk, &mut buf).unwrap();
            assert_eq!(
                found,
                expected,
                "chunk {chunk}, {q:?} from line {from_line} limit {limit} in {:?}",
                String::from_utf8_lossy(text)
            );
        }
    }

    #[test]
    fn a_search_read_in_chunks_answers_as_one_read_a_line_at_a_time() {
        let texts: [&str; 10] = [
            "",
            "\n",
            "needle",
            "a needle in a line much longer than any chunk here, then a NEEDLE and a needle\n",
            // Matches that overlap: `aba` in `abababa` is at 0 and 4, wherever the chunks fall.
            "abababa\nxx aba\r\nABA abaaba",
            "abababababababababababababababababababababababababababababababa\r",
            "\u{212a}k\u{212a}\u{212a}kkK\u{212a}\u{212a}k\u{212a}kk\u{212a}\u{212a}\u{212a}kK\u{212a}k\u{212a}\u{212a}\r\n",
            // A CR ends a line only before its LF or at the end of the file.
            "x\r\ry\r\r\nz\r",
            // The Kelvin sign and the long s: three and two bytes that match `k` and `s`.
            "kK\u{212a}k \u{212a}\u{212a}\nso \u{17f}o \u{17f}\u{17f}s\n",
            "한글 메모와 한글\n\n한글\r\n",
        ];
        let queries = [
            query("needle", false, false),
            query("needle", true, false),
            query("aba", false, false),
            query("aba", true, false),
            query("kk", false, false),
            query("\r", true, false),
            query("k", false, false),
            query("ss", false, false),
            query("한글", true, false),
            query("a", true, false),
            query("", false, false),
            // A regex sees its whole line whatever the chunk.
            query("^a.*needle$", false, true),
            query(r"\bneedle\b|o$", false, true),
        ];
        for text in texts {
            for q in &queries {
                same_in_every_chunk(text.as_bytes(), q, 0, usize::MAX);
                same_in_every_chunk(text.as_bytes(), q, 1, usize::MAX);
                same_in_every_chunk(text.as_bytes(), q, 0, 2);
            }
        }
        // Every text of a few letters, breaks and wide characters, by a fixed sequence.
        let pieces = ["a", "b", "ab", "\n", "\r", "\r\n", "K", "\u{212a}", "k"];
        let mut seed: u32 = 1;
        for _ in 0..300 {
            let mut text = String::new();
            for _ in 0..12 {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                text.push_str(pieces[(seed >> 16) as usize % pieces.len()]);
            }
            for q in &queries[2..7] {
                same_in_every_chunk(text.as_bytes(), q, 0, usize::MAX);
            }
        }
    }

    #[test]
    fn plain_text_in_one_huge_line_is_found_without_holding_the_line() {
        // One line of sixteen chunks, a match across the end of a chunk and one near the end.
        let mut text = vec![b'a'; READ_CHUNK * 16];
        let across = READ_CHUNK * 5 - 3;
        let late = READ_CHUNK * 15 + 7;
        for at in [across, late] {
            text[at..at + 6].copy_from_slice(b"Needle");
        }
        text.extend_from_slice(b"\r\nneedle after\n");
        let found = |q: &TextQuery, buf: &mut Vec<u8>| {
            let matcher = Matcher::new(q).unwrap();
            let page = Page {
                from_line: 0,
                limit: 10,
            };
            let found =
                search_reader(&text[..], &matcher, page, &|| false, READ_CHUNK, buf).unwrap();
            assert!(found.done);
            found
                .matches
                .iter()
                .map(|m| (m.line, m.column))
                .collect::<Vec<_>>()
        };
        let expected = vec![(0, across as u64), (0, late as u64), (1, 0)];
        let mut buf = Vec::new();
        assert_eq!(found(&query("needle", false, false), &mut buf), expected);
        assert!(
            buf.capacity() <= READ_CHUNK * 4,
            "held {} bytes of a {} byte line",
            buf.capacity(),
            text.len()
        );
        // A regex needs the whole line, and still gets it.
        let mut buf = Vec::new();
        assert_eq!(found(&query("needle", false, true), &mut buf), expected);
        assert!(buf.capacity() >= READ_CHUNK * 16);
    }

    #[test]
    fn a_search_inside_one_long_line_can_be_cancelled() {
        // One line of several read chunks: no line ever ends for the per-line check to run at.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("one-line.json");
        fs::write(&path, vec![b'a'; READ_CHUNK * 3 + 17]).unwrap();
        let q = TextQuery {
            query: "needle".into(),
            case_sensitive: true,
            regex: false,
        };
        let result = search(&path, &q, 0, 10, &|| true).unwrap();
        assert!(result.cancelled && !result.done);
        let regex = TextQuery { regex: true, ..q };
        let result = search(&path, &regex, 0, 10, &|| true).unwrap();
        assert!(result.cancelled && !result.done);
    }

    #[test]
    fn search_stops_when_cancelled_and_says_so() {
        let lines: Vec<String> = (0..5000).map(|i| format!("row {i}")).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let (_dir, path) = file(&refs);
        let q = TextQuery {
            query: "row".into(),
            case_sensitive: false,
            regex: false,
        };
        let result = search(&path, &q, 0, 10_000, &|| true).unwrap();
        assert!(result.cancelled && !result.done);
        assert!(result.matches.len() < 5000);
    }
}
