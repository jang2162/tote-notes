//! What the frontend receives (spec 「설치와 로딩」): every language, theme and viewer of the
//! enabled extensions, ordered so the first match wins — user extensions before bundled ones
//! unless the precedence setting says otherwise. Viewers come from bundled extensions only.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;

use super::manifest::ViewerKind;
use super::{ExtensionProblem, Scan, Source};
use crate::appdata::{ExtensionSettings, Precedence};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub extensions: Vec<ExtensionSummary>,
    pub languages: Vec<LanguageInfo>,
    /// Every grammar of the enabled extensions, including ones no language names (they exist
    /// for `include`), in the same precedence order.
    pub grammars: Vec<GrammarRef>,
    pub themes: Vec<ThemeInfo>,
    pub viewers: Vec<ViewerInfo>,
    pub problems: Vec<ExtensionProblem>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrammarRef {
    pub extension: String,
    pub language: Option<String>,
    pub scope_name: String,
    pub path: String,
    pub embedded_languages: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSummary {
    pub id: String,
    pub version: String,
    pub display_name: String,
    pub source: Source,
    pub enabled: bool,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInfo {
    pub id: String,
    /// The id of the extension contributing it.
    pub extension: String,
    pub aliases: Vec<String>,
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
    pub first_line: Option<String>,
    pub configuration: Option<String>,
    pub grammar: Option<GrammarInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrammarInfo {
    pub scope_name: String,
    pub path: String,
    pub embedded_languages: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    pub extension: String,
    pub label: String,
    pub ui_theme: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerInfo {
    pub extension: String,
    pub id: String,
    pub kind: ViewerKind,
    pub extensions: Vec<String>,
    pub entry: String,
}

pub fn build(scan: &Scan, settings: &ExtensionSettings) -> Registry {
    let enabled = |e: &super::Installed| {
        e.source == Source::Bundled || !settings.disabled.contains(&e.manifest.id())
    };
    let extensions = scan
        .extensions
        .iter()
        .map(|e| ExtensionSummary {
            id: e.manifest.id(),
            version: e.manifest.version.clone(),
            display_name: e.manifest.display_name.clone(),
            source: e.source,
            enabled: enabled(e),
            path: e.path.clone(),
        })
        .collect();
    let first = match settings.precedence {
        Precedence::User => Source::User,
        Precedence::Bundled => Source::Bundled,
    };
    let mut ordered: Vec<&super::Installed> =
        scan.extensions.iter().filter(|e| enabled(e)).collect();
    // A stable sort: within one side the scan order (name order) stays.
    ordered.sort_by_key(|e| e.source != first);
    let mut languages = Vec::new();
    let mut grammars = Vec::new();
    let mut themes = Vec::new();
    let mut viewers = Vec::new();
    for e in ordered {
        let id = e.manifest.id();
        for g in &e.manifest.grammars {
            grammars.push(GrammarRef {
                extension: id.clone(),
                language: g.language.clone(),
                scope_name: g.scope_name.clone(),
                path: g.path.clone(),
                embedded_languages: g.embedded_languages.clone(),
            });
        }
        for lang in &e.manifest.languages {
            let grammar = e
                .manifest
                .grammars
                .iter()
                .find(|g| g.language.as_deref() == Some(lang.id.as_str()))
                .map(|g| GrammarInfo {
                    scope_name: g.scope_name.clone(),
                    path: g.path.clone(),
                    embedded_languages: g.embedded_languages.clone(),
                });
            languages.push(LanguageInfo {
                id: lang.id.clone(),
                extension: id.clone(),
                aliases: lang.aliases.clone(),
                extensions: lang.extensions.clone(),
                filenames: lang.filenames.clone(),
                first_line: lang.first_line.clone(),
                configuration: lang.configuration.clone(),
                grammar,
            });
        }
        for theme in &e.manifest.themes {
            themes.push(ThemeInfo {
                extension: id.clone(),
                label: theme.label.clone(),
                ui_theme: theme.ui_theme.clone(),
                path: theme.path.clone(),
            });
        }
        // Spec 「뷰어」: until viewers run in a webview without the IPC handler, only bundled ones.
        if e.source == Source::Bundled {
            for viewer in &e.manifest.viewers {
                viewers.push(ViewerInfo {
                    extension: id.clone(),
                    id: viewer.id.clone(),
                    kind: viewer.kind,
                    extensions: viewer.extensions.clone(),
                    entry: viewer.entry.clone(),
                });
            }
        }
    }
    Registry {
        extensions,
        languages,
        grammars,
        themes,
        viewers,
        problems: scan.problems.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appdata::Precedence;
    use crate::extensions::manifest::Manifest;
    use crate::extensions::{Installed, Scan, Source};

    fn installed(source: Source, json: &str) -> Installed {
        let manifest = Manifest::parse(json).unwrap();
        Installed {
            path: std::path::PathBuf::from(format!("/ext/{}", manifest.id())),
            manifest,
            source,
        }
    }

    const BUNDLED: &str = r#"{"name": "languages", "publisher": "tote", "version": "1.0.0",
        "contributes": {
          "languages": [{"id": "markdown", "extensions": [".md"]}, {"id": "python", "extensions": [".py"]}],
          "grammars": [{"language": "markdown", "scopeName": "text.html.markdown", "path": "g/md.json"}]
        },
        "tote": {"viewers": [{"id": "media", "kind": "primary", "extensions": ["png"], "entry": "v.html"}]}}"#;
    const USER: &str = r#"{"name": "better-md", "publisher": "someone", "version": "3.1.0",
        "contributes": {
          "languages": [{"id": "markdown", "extensions": [".md", ".mdx"]}],
          "grammars": [{"language": "markdown", "scopeName": "text.html.markdown.better", "path": "md.json"}],
          "themes": [{"label": "Night", "uiTheme": "vs-dark", "path": "night.json"}]
        },
        "tote": {"viewers": [{"id": "evil", "kind": "primary", "extensions": ["png"], "entry": "e.html"}]}}"#;

    fn scan() -> Scan {
        Scan {
            extensions: vec![
                installed(Source::Bundled, BUNDLED),
                installed(Source::User, USER),
            ],
            problems: vec![],
        }
    }

    #[test]
    fn user_languages_come_first_unless_precedence_is_bundled() {
        let registry = build(&scan(), &ExtensionSettings::default());
        let order: Vec<&str> = registry
            .languages
            .iter()
            .map(|l| l.extension.as_str())
            .collect();
        assert_eq!(
            order,
            vec!["someone.better-md", "tote.languages", "tote.languages"]
        );
        assert_eq!(
            registry.languages[0].grammar.as_ref().unwrap().scope_name,
            "text.html.markdown.better"
        );
        let settings = ExtensionSettings {
            disabled: vec![],
            precedence: Precedence::Bundled,
        };
        let registry = build(&scan(), &settings);
        let order: Vec<&str> = registry
            .languages
            .iter()
            .map(|l| l.extension.as_str())
            .collect();
        assert_eq!(
            order,
            vec!["tote.languages", "tote.languages", "someone.better-md"]
        );
    }

    #[test]
    fn a_disabled_user_extension_contributes_nothing_and_a_bundled_one_cannot_be_disabled() {
        let settings = ExtensionSettings {
            disabled: vec!["someone.better-md".into(), "tote.languages".into()],
            precedence: Precedence::User,
        };
        let registry = build(&scan(), &settings);
        assert_eq!(registry.languages.len(), 2);
        assert!(registry.themes.is_empty());
        let summary: Vec<(&str, bool)> = registry
            .extensions
            .iter()
            .map(|e| (e.id.as_str(), e.enabled))
            .collect();
        assert_eq!(
            summary,
            vec![("tote.languages", true), ("someone.better-md", false)]
        );
    }

    #[test]
    fn viewers_come_from_bundled_extensions_only() {
        let registry = build(&scan(), &ExtensionSettings::default());
        let ids: Vec<&str> = registry.viewers.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, vec!["media"]);
        assert_eq!(registry.viewers[0].extension, "tote.languages");
        let scopes: Vec<&str> = registry
            .grammars
            .iter()
            .map(|g| g.scope_name.as_str())
            .collect();
        assert_eq!(
            scopes,
            vec!["text.html.markdown.better", "text.html.markdown"]
        );
    }

    #[test]
    fn a_language_without_a_grammar_and_problems_are_carried() {
        let mut scan = scan();
        scan.problems.push(crate::extensions::ExtensionProblem {
            path: "/ext/broken".into(),
            message: "no name".into(),
        });
        let registry = build(&scan, &ExtensionSettings::default());
        let python = registry
            .languages
            .iter()
            .find(|l| l.id == "python")
            .unwrap();
        assert!(python.grammar.is_none());
        assert_eq!(registry.problems.len(), 1);
        let json = serde_json::to_value(&registry).unwrap();
        assert_eq!(json["languages"][0]["firstLine"], serde_json::Value::Null);
        assert_eq!(json["extensions"][0]["displayName"], "languages");
        assert_eq!(json["viewers"][0]["kind"], "primary");
    }
}
