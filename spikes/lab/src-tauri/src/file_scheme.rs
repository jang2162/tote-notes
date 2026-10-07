use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::http::{header, Response, StatusCode};

/// Maps tokens to file paths so a viewer URL never carries a path it could rewrite. A token serves every request until the app quits: one seek alone sends dozens of Range requests to the same URL.
#[derive(Clone, Default)]
pub struct TokenStore(Arc<Mutex<HashMap<String, PathBuf>>>);

impl TokenStore {
    pub fn issue(&self, path: PathBuf) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.0.lock().unwrap().insert(token.clone(), path);
        token
    }

    pub fn resolve(&self, token: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().get(token).cloned()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RangeSpec {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

/// Single byte ranges only; WebKit's media loader never asks for multipart ranges.
/// Malformed headers are ignored (full response), as HTTP allows.
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
    RangeSpec::Partial { start, end }
}

pub fn respond(store: &TokenStore, uri_path: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let token = uri_path.trim_start_matches('/');
    let Some(path) = store.resolve(token) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let Ok(len) = std::fs::metadata(&path).map(|m| m.len()) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let builder = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, content_type(&path));
    let result = match parse_range(range, len) {
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
        _ => status_only(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn status_only(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .expect("static response is valid")
}

fn read_slice(path: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0; (end - start + 1) as usize];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    use tauri::http::{header, StatusCode};

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
        std::fs::File::create(&path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
        (dir, path)
    }

    #[test]
    fn unknown_token_is_404() {
        let store = TokenStore::default();
        assert_eq!(
            respond(&store, "/deadbeef", None).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn path_like_uri_is_not_resolved_as_a_path() {
        let (_dir, path) = fixture("a.txt", b"secret");
        let store = TokenStore::default();
        let _token = store.issue(path.clone());
        let uri = format!("/{}", path.display());
        assert_eq!(respond(&store, &uri, None).status(), StatusCode::NOT_FOUND);
        assert_eq!(
            respond(&store, "/../../etc/passwd", None).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn range_request_on_korean_filename_returns_206_slice() {
        let (_dir, path) = fixture("영상 테스트.bin", b"0123456789");
        let store = TokenStore::default();
        let token = store.issue(path);
        let res = respond(&store, &format!("/{token}"), Some("bytes=2-5"));
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(res.body(), b"2345");
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(res.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }

    #[test]
    fn full_request_returns_200_whole_file() {
        let (_dir, path) = fixture("clip.mp4", b"abc");
        let store = TokenStore::default();
        let token = store.issue(path);
        let res = respond(&store, &format!("/{token}"), None);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"abc");
        assert_eq!(res.headers()[header::CONTENT_TYPE], "video/mp4");
    }

    #[test]
    fn unsatisfiable_range_is_416_with_size() {
        let (_dir, path) = fixture("a.bin", b"abc");
        let store = TokenStore::default();
        let token = store.issue(path);
        let res = respond(&store, &format!("/{token}"), Some("bytes=10-"));
        assert_eq!(res.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes */3");
    }
}
