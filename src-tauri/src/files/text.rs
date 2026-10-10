//! The large text viewer's backend (spec 「크기별 단계」): a scan that gives the line count and
//! a byte offset every CHECKPOINT_LINES lines, so the viewer fetches whole pages of lines by
//! Range and splits them itself, and a search that streams the file and returns a page of
//! matches at a time.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};

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
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut buf = vec![0u8; READ_CHUNK];
    let mut offset: u64 = 0;
    let mut line: u64 = 0;
    let mut line_start: u64 = 0;
    let mut longest: u64 = 0;
    let mut checkpoints = vec![0u64];
    loop {
        let n = file.read(&mut buf)?;
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
/// asked every CANCEL_CHECK_LINES lines; a newer search from the same window answers true.
pub fn search(
    path: &Path,
    query: &TextQuery,
    from_line: u64,
    limit: usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<TextSearch, SearchError> {
    let pattern = if query.regex {
        query.query.clone()
    } else {
        regex::escape(&query.query)
    };
    let re = regex::bytes::RegexBuilder::new(&pattern)
        .case_insensitive(!query.case_sensitive)
        .build()
        .map_err(|err| SearchError::BadPattern(err.to_string()))?;
    let mut reader = BufReader::with_capacity(READ_CHUNK, File::open(path)?);
    let mut line_buf = Vec::new();
    let mut line: u64 = 0;
    let mut matches = Vec::new();
    loop {
        line_buf.clear();
        let n = reader.read_until(b'\n', &mut line_buf)?;
        if n == 0 {
            return Ok(TextSearch {
                matches,
                done: true,
                cancelled: false,
            });
        }
        if line >= from_line && !query.query.is_empty() {
            let text = line_buf.strip_suffix(b"\n").unwrap_or(&line_buf);
            for found in re.find_iter(text) {
                matches.push(TextMatch {
                    line,
                    column: found.start() as u64,
                });
                if matches.len() >= limit {
                    return Ok(TextSearch {
                        matches,
                        done: false,
                        cancelled: false,
                    });
                }
            }
        }
        line += 1;
        if line.is_multiple_of(CANCEL_CHECK_LINES) && cancelled() {
            return Ok(TextSearch {
                matches,
                done: false,
                cancelled: true,
            });
        }
    }
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
