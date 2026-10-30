//! The memo list's preview of a memo (spec 2026-10-30 「미리보기」): the lines after the title
//! line, their Markdown marks taken off, run together and cut. Made here, the one place the rule
//! lives, because the list shows memos no tab has open.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

/// Characters a preview holds at most.
pub const PREVIEW_CHARS: usize = 100;
/// Bytes read from the front of a memo for its preview.
pub const PREVIEW_BYTES: u64 = 4096;

/// The preview of the memo at `path`: `None` when it is not text (a NUL in what is read).
pub fn read_preview(path: &Path) -> io::Result<Option<String>> {
    let mut head = Vec::new();
    File::open(path)?
        .take(PREVIEW_BYTES)
        .read_to_end(&mut head)?;
    Ok(preview_of(&head))
}

/// The preview of a memo whose first bytes are `head`. A character cut at the end of `head` is
/// dropped; the title line is the editor's (`titleLine` in src/core/title.ts): the first line
/// that is not blank, a `#!` first line skipped.
pub fn preview_of(head: &[u8]) -> Option<String> {
    if head.contains(&0) {
        return None;
    }
    let text = match std::str::from_utf8(head) {
        Ok(text) => text.into(),
        // Cut inside a character at the end: what comes before it.
        Err(err) if err.error_len().is_none() => {
            String::from_utf8_lossy(&head[..err.valid_up_to()])
        }
        Err(_) => String::from_utf8_lossy(head),
    };
    let mut lines = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line));
    let mut first = lines.next();
    if first.is_some_and(|line| line.starts_with("#!")) {
        first = None;
    }
    let mut lines = first.into_iter().chain(lines);
    // The title line, and the blank lines before it.
    lines.find(|line| !line.trim().is_empty());
    let joined = lines
        .map(without_marks)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let folded = joined.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(folded.chars().take(PREVIEW_CHARS).collect())
}

/// `line` without its leading Markdown marks — headings and quotes (`#`, `>`), list bullets
/// (`-`, `*`, `+`) and numbers (`1.`) — and the spaces around them. A bullet or a number counts
/// as one only with a space after it, so `-1` and `3.5` stay.
fn without_marks(line: &str) -> &str {
    let mut rest = line.trim_start();
    loop {
        let next = if let Some(after) = rest.strip_prefix(['#', '>']) {
            after
        } else if let Some(after) = rest
            .strip_prefix(['-', '*', '+'])
            .filter(|after| after.starts_with(char::is_whitespace))
        {
            after
        } else {
            let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            match rest[digits..].strip_prefix('.') {
                Some(after) if digits > 0 && after.starts_with(char::is_whitespace) => after,
                _ => return rest.trim_end(),
            }
        };
        rest = next.trim_start();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(text: &str) -> String {
        preview_of(text.as_bytes()).unwrap()
    }

    #[test]
    fn the_title_line_is_skipped() {
        assert_eq!(preview("제목\n\n본문 하나\n둘"), "본문 하나 둘");
        assert_eq!(preview("\n\n  \n제목\n본문"), "본문");
        assert_eq!(preview("제목\r\n본문\r\n"), "본문");
    }

    #[test]
    fn a_shebang_line_is_skipped_first() {
        assert_eq!(preview("#!/bin/sh\necho\nls"), "ls");
    }

    #[test]
    fn markdown_marks_go() {
        assert_eq!(
            preview("# t\n## 소제목\n- 가\n* 나\n+ 다\n> 라\n12. 마\n> - 바"),
            "소제목 가 나 다 라 마 바"
        );
        assert_eq!(preview("t\n-1 도\n3.5 점\n*강조*"), "-1 도 3.5 점 *강조*");
    }

    #[test]
    fn spaces_fold() {
        assert_eq!(preview("t\n  가   나\t다  \n\n\n라"), "가 나 다 라");
    }

    #[test]
    fn cut_at_100_chars() {
        let body = "가".repeat(150);
        assert_eq!(
            preview(&format!("t\n{body}")).chars().count(),
            PREVIEW_CHARS
        );
    }

    #[test]
    fn nothing_after_the_title_is_empty() {
        assert_eq!(preview("제목만"), "");
        assert_eq!(preview(""), "");
    }

    #[test]
    fn a_cut_utf8_sequence_is_dropped() {
        // 4,096 bytes ending one byte into 「나」 (three bytes in UTF-8).
        let mut bytes = b"t\n".to_vec();
        bytes.extend("가".repeat(1364).as_bytes());
        bytes.extend(&"나".as_bytes()[..2]);
        assert_eq!(bytes.len(), 4096);
        let text = preview_of(&bytes).unwrap();
        assert!(!text.contains('\u{fffd}'), "{text}");
        assert_eq!(text, "가".repeat(PREVIEW_CHARS));
    }

    #[test]
    fn binary_has_none() {
        assert_eq!(preview_of(b"t\nabc\0def"), None);
    }

    #[test]
    fn a_file_is_read_from_its_front() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, format!("t\n본문\n{}", "x".repeat(10_000))).unwrap();
        let text = read_preview(&path).unwrap().unwrap();
        assert!(text.starts_with("본문 x"), "{text}");
    }
}
