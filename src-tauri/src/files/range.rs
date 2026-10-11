//! The `tote-file` scheme: `/<token>` → the file's bytes, whole or as one byte range. Single
//! ranges only — WebKit's media loader never asks for multipart ranges.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{header, Method, Response, StatusCode};

use super::TokenStore;

/// The most a range of any form (`bytes=N-`, `bytes=N-M`, `bytes=-N`) gets in one answer: the
/// answer is read whole into memory. WebKit's media loader opens with `bytes=0-` even for a file
/// of gigabytes; a shorter 206 is allowed, and the media loader and the large text viewer both
/// ask on from where it ended.
pub const MAX_RANGE: u64 = 8 * 1024 * 1024;

/// The most a request without a range gets: past it the answer is 413 rather than the file read
/// whole into memory. The large text viewer always reads by range and WebKit plays media by
/// range, so what meets this is an image too big to show, and an error is the right answer for it.
pub const MAX_FULL_RESPONSE: u64 = 64 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum RangeSpec {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

/// Single byte ranges only; WebKit's media loader never asks for multipart ranges. Malformed
/// headers are ignored (full response), as HTTP allows.
pub fn parse_range(value: Option<&str>, len: u64) -> RangeSpec {
    let Some(spec) = value.and_then(|v| v.trim().strip_prefix("bytes=")) else {
        return RangeSpec::Full;
    };
    if spec.contains(',') {
        return RangeSpec::Full;
    }
    let Some((a, b)) = spec.split_once('-') else {
        return RangeSpec::Full;
    };
    let (a, b) = (a.trim(), b.trim());
    let (start, end) = if a.is_empty() {
        let Ok(suffix) = b.parse::<u64>() else {
            return RangeSpec::Full;
        };
        if suffix == 0 || len == 0 {
            return RangeSpec::Unsatisfiable;
        }
        (len.saturating_sub(suffix), len - 1)
    } else {
        let Ok(start) = a.parse::<u64>() else {
            return RangeSpec::Full;
        };
        let end = if b.is_empty() {
            len.saturating_sub(1)
        } else {
            let Ok(end) = b.parse::<u64>() else {
                return RangeSpec::Full;
            };
            end.min(len.saturating_sub(1))
        };
        (start, end)
    };
    if len == 0 || start >= len || start > end {
        return RangeSpec::Unsatisfiable;
    }
    RangeSpec::Partial {
        start,
        end: end.min(start.saturating_add(MAX_RANGE - 1)),
    }
}

fn read_slice(path: &Path, start: u64, end: u64) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0; (end - start + 1) as usize];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

