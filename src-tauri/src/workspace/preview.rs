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
/// `markdown`: the memo is Markdown (`is_markdown`), whose own marks go too.
pub fn read_preview(path: &Path, markdown: bool) -> io::Result<Option<String>> {
    let mut head = Vec::new();
    File::open(path)?
        .take(PREVIEW_BYTES)
        .read_to_end(&mut head)?;
    Ok(preview_of(&head, markdown))
}

/// Whether the editor opens memo `file` with the chosen `language` as Markdown: the chosen
/// language when there is one, else the extension, `md` or `markdown` in any case — the rule of
/// `isMarkdown` in src/editor/image-paste.ts and `languageFor` in src/editor/setup.ts, and the
/// extensions the bundled Markdown language claims (src-tauri/resources/extensions/
/// tote.languages/package.json). The extension registry is not seen here: an extension an
/// installed one adds to Markdown, or a chosen language whose extension is gone, reads as not
/// Markdown, and such a memo's preview may keep its marks.
pub fn is_markdown(file: &str, language: Option<&str>) -> bool {
    match language {
        Some(language) => language == "markdown",
        None => file.rsplit_once('.').is_some_and(|(stem, ext)| {
            !stem.is_empty()
                && (ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
        }),
    }
}

/// The preview of a memo whose first bytes are `head`: `None` for bytes the editor would not open
/// as text. A character cut at the end of `head` is dropped; the title line is the editor's (`titleLine` in src/core/title.ts): the first line
/// that is not blank, a `#!` first line skipped.
pub fn preview_of(head: &[u8], markdown: bool) -> Option<String> {
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
        .filter_map(|line| cleaned(line, markdown))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let folded = joined.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(folded.chars().take(PREVIEW_CHARS).collect())
}

/// `line` as the preview shows it: its leading marks taken off (`without_marks`), and in a
/// Markdown memo its task box, its strong marks (`without_strong`), or the whole line when it is a
/// code fence (`None`) — the code between two fences stays. A code memo keeps its `[ ]`, `**`,
/// `__` and fences: they are its text (`2**10`, `__init__`).
fn cleaned(line: &str, markdown: bool) -> Option<String> {
    let rest = without_marks(line, markdown);
    if markdown && is_fence(rest) {
        return None;
    }
    Some(if markdown {
        without_strong(rest)
    } else {
        rest.to_string()
    })
}

/// A code fence as CommonMark has it: three backticks or tildes, and after backticks no backtick
/// in the rest — ```` ```ts 인라인``` 뒤 글 ```` is a line of text.
fn is_fence(line: &str) -> bool {
    if line.starts_with("~~~") {
        return true;
    }
    line.starts_with("```") && !line.trim_start_matches('`').contains('`')
}

/// `line` without its leading Markdown marks — headings and quotes (`#`, `>`), list bullets
/// (`-`, `*`, `+`) and numbers (`1.`), and with `boxes` a task box (`[ ]`, `[x]`, `[X]`) after a
/// bullet or a number — and the spaces around them. A bullet, a number or a box counts as one
/// only with a space after it (or, for a box, the line's end), so `-1`, `3.5` and `[x]y` stay.
fn without_marks(line: &str, boxes: bool) -> &str {
    let mut rest = line.trim_start();
    loop {
        let next = if let Some(after) = rest.strip_prefix(['#', '>']) {
            after
        } else if let Some(after) = rest
            .strip_prefix(['-', '*', '+'])
            .filter(|after| after.starts_with(char::is_whitespace))
        {
            without_box(after.trim_start(), boxes)
        } else {
            let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            match rest[digits..].strip_prefix('.') {
                Some(after) if digits > 0 && after.starts_with(char::is_whitespace) => {
                    without_box(after.trim_start(), boxes)
                }
                _ => return rest.trim_end(),
            }
        };
        rest = next.trim_start();
    }
}

/// `item` without the task box it starts with, if it does and `boxes` says to take it off.
fn without_box(item: &str, boxes: bool) -> &str {
    if !boxes {
        return item;
    }
    ["[ ]", "[x]", "[X]"]
        .iter()
        .find_map(|mark| item.strip_prefix(mark))
        .filter(|after| after.is_empty() || after.starts_with(char::is_whitespace))
        .unwrap_or(item)
}

/// `text` without the strong marks that pair up in it, as Markdown pairs them: a `**` or `__`
/// whose next character is not a space opens, one whose previous character is not a space
/// closes, and a closer takes the nearest opener of its mark before it in the line. A `__`
/// between two letters or digits opens or closes nothing (`a__b`), as in Markdown. An unpaired
/// mark stays (`2**10`, `**/*.ts`), and so do a lone `*` or `_` and runs of three or more.
fn without_strong(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let word = |at: Option<usize>| {
        at.and_then(|at| chars.get(at))
            .is_some_and(|c| c.is_alphanumeric())
    };
    let space = |at: Option<usize>| {
        at.and_then(|at| chars.get(at))
            .is_none_or(|c| c.is_whitespace())
    };
    // Positions of the marks taken off, each two characters long.
    let mut paired = Vec::new();
    let mut open: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
    let mut i = 0;
    while i < chars.len() {
        let mark = chars[i];
        let run = chars[i..].iter().take_while(|&&c| c == mark).count();
        let slot = match mark {
            '*' => 0,
            '_' => 1,
            _ => {
                i += 1;
                continue;
            }
        };
        if run == 2 {
            let before = i.checked_sub(1);
            let intraword = mark == '_' && word(before) && word(Some(i + 2));
            let closes = !intraword && !space(before);
            let opens = !intraword && !space(Some(i + 2));
            match open[slot].last() {
                Some(&opener) if closes => {
                    open[slot].pop();
                    paired.extend([opener, i]);
                }
                _ if opens => open[slot].push(i),
                _ => {}
            }
        }
        i += run;
    }
    paired.sort_unstable();
    let mut out = String::with_capacity(text.len());
    let mut taken = paired.into_iter().peekable();
    let mut at = 0;
    while at < chars.len() {
        if taken.next_if_eq(&at).is_some() {
            at += 2;
            continue;
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Markdown memo's preview.
    fn preview(text: &str) -> String {
        preview_of(text.as_bytes(), true).unwrap()
    }

    /// Any other text memo's (a `.txt`, a `.py`).
    fn plain(text: &str) -> String {
        preview_of(text.as_bytes(), false).unwrap()
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
        assert_eq!(preview_of(b"t\n\xff\xfe body", true), None);
        // Cut at the end only: what comes before.
        assert_eq!(
            preview_of(b"t\nbody \xea\xb0", true).as_deref(),
            Some("body")
        );
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
    fn unpaired_strong_marks_stay_in_markdown() {
        assert_eq!(preview("t\n2**10 은 1024"), "2**10 은 1024");
        assert_eq!(preview("t\n**/*.ts 를 본다"), "**/*.ts 를 본다");
        // A space inside the mark, a run of three, an empty pair.
        assert_eq!(
            preview("t\n** 띄움** 과 *** 과 ****"),
            "** 띄움** 과 *** 과 ****"
        );
        assert_eq!(preview("t\n**가** 2**10 **나**"), "가 2**10 나");
        // `__` between two letters neither opens nor closes, though another would pair it.
        assert_eq!(preview("t\nsnake__case 와 __굵게__"), "snake__case 와 굵게");
        assert_eq!(preview("t\na__b__c"), "a__b__c");
        assert_eq!(preview("t\n__가__나__다__"), "가__나__다");
        // A run of three is no strong mark, paired or not.
        assert_eq!(preview("t\n***가***"), "***가***");
    }

    #[test]
    fn a_code_memo_keeps_its_boxes_strong_marks_and_fences() {
        assert_eq!(
            plain("t\ndef __init__(self, **kwargs):\n    x = 2**10\nif __name__ == \"__main__\":"),
            "def __init__(self, **kwargs): x = 2**10 if __name__ == \"__main__\":"
        );
        assert_eq!(
            plain("t\n- [ ] 우유\n```\n**굵게**"),
            "[ ] 우유 ``` **굵게**"
        );
    }

    #[test]
    fn markdown_is_the_editors_markdown() {
        assert!(is_markdown("회의.md", None));
        assert!(is_markdown("회의.MD", None));
        assert!(is_markdown("a.markdown", None));
        assert!(!is_markdown("a.txt", None));
        assert!(!is_markdown("a.py", None));
        assert!(!is_markdown(".md", None));
        assert!(!is_markdown("md", None));
        // The chosen language decides.
        assert!(is_markdown("a.txt", Some("markdown")));
        assert!(!is_markdown("a.md", Some("python")));
    }

    #[test]
    fn a_fence_with_a_backtick_after_it_is_text() {
        assert_eq!(preview("t\n```ts 인라인``` 뒤 글"), "```ts 인라인``` 뒤 글");
        // Tildes take any text after them.
        assert_eq!(preview("t\n~~~ `a`\nls"), "ls");
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
        let text = preview_of(&bytes, true).unwrap();
        assert!(!text.contains('\u{fffd}'), "{text}");
        assert_eq!(text, "가".repeat(PREVIEW_CHARS));
    }

    #[test]
    fn binary_has_none() {
        assert_eq!(preview_of(b"t\nabc\0def", true), None);
    }

    #[test]
    fn a_file_is_read_from_its_front() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, format!("t\n본문\n{}", "x".repeat(10_000))).unwrap();
        let text = read_preview(&path, true).unwrap().unwrap();
        assert!(text.starts_with("본문 x"), "{text}");
    }
}
