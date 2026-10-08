//! File-name rules shared by workspace folders, memo titles and imports.

/// Characters macOS, Windows or a shell chokes on in a file name (spec 「제목 자동 생성」).
const FORBIDDEN: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
/// APFS and most file systems cap a name at 255 bytes.
const MAX_NAME_BYTES: usize = 255;

/// Splits at the last dot: `a.tar.gz` → (`a.tar`, `gz`). A leading dot belongs to the stem and
/// no dot means no extension. `splitName` in src/core/names.ts must agree.
pub fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot + 1..]),
        _ => (name, ""),
    }
}

pub fn join_name(stem: &str, ext: &str) -> String {
    if ext.is_empty() {
        stem.to_string()
    } else {
        format!("{stem}.{ext}")
    }
}

/// A name tote may create in a workspace: not empty, no forbidden or control characters, not a
/// dot file (listings skip those), no surrounding spaces, at most 255 bytes.
pub fn is_valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_BYTES
        && name.trim() == name
        && !name.starts_with('.')
        && !name
            .chars()
            .any(|c| FORBIDDEN.contains(&c) || c.is_control())
}

/// `stem.ext`, then `stem 2.ext`, `stem 3.ext`, … — the first one `is_taken` lets through.
pub fn unique_file_name(stem: &str, ext: &str, mut is_taken: impl FnMut(&str) -> bool) -> String {
    let mut candidate = join_name(stem, ext);
    let mut n = 2;
    while is_taken(&candidate) {
        candidate = join_name(&format!("{stem} {n}"), ext);
        n += 1;
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_matches_the_frontend() {
        assert_eq!(split_name("회의 준비.md"), ("회의 준비", "md"));
        assert_eq!(split_name("archive.tar.gz"), ("archive.tar", "gz"));
        assert_eq!(split_name(".env"), (".env", ""));
        assert_eq!(split_name("Makefile"), ("Makefile", ""));
        assert_eq!(split_name("a."), ("a", ""));
        assert_eq!(join_name("a", ""), "a");
        assert_eq!(join_name("a", "md"), "a.md");
    }

    #[test]
    fn valid_names() {
        assert!(is_valid_file_name("회의 준비.md"));
        for bad in [
            "", ".hidden", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b",
            "a\u{0}b", "a\u{85}b", " a", "a ",
        ] {
            assert!(!is_valid_file_name(bad), "{bad:?} should be rejected");
        }
        assert!(!is_valid_file_name(&"가".repeat(86))); // 258 bytes
    }

    #[test]
    fn unique_names_count_up_from_two() {
        let taken = ["메모.md", "메모 2.md"];
        assert_eq!(
            unique_file_name("메모", "md", |n| taken.contains(&n)),
            "메모 3.md"
        );
        assert_eq!(
            unique_file_name("새", "md", |n| taken.contains(&n)),
            "새.md"
        );
        assert_eq!(
            unique_file_name("Makefile", "", |n| n == "Makefile"),
            "Makefile 2"
        );
    }
}