pub fn respond(
    store: &TokenStore,
    method: &Method,
    uri_path: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    if method == Method::OPTIONS {
        return preflight();
    }
    let token = uri_path.trim_start_matches('/');
    let Some(path) = store.resolve(token) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let Ok(len) = std::fs::metadata(&path).map(|m| m.len()) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let builder = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        // fetch() in the large text viewer reads these; without the list a script sees none.
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Range, Content-Length, Accept-Ranges",
        )
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, content_type(&path));
    let result = match parse_range(range, len) {
        RangeSpec::Full if len > MAX_FULL_RESPONSE => Ok(builder
            .status(StatusCode::PAYLOAD_TOO_LARGE)
            .body(Vec::new())),
        RangeSpec::Full => std::fs::read(&path).map(|body| {
            builder
                .status(StatusCode::OK)
                .header(header::CONTENT_LENGTH, len)
                .body(body)
        }),
        RangeSpec::Partial { start, end } => read_slice(&path, start, end).map(|body| {
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_LENGTH, end - start + 1)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .body(body)
        }),
        RangeSpec::Unsatisfiable => Ok(builder
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new())),
    };
    match result {
        Ok(Ok(res)) => res,
        Err(err) if err.kind() == io::ErrorKind::NotFound => status_only(StatusCode::NOT_FOUND),
        _ => status_only(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// The answer to WebKit's CORS preflight for the large text viewer's `fetch` with a `Range`
/// header: the page's origin is not `tote-file`'s, and without these the GET never goes out.
fn preflight() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
        .body(Vec::new())
        .expect("static response is valid")
}

/// An empty answer. Readable across origins, so a viewer's fetch sees the status and not a
/// network error.
pub(crate) fn status_only(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .expect("static response is valid")
}

/// Media types for what the media viewer plays (spec 「번들 확장」 4) and text for the large
/// text viewer; everything else is opaque bytes.
pub fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic") => "image/heic",
        Some("bmp") => "image/bmp",
        Some("tif" | "tiff") => "image/tiff",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("aac") => "audio/aac",
        Some("flac") => "audio/flac",
        Some("ogg") => "audio/ogg",
        Some("aiff") => "audio/aiff",
        Some("txt" | "md" | "markdown" | "log" | "json" | "csv") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    use tauri::http::{header, Method, StatusCode};

    #[test]
    fn no_header_means_full() {
        assert_eq!(parse_range(None, 1000), RangeSpec::Full);
    }

    #[test]
    fn open_ended_range_runs_to_eof() {
        assert_eq!(
            parse_range(Some("bytes=0-"), 1000),
            RangeSpec::Partial { start: 0, end: 999 }
        );
    }

    #[test]
    fn an_open_ended_range_on_a_big_file_is_cut_to_a_bounded_slice() {
        let len = 3 * MAX_RANGE;
        assert_eq!(
            parse_range(Some("bytes=0-"), len),
            RangeSpec::Partial {
                start: 0,
                end: MAX_RANGE - 1
            }
        );
        assert_eq!(
            parse_range(Some("bytes=10-"), len),
            RangeSpec::Partial {
                start: 10,
                end: 10 + MAX_RANGE - 1
            }
        );
        assert_eq!(
            parse_range(Some(&format!("bytes={}-", len - 5)), len),
            RangeSpec::Partial {
                start: len - 5,
                end: len - 1
            }
        );
    }

    #[test]
    fn a_closed_range_is_cut_to_the_limit_too() {
        let len = 3 * MAX_RANGE;
        assert_eq!(
            parse_range(Some(&format!("bytes=0-{len}")), len),
            RangeSpec::Partial {
                start: 0,
                end: MAX_RANGE - 1
            }
        );
        // A suffix range asks for the last bytes; it gets the first of them and asks on.
        assert_eq!(
            parse_range(Some(&format!("bytes=-{len}")), len),
            RangeSpec::Partial {
                start: 0,
                end: MAX_RANGE - 1
            }
        );
    }

    #[test]
    fn webkit_probe_range() {
        assert_eq!(
            parse_range(Some("bytes=0-1"), 1000),
            RangeSpec::Partial { start: 0, end: 1 }
        );
    }

    #[test]
    fn suffix_range_takes_last_bytes() {
        assert_eq!(
            parse_range(Some("bytes=-500"), 1000),
            RangeSpec::Partial {
                start: 500,
                end: 999
            }
        );
        assert_eq!(
            parse_range(Some("bytes=-5000"), 1000),
            RangeSpec::Partial { start: 0, end: 999 }
        );
    }

    #[test]
    fn end_past_eof_is_clamped() {
        assert_eq!(
            parse_range(Some("bytes=10-99999"), 1000),
            RangeSpec::Partial {
                start: 10,
                end: 999
            }
        );
    }

    #[test]
    fn start_at_or_past_eof_is_unsatisfiable() {
        assert_eq!(
            parse_range(Some("bytes=1000-"), 1000),
            RangeSpec::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=5-2"), 1000),
            RangeSpec::Unsatisfiable
        );
        assert_eq!(parse_range(Some("bytes=0-"), 0), RangeSpec::Unsatisfiable);
        assert_eq!(
            parse_range(Some("bytes=-0"), 1000),
            RangeSpec::Unsatisfiable
        );
    }

    #[test]
    fn malformed_or_multi_range_falls_back_to_full() {
        assert_eq!(parse_range(Some("items=0-1"), 1000), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 1000), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=abc-"), 1000), RangeSpec::Full);
    }

    fn fixture(name: &str, bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        fs::write(&path, bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn unknown_tokens_and_path_like_uris_are_404() {
        let (_dir, path) = fixture("a.txt", b"secret");
        let store = TokenStore::default();
        let _token = store.issue("w", "o", path.clone());
        assert_eq!(
            respond(&store, &Method::GET, "/deadbeef", None).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            respond(&store, &Method::GET, &format!("/{}", path.display()), None).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            respond(&store, &Method::GET, "/../../etc/passwd", None).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn a_range_request_on_a_korean_file_name_returns_a_206_slice_with_readable_headers() {
        let (_dir, path) = fixture("영상 테스트.bin", b"0123456789");
        let store = TokenStore::default();
        let token = store.issue("w", "o", path);
        let res = respond(
            &store,
            &Method::GET,
            &format!("/{token}"),
            Some("bytes=2-5"),
        );
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(res.body(), b"2345");
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(res.headers()[header::CONTENT_LENGTH], "4");
        assert_eq!(res.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        // Without this a script's fetch() cannot read Content-Range (spike 「검증하지 않은 것」).
        assert_eq!(
            res.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS],
            "Content-Range, Content-Length, Accept-Ranges"
        );
    }

    #[test]
    fn a_cors_preflight_allows_a_range_get_without_reading_the_file() {
        // The large text viewer's fetch() with a Range header comes from another origin
        // (tauri://localhost); WebKit may ask first with OPTIONS.
        let store = TokenStore::default();
        let res = respond(
            &store,
            &Method::OPTIONS,
            "/no-such-token",
            Some("bytes=0-1"),
        );
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_METHODS], "GET");
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS], "Range");
        assert!(res.body().is_empty());
    }

    #[test]
    fn a_full_request_returns_the_whole_file_with_its_type() {
        let (_dir, path) = fixture("clip.mp4", b"abc");
        let store = TokenStore::default();
        let token = store.issue("w", "o", path);
        let res = respond(&store, &Method::GET, &format!("/{token}"), None);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"abc");
        assert_eq!(res.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(res.headers()[header::CONTENT_LENGTH], "3");
    }

    #[test]
    fn a_full_request_over_the_limit_is_413_and_under_it_is_200() {
        let dir = tempfile::tempdir().unwrap();
        let store = TokenStore::default();
        let sparse = |name: &str, len: u64| {
            let path = dir.path().join(name);
            fs::File::create(&path).unwrap().set_len(len).unwrap();
            store.issue("w", "o", path)
        };
        let over = sparse("over.bin", MAX_FULL_RESPONSE + 1);
        let res = respond(&store, &Method::GET, &format!("/{over}"), None);
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(res.body().is_empty());
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        let under = sparse("under.bin", MAX_RANGE + 1);
        let res = respond(&store, &Method::GET, &format!("/{under}"), None);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body().len() as u64, MAX_RANGE + 1);
    }

    #[test]
    fn an_unsatisfiable_range_is_416_and_a_vanished_file_404() {
        let (dir, path) = fixture("a.bin", b"abc");
        let store = TokenStore::default();
        let token = store.issue("w", "o", path.clone());
        let res = respond(
            &store,
            &Method::GET,
            &format!("/{token}"),
            Some("bytes=10-"),
        );
        assert_eq!(res.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes */3");
        fs::remove_file(&path).unwrap();
        assert_eq!(
            respond(&store, &Method::GET, &format!("/{token}"), None).status(),
            StatusCode::NOT_FOUND
        );
        drop(dir);
    }

    #[test]
    fn a_revoked_token_is_404_even_while_the_file_exists() {
        let (_dir, path) = fixture("a.bin", b"abc");
        let store = TokenStore::default();
        let token = store.issue("w", "o", path);
        store.revoke("w", "o");
        assert_eq!(
            respond(
                &store,
                &Method::GET,
                &format!("/{token}"),
                Some("bytes=0-1")
            )
            .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn content_types_cover_what_the_media_viewer_plays() {
        for (name, ty) in [
            ("a.png", "image/png"),
            ("a.JPG", "image/jpeg"),
            ("a.gif", "image/gif"),
            ("a.webp", "image/webp"),
            ("a.heic", "image/heic"),
            ("a.svg", "image/svg+xml"),
            ("a.mp4", "video/mp4"),
            ("a.mov", "video/quicktime"),
            ("a.m4v", "video/x-m4v"),
            ("a.webm", "video/webm"),
            ("a.mp3", "audio/mpeg"),
            ("a.m4a", "audio/mp4"),
            ("a.wav", "audio/wav"),
            ("a.aac", "audio/aac"),
            ("a.flac", "audio/flac"),
            ("a.ogg", "audio/ogg"),
            ("a.aiff", "audio/aiff"),
            ("a.txt", "text/plain; charset=utf-8"),
            ("a.md", "text/plain; charset=utf-8"),
            ("a.bin", "application/octet-stream"),
        ] {
            assert_eq!(content_type(Path::new(name)), ty, "{name}");
        }
    }
}
