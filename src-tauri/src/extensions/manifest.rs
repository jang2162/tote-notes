//! A VS Code `package.json` reduced to what tote uses (spec 「패키지 형식」): identity, the
//! declarative contributions, and tote's own `tote.viewers`. `main`, `browser` and
//! `activationEvents` are never read — extensions do not run code here.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::jsonc::strip_jsonc;

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("package.json is not JSON: {0}")]
    Json(String),
    #[error("package.json has no {0}")]
    Missing(&'static str),
    #[error("not a usable extension id: {0}")]
    BadId(String),
    #[error("a contribution path must stay inside the extension: {0}")]
    BadPath(String),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageContribution {
    pub id: String,
    pub aliases: Vec<String>,
    /// Lower-case, without the leading dot, deduplicated.
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
    pub first_line: Option<String>,
    pub configuration: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrammarContribution {
    pub language: Option<String>,
    pub scope_name: String,
    pub path: String,
    pub embedded_languages: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeContribution {
    pub label: String,
    pub ui_theme: String,
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewerKind {
    Primary,
    Preview,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerContribution {
    pub id: String,
    pub kind: ViewerKind,
    pub extensions: Vec<String>,
    pub entry: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub publisher: String,
    pub name: String,
    pub version: String,
    pub display_name: String,
    pub languages: Vec<LanguageContribution>,
    pub grammars: Vec<GrammarContribution>,
    pub themes: Vec<ThemeContribution>,
    pub viewers: Vec<ViewerContribution>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    publisher: Option<String>,
    name: Option<String>,
    version: Option<String>,
    display_name: Option<String>,
    #[serde(default)]
    contributes: RawContributes,
    #[serde(default)]
    tote: RawTote,
}

#[derive(Default, Deserialize)]
struct RawContributes {
    #[serde(default)]
    languages: Vec<RawLanguage>,
    #[serde(default)]
    grammars: Vec<RawGrammar>,
    #[serde(default)]
    themes: Vec<RawTheme>,
}

#[derive(Default, Deserialize)]
struct RawTote {
    #[serde(default)]
    viewers: Vec<RawViewer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLanguage {
    id: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    filenames: Vec<String>,
    first_line: Option<String>,
    configuration: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGrammar {
    language: Option<String>,
    scope_name: String,
    path: String,
    #[serde(default)]
    embedded_languages: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTheme {
    label: String,
    #[serde(default = "default_ui_theme")]
    ui_theme: String,
    path: String,
}

fn default_ui_theme() -> String {
    "vs-dark".into()
}

#[derive(Deserialize)]
struct RawViewer {
    id: String,
    kind: ViewerKind,
    #[serde(default)]
    extensions: Vec<String>,
    entry: String,
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Manifest, ManifestError> {
        let raw: Raw = serde_json::from_str(&strip_jsonc(text))
            .map_err(|err| ManifestError::Json(err.to_string()))?;
        let name = raw.name.ok_or(ManifestError::Missing("name"))?;
        let publisher = raw.publisher.ok_or(ManifestError::Missing("publisher"))?;
        let version = raw.version.ok_or(ManifestError::Missing("version"))?;
        for part in [&name, &publisher] {
            if !is_identifier(part) {
                return Err(ManifestError::BadId(part.clone()));
            }
        }
        if version.trim().is_empty() {
            return Err(ManifestError::Missing("version"));
        }
        let languages = raw
            .contributes
            .languages
            .into_iter()
            .map(|l| {
                Ok(LanguageContribution {
                    id: l.id,
                    aliases: l.aliases,
                    extensions: normalise_extensions(&l.extensions),
                    filenames: l.filenames,
                    first_line: l.first_line,
                    configuration: l.configuration.map(|p| relative_path(&p)).transpose()?,
                })
            })
            .collect::<Result<_, ManifestError>>()?;
        let grammars = raw
            .contributes
            .grammars
            .into_iter()
            .map(|g| {
                Ok(GrammarContribution {
                    language: g.language,
                    scope_name: g.scope_name,
                    path: relative_path(&g.path)?,
                    embedded_languages: g.embedded_languages,
                })
            })
            .collect::<Result<_, ManifestError>>()?;
        let themes = raw
            .contributes
            .themes
            .into_iter()
            .map(|t| {
                Ok(ThemeContribution {
                    label: t.label,
                    ui_theme: t.ui_theme,
                    path: relative_path(&t.path)?,
                })
            })
            .collect::<Result<_, ManifestError>>()?;
        let viewers = raw
            .tote
            .viewers
            .into_iter()
            .map(|v| {
                Ok(ViewerContribution {
                    id: v.id,
                    kind: v.kind,
                    extensions: normalise_extensions(&v.extensions),
                    entry: relative_path(&v.entry)?,
                })
            })
            .collect::<Result<_, ManifestError>>()?;
        Ok(Manifest {
            display_name: raw.display_name.unwrap_or_else(|| name.clone()),
            publisher,
            name,
            version,
            languages,
            grammars,
            themes,
            viewers,
        })
    }

    pub fn id(&self) -> String {
        format!("{}.{}", self.publisher, self.name)
    }
}

/// What VS Code accepts for `name` and `publisher`: letters, digits, `-` and `_`.
fn is_identifier(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn normalise_extensions(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for ext in raw {
        let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
        if !ext.is_empty() && !out.contains(&ext) {
            out.push(ext);
        }
    }
    out
}

/// A contribution path as a clean relative path: `./` dropped, `.` segments dropped; empty,
/// absolute, `..` and backslashes are refused — the path is joined under the extension folder
/// and must never leave it.
pub fn relative_path(raw: &str) -> Result<String, ManifestError> {
    if raw.contains('\\') || raw.starts_with('/') {
        return Err(ManifestError::BadPath(raw.to_string()));
    }
    let parts: Vec<&str> = raw
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.is_empty() || parts.contains(&"..") {
        return Err(ManifestError::BadPath(raw.to_string()));
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    pub(crate) fn fixture_vsix() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/tote-test-theme-0.0.1.vsix")
    }

    fn fixture_manifest() -> String {
        let file = std::fs::File::open(fixture_vsix()).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut entry = zip.by_name("extension/package.json").unwrap();
        let mut text = String::new();
        entry.read_to_string(&mut text).unwrap();
        text
    }

    #[test]
    fn parses_the_fixture_vsix_manifest() {
        let manifest = Manifest::parse(&fixture_manifest()).unwrap();
        assert_eq!(manifest.id(), "tote-test.test-theme");
        assert_eq!(manifest.version, "0.0.1");
        assert_eq!(manifest.display_name, "Tote Test Theme");
        assert_eq!(manifest.themes.len(), 1);
        assert_eq!(manifest.themes[0].label, "Tote Night");
        assert_eq!(manifest.themes[0].ui_theme, "vs-dark");
        assert_eq!(manifest.themes[0].path, "themes/night-color-theme.json");
        let lang = &manifest.languages[0];
        assert_eq!(lang.id, "totelang");
        assert_eq!(lang.extensions, vec!["tote"]); // dots dropped, lower-cased, deduplicated
        assert_eq!(lang.filenames, vec!["Totefile"]);
        assert_eq!(lang.first_line.as_deref(), Some("^#!.*\\btote\\b"));
        assert_eq!(
            lang.configuration.as_deref(),
            Some("language-configuration.json")
        );
        let grammar = &manifest.grammars[0];
        assert_eq!(grammar.language.as_deref(), Some("totelang"));
        assert_eq!(grammar.scope_name, "source.tote");
        assert_eq!(grammar.path, "syntaxes/tote.tmLanguage.json");
        assert_eq!(
            grammar
                .embedded_languages
                .get("meta.embedded.block.json")
                .map(String::as_str),
            Some("json")
        );
        let viewer = &manifest.viewers[0];
        assert_eq!(
            (viewer.id.as_str(), viewer.kind),
            ("tote-view", ViewerKind::Primary)
        );
        assert_eq!(viewer.extensions, vec!["tote"]);
        assert_eq!(viewer.entry, "viewer.html");
    }

    #[test]
    fn a_manifest_without_contributions_is_still_an_extension() {
        let manifest =
            Manifest::parse(r#"{"name": "empty", "publisher": "p", "version": "1.0.0"}"#).unwrap();
        assert_eq!(manifest.id(), "p.empty");
        assert_eq!(manifest.display_name, "empty");
        assert!(manifest.languages.is_empty() && manifest.themes.is_empty());
    }

    #[test]
    fn missing_or_bad_identity_is_an_error() {
        assert!(matches!(
            Manifest::parse(r#"{"publisher": "p", "version": "1"}"#),
            Err(ManifestError::Missing("name"))
        ));
        assert!(matches!(
            Manifest::parse(r#"{"name": "x", "version": "1"}"#),
            Err(ManifestError::Missing("publisher"))
        ));
        assert!(matches!(
            Manifest::parse(r#"{"name": "x", "publisher": "p"}"#),
            Err(ManifestError::Missing("version"))
        ));
        assert!(matches!(
            Manifest::parse(r#"{"name": "a b", "publisher": "p", "version": "1"}"#),
            Err(ManifestError::BadId(_))
        ));
        assert!(matches!(
            Manifest::parse("{ nope"),
            Err(ManifestError::Json(_))
        ));
    }

    #[test]
    fn contribution_paths_must_stay_inside_the_extension() {
        for bad in [
            "../x.json",
            "/etc/x.json",
            "a/../../x.json",
            "",
            "a\\b.json",
        ] {
            // Built with serde_json so the backslash case reaches the parser as a backslash and
            // not as the `\b` escape a format string would leave.
            let text = serde_json::json!({
                "name": "x", "publisher": "p", "version": "1",
                "contributes": {"themes": [{"label": "t", "uiTheme": "vs", "path": bad}]}
            })
            .to_string();
            assert!(
                matches!(Manifest::parse(&text), Err(ManifestError::BadPath(_))),
                "{bad:?}"
            );
        }
        assert_eq!(relative_path("./a/./b.json").unwrap(), "a/b.json");
        assert!(matches!(
            relative_path("a\\b.json"),
            Err(ManifestError::BadPath(_))
        ));
    }

    #[test]
    fn a_viewer_with_an_unknown_kind_is_an_error() {
        let text = r#"{"name": "x", "publisher": "p", "version": "1",
            "tote": {"viewers": [{"id": "v", "kind": "window", "extensions": ["a"], "entry": "v.html"}]}}"#;
        assert!(matches!(Manifest::parse(text), Err(ManifestError::Json(_))));
    }

    #[test]
    fn manifests_may_carry_comments() {
        let manifest = Manifest::parse(
            "{\n  // generated\n  \"name\": \"c\", \"publisher\": \"p\", \"version\": \"1\",\n}",
        )
        .unwrap();
        assert_eq!(manifest.id(), "p.c");
    }
}
