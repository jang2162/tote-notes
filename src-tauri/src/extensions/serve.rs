//! The `tote-ext` scheme: `/<extension id>/<path>` → a file of a bundled extension, for the
//! viewer iframes (spec 「뷰어」). Only bundled, enabled extensions are served, and only files
//! inside their folder.

use std::path::Path;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Response, StatusCode};

use super::file_inside;
use super::registry::Registry;
use super::Source;
use crate::files::range::{self, status_only};

pub fn respond(registry: &Registry, uri_path: &str) -> Response<Vec<u8>> {
    let Ok(decoded) = percent_decode_str(uri_path).decode_utf8() else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let Some((id, relative)) = decoded.trim_start_matches('/').split_once('/') else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let Some(extension) = registry
        .extensions
        .iter()
        .find(|e| e.id == id && e.source == Source::Bundled && e.enabled)
    else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let Some(file) = file_inside(&extension.path, relative) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    match std::fs::read(&file) {
        Ok(body) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&file))
            .header(header::CONTENT_LENGTH, body.len())
            .body(body)
            .expect("static headers are valid"),
        Err(_) => status_only(StatusCode::NOT_FOUND),
    }
}

/// The web files a viewer is made of; media and the rest as the `tote-file` scheme types them.
/// Kept apart from that table so a file served by token is never typed as a page or a script.
fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("woff2") => "font/woff2",
        _ => range::content_type(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::appdata::ExtensionSettings;
    use crate::extensions::registry::build;
    use crate::extensions::tests::write_extension;
    use crate::extensions::ExtensionStore;

    fn registry(dir: &Path) -> Registry {
        let bundled = dir.join("bundled");
        let user = dir.join("user");
        let md = write_extension(
            &bundled,
            "tote.markdown-preview",
            r#"{"name": "markdown-preview", "publisher": "tote", "version": "1"}"#,
        );
        fs::write(md.join("viewer.html"), "<!doctype html><title>md</title>").unwrap();
        fs::create_dir_all(md.join("vendor")).unwrap();
        fs::write(md.join("vendor/marked.js"), "var marked;").unwrap();
        let evil = write_extension(
            &user,
            "someone.evil@1",
            r#"{"name": "evil", "publisher": "someone", "version": "1"}"#,
        );
        fs::write(evil.join("viewer.html"), "<script>steal()</script>").unwrap();
        fs::write(dir.join("secret.txt"), "secret").unwrap();
        build(
            &ExtensionStore::new(bundled, user).scan(),
            &ExtensionSettings::default(),
        )
    }

    #[test]
    fn serves_files_of_bundled_extensions_with_their_type() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());
        let res = respond(&registry, "/tote.markdown-preview/viewer.html");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(res.body(), b"<!doctype html><title>md</title>");
        let js = respond(&registry, "/tote.markdown-preview/vendor/marked.js");
        assert_eq!(
            js.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        // Percent-encoded ids and paths arrive decoded.
        assert_eq!(
            respond(&registry, "/tote.markdown-preview/vendor%2Fmarked.js").status(),
            StatusCode::OK
        );
    }

    #[test]
    fn user_extensions_escapes_and_missing_files_are_404() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());
        for uri in [
            "/someone.evil/viewer.html",
            "/tote.markdown-preview/../../secret.txt",
            "/tote.markdown-preview/missing.html",
            "/tote.markdown-preview/",
            "/",
            "/nobody.ext/viewer.html",
            "/tote.markdown-preview/package.json/..",
        ] {
            assert_eq!(
                respond(&registry, uri).status(),
                StatusCode::NOT_FOUND,
                "{uri}"
            );
        }
    }
}
