//! VS Code's manifests, themes and language configurations are JSONC: JSON with `//` and `/* */`
//! comments and trailing commas. `serde_json` takes neither, so they are removed first. The
//! frontend's src/core/jsonc.ts applies the same rules to the files it reads itself.

/// `text` with comments removed and trailing commas dropped; strings are left as they are. The
/// cut points are ASCII delimiters, so the result is still valid UTF-8.
pub fn strip_jsonc(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                out.push(b'"');
                i += 1;
                while i < bytes.len() {
                    let c = bytes[i];
                    out.push(c);
                    i += 1;
                    if c == b'\\' && i < bytes.len() {
                        out.push(bytes[i]);
                        i += 1;
                    } else if c == b'"' {
                        break;
                    }
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => i = line_comment_end(bytes, i),
            b'/' if bytes.get(i + 1) == Some(&b'*') => i = block_comment_end(bytes, i),
            b',' => {
                let next = next_significant(bytes, i + 1);
                if matches!(bytes.get(next), Some(b'}') | Some(b']')) {
                    i += 1; // drop the comma; the loop still removes any comment after it
                } else {
                    out.push(b',');
                    i += 1;
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8(out).expect("only whole comments were removed from valid UTF-8")
}

fn line_comment_end(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i] != b'\n' {
        i += 1;
    }
    i
}

fn block_comment_end(bytes: &[u8], mut i: usize) -> usize {
    i += 2;
    while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
        i += 1;
    }
    (i + 2).min(bytes.len())
}

/// The index of the next byte that is neither whitespace nor part of a comment.
fn next_significant(bytes: &[u8], mut i: usize) -> usize {
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes[i..].starts_with(b"//") {
            i = line_comment_end(bytes, i);
        } else if bytes[i..].starts_with(b"/*") {
            i = block_comment_end(bytes, i);
        } else {
            return i;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_and_trailing_commas_go_and_strings_stay() {
        let text = r#"{
  // line comment with "quotes" and a trailing comma, inside
  "a": "// not a comment, /* nor this */",
  "b": [1, 2, /* in-line */ 3,],
  "c": "escaped \" quote, still a string", /* block
  comment */
}"#;
        let value: serde_json::Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(value["a"], "// not a comment, /* nor this */");
        assert_eq!(value["b"], serde_json::json!([1, 2, 3]));
        assert_eq!(value["c"], "escaped \" quote, still a string");
    }

    #[test]
    fn a_comma_before_a_comment_before_a_closing_bracket_is_trailing() {
        let value: serde_json::Value =
            serde_json::from_str(&strip_jsonc("[1, // last\n]")).unwrap();
        assert_eq!(value, serde_json::json!([1]));
    }

    #[test]
    fn plain_json_passes_through_unchanged() {
        let text = r#"{"a": [1, 2], "b": "x/y"}"#;
        assert_eq!(strip_jsonc(text), text);
    }

    #[test]
    fn korean_in_comments_and_strings_survives() {
        let value: serde_json::Value =
            serde_json::from_str(&strip_jsonc("{\"이름\": \"메모\" /* 주석 */}")).unwrap();
        assert_eq!(value["이름"], "메모");
    }
}
