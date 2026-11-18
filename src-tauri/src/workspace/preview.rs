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

/// The preview of a memo whose first bytes are `head`: `None` for bytes the editor would not open
/// as text. A character cut at the end of `head` is dropped; the title line is the editor's (`titleLine` in src/core/title.ts): the first line
/// that is not blank, a `#!` first line skipped.
pub fn preview_of(head: &[u8]) -> Option<String> {
    if head.contains(&0) {
        return None;
    }
    // As the editor reads it (`decodeText`): without the BOM, and not text when it is not UTF-8.
    let head = head.strip_prefix(b"\xef\xbb\xbf").unwrap_or(head);
    let text = match std::str::from_utf8(head) {
        Ok(text) => text,
        // Cut inside a character at the end: what comes before it.
        Err(err) if err.error_len().is_none() => {
            std::str::from_utf8(&head[..err.valid_up_to()]).ok()?
        }
        Err(_) => return None,
    };
    // CodeMirror's line breaks: CRLF, a lone CR, LF.
    let text = text.replace("\r\n", "\n");
    let mut lines = text.split(['\r', '\n']);
    let mut first = lines.next();
    if first.is_some_and(|line| line.starts_with("#!")) {
        first = None;
    }
    let mut lines = first.into_iter().chain(lines);
    // The title line, and the blank lines before it.
    lines.find(|line| !line.trim().is_empty());
    let joined = lines
        .filter_map(cleaned)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let folded = joined.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(folded.chars().take(PREVIEW_CHARS).collect())
}

/// `line` as the preview shows it: its marks taken off (`without_marks`) and the strong marks
/// (`**`, `__`) in it; `None` for a code fence's line (```` ``` ````, `~~~`), whose language name
/// says nothing — the code between two fences stays.
fn cleaned(line: &str) -> Option<String> {
    let rest = without_marks(line);
    if rest.starts_with("```") || rest.starts_with("~~~") {
        return None;
    }
    Some(without_strong(rest))
}

/// `line` without its leading Markdown marks — headings and quotes (`#`, `>`), list bullets
/// (`-`, `*`, `+`) and numbers (`1.`), a task box (`[ ]`, `[x]`, `[X]`) after a bullet or a
/// number — and the spaces around them. A bullet, a number or a box counts as one only with a
/// space after it (or, for a box, the line's end), so `-1`, `3.5` and `[x]y` stay.
fn without_marks(line: &str) -> &str {
    let mut rest = line.trim_start();
    loop {
        let next = if let Some(after) = rest.strip_prefix(['#', '>']) {
            after
        } else if let Some(after) = rest
            .strip_prefix(['-', '*', '+'])
            .filter(|after| after.starts_with(char::is_whitespace))
        {
            without_box(after.trim_start())
        } else {
            let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            match rest[digits..].strip_prefix('.') {
                Some(after) if digits > 0 && after.starts_with(char::is_whitespace) => {
                    without_box(after.trim_start())
                }
                _ => return rest.trim_end(),
            }
        };
        rest = next.trim_start();
    }
}

/// `item` without the task box it starts with, if it does.
fn without_box(item: &str) -> &str {
    ["[ ]", "[x]", "[X]"]
        .iter()
        .find_map(|mark| item.strip_prefix(mark))
        .filter(|after| after.is_empty() || after.starts_with(char::is_whitespace))
        .unwrap_or(item)
}

/// `text` without `**` anywhere and without `__` but between two letters or digits, where
/// Markdown does not read it as a mark either (`a__b`). A lone `*` or `_` stays: `snake_case`,
/// `2 * 3`.
fn without_strong(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let pair = chars.get(i + 1) == Some(&chars[i]);
        if pair && chars[i] == '*' {
            i += 2;
            continue;
        }
        if pair && chars[i] == '_' {
            let before = i.checked_sub(1).map(|at| chars[at]);
            let after = chars.get(i + 2).copied();
            let inside = before.is_some_and(char::is_alphanumeric)
                && after.is_some_and(char::is_alphanumeric);
            if !inside {
                i += 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
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
    fn the_title_line_is_the_editors_with_a_bom_or_a_lone_cr() {
        assert_eq!(preview("\u{feff}#!/bin/sh\necho hi\nls"), "ls");
        assert_eq!(preview("\u{feff}\n제목\n본문"), "본문");
        assert_eq!(preview("\u{feff}제목\n본문"), "본문");
        assert_eq!(preview("제목\r본문\r둘"), "본문 둘");
    }

    #[test]
    fn bad_utf8_before_the_end_has_none() {
        assert_eq!(preview_of(b"t\n\xff\xfe body"), None);
        // Cut at the end only: what comes before.
        assert_eq!(preview_of(b"t\nbody \xea\xb0").as_deref(), Some("body"));
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
    fn task_boxes_after_a_bullet_or_a_number_go() {
        assert_eq!(
            preview("장보기\n- [ ] 우유\n- [x] 계란\n* [X] 두부\n1. [ ] 사과\n> - [ ] 빵"),
            "우유 계란 두부 사과 빵"
        );
        // An empty task, a box with no bullet, and one not followed by a space.
        assert_eq!(
            preview("t\n- [ ]\n[ ] 그냥\n- [x]y\n- [-] 다른 것"),
            "[ ] 그냥 [x]y [-] 다른 것"
        );
    }

    #[test]
    fn strong_marks_go_and_single_ones_stay() {
        assert_eq!(
            preview("t\n배포: **릴리스 노트** 정리\n__굵게__ 끝"),
            "배포: 릴리스 노트 정리 굵게 끝"
        );
        assert_eq!(
            preview("t\nsnake_case *기울임* _밑줄_ 2 * 3 a__b"),
            "snake_case *기울임* _밑줄_ 2 * 3 a__b"
        );
        assert_eq!(preview("t\n- **가**"), "가");
    }

    #[test]
    fn code_fence_lines_go_and_the_code_stays() {
        assert_eq!(
            preview("회의\n리뷰\n```ts\nconst release = 1;\n```\n~~~\n끝\n  ~~~"),
            "리뷰 const release = 1; 끝"
        );
        // A fence inside a quote or a list item, too.
        assert_eq!(preview("t\n> ```sh\nls\n- ```"), "ls");
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
