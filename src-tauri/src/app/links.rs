//! `open_link`: a link pressed in the Markdown preview opens in the system's own app for it
//! (spec 2026-11-14 md-preview 「링크」). The frontend checks the scheme too
//! (src/viewer/links.ts `isOpenableLink`); this check is the one that holds, since `open` would
//! also run a `file:` URL or an app's own scheme.

use std::io;

/// The schemes a link may have; the frontend's `OPENABLE_SCHEMES` is the same list.
pub const OPENABLE_SCHEMES: [&str; 3] = ["http", "https", "mailto"];
/// The longest URL taken, in bytes.
pub const MAX_URL_LENGTH: usize = 8192;

/// Why `url` is not opened, or `None` when it may be.
pub fn check_url(url: &str) -> Option<&'static str> {
    if url.len() > MAX_URL_LENGTH {
        return Some("too long");
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Some("a space or a control character");
    }
    let Some((scheme, _)) = url.split_once(':') else {
        return Some("no scheme");
    };
    if OPENABLE_SCHEMES
        .iter()
        .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
    {
        None
    } else {
        Some("a scheme that is not opened")
    }
}

/// Opens `url`, which `check_url` has passed, with macOS `open`.
#[cfg(target_os = "macos")]
pub fn open_url(url: &str) -> io::Result<()> {
    let status = std::process::Command::new("open").arg(url).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("open {url}: {status}")))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn open_url(_url: &str) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "지원하지 않음"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_schemes_pass_whatever_their_case() {
        for url in [
            "https://example.com/a?b=1#c",
            "http://example.com",
            "HTTPS://EXAMPLE.COM",
            "mailto:a@example.com",
            "MailTo:a@example.com",
            "https://example.com/%ED%9A%8C%EC%9D%98",
        ] {
            assert_eq!(check_url(url), None, "{url}");
        }
    }

    #[test]
    fn every_other_scheme_is_refused() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "ftp://example.com",
            "data:text/html,x",
            "tote-file://localhost/x",
            "x-apple.systempreferences:com.apple.preference",
            "vscode://file/etc/passwd",
            "httpx://example.com",
            "/Applications/Calculator.app",
            "a.md",
            "",
        ] {
            assert!(check_url(url).is_some(), "{url}");
        }
    }

    #[test]
    fn a_space_or_a_control_character_is_refused() {
        for url in [
            "https://example.com/a b",
            "https://example.com/\n-a",
            "https://example.com/\t",
            "https://example.com/\u{0}",
            " https://example.com",
        ] {
            assert!(check_url(url).is_some(), "{url:?}");
        }
    }

    #[test]
    fn a_url_past_the_limit_is_refused() {
        let base = "https://example.com/";
        let at_limit = format!("{base}{}", "a".repeat(MAX_URL_LENGTH - base.len()));
        assert_eq!(check_url(&at_limit), None);
        assert!(check_url(&format!("{at_limit}a")).is_some());
    }
}
