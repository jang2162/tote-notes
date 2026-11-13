//! The app's native appearance follows the settings' theme (settings spec 「테마」): scroll bars,
//! window chrome, menus and dialogs, and the page's `prefers-color-scheme`.

use tauri::{AppHandle, Manager, Theme};

use crate::app::AppCore;
use crate::appdata::{ThemeChoice, ThemeMode};
use crate::extensions::file_inside;
use crate::extensions::jsonc::strip_jsonc;
use crate::extensions::registry::ThemeInfo;

/// `None` leaves the appearance to the system. A picked theme gives its kind as
/// src/theme/vscode-theme.ts `themeKind` does: the manifest's `uiTheme`, else the theme file's
/// `type` (`type_of`), else the system's, which is also the page's last resort. One the registry
/// (`themes`) no longer has is auto (theme picker spec 「네이티브 모양」).
pub(crate) fn native_theme(
    mode: &ThemeChoice,
    themes: &[ThemeInfo],
    type_of: impl FnOnce(&ThemeInfo) -> Option<String>,
) -> Option<Theme> {
    match mode {
        ThemeChoice::Mode(ThemeMode::Auto) => None,
        ThemeChoice::Mode(ThemeMode::Light) => Some(Theme::Light),
        ThemeChoice::Mode(ThemeMode::Dark) => Some(Theme::Dark),
        ThemeChoice::Theme(picked) => {
            let info = themes
                .iter()
                .find(|t| t.extension == picked.extension && t.label == picked.label)?;
            match info.ui_theme.as_str() {
                "vs" | "hc-light" => Some(Theme::Light),
                "vs-dark" | "hc-black" => Some(Theme::Dark),
                _ => match type_of(info)?.as_str() {
                    "light" | "hcLight" => Some(Theme::Light),
                    "dark" | "hc" => Some(Theme::Dark),
                    _ => None,
                },
            }
        }
    }
}

/// The `type` at the top of a theme's file. Its `include`s are not followed.
fn theme_file_type(core: &AppCore, theme: &ThemeInfo) -> Option<String> {
    let file = file_inside(&core.extension_path(&theme.extension)?, &theme.path)?;
    let text = std::fs::read_to_string(file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&strip_jsonc(&text)).ok()?;
    value.get("type")?.as_str().map(str::to_string)
}

/// Puts the saved theme's appearance on the app. On macOS a theme is app-wide (`NSApp.appearance`),
/// and every window, those opened later too, takes it from there. Reads the settings and the
/// registry when it runs, so of two changes close together the later read puts the newer one.
pub(crate) fn follow_settings(app: &AppHandle) {
    let core = app.state::<AppCore>();
    let mode = core.settings().theme.mode;
    let registry = core.registry();
    app.set_theme(native_theme(&mode, &registry.themes, |theme| {
        theme_file_type(&core, theme)
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appdata::ThemeRef;

    fn theme(label: &str, ui_theme: &str) -> ThemeInfo {
        ThemeInfo {
            extension: "someone.night".into(),
            label: label.into(),
            ui_theme: ui_theme.into(),
            path: format!("{label}.json"),
        }
    }

    fn picked(label: &str) -> ThemeChoice {
        ThemeChoice::Theme(ThemeRef {
            extension: "someone.night".into(),
            label: label.into(),
        })
    }

    #[test]
    fn auto_leaves_the_appearance_to_the_system_and_the_others_force_it() {
        let none = |_: &ThemeInfo| -> Option<String> { panic!("no theme file is read for a mode") };
        let mode = |m| ThemeChoice::Mode(m);
        assert_eq!(native_theme(&mode(ThemeMode::Auto), &[], none), None);
        assert_eq!(
            native_theme(&mode(ThemeMode::Light), &[], none),
            Some(Theme::Light)
        );
        assert_eq!(
            native_theme(&mode(ThemeMode::Dark), &[], none),
            Some(Theme::Dark)
        );
    }

    #[test]
    fn a_picked_theme_gives_its_kind_and_one_not_installed_leaves_it_to_the_system() {
        let themes = [
            theme("Night", "vs-dark"),
            theme("Day", "vs"),
            theme("Contrast", "hc-black"),
            theme("Paper", "hc-light"),
            theme("Odd", "sepia"),
        ];
        let unread = |_: &ThemeInfo| -> Option<String> { panic!("uiTheme says the kind") };
        assert_eq!(
            native_theme(&picked("Night"), &themes, unread),
            Some(Theme::Dark)
        );
        assert_eq!(
            native_theme(&picked("Day"), &themes, unread),
            Some(Theme::Light)
        );
        assert_eq!(
            native_theme(&picked("Contrast"), &themes, unread),
            Some(Theme::Dark)
        );
        assert_eq!(
            native_theme(&picked("Paper"), &themes, unread),
            Some(Theme::Light)
        );
        // An unknown uiTheme: the file's own type, else the system.
        let type_is = |kind: &'static str| {
            move |t: &ThemeInfo| {
                assert_eq!(t.label, "Odd");
                Some(kind.to_string())
            }
        };
        assert_eq!(
            native_theme(&picked("Odd"), &themes, type_is("light")),
            Some(Theme::Light)
        );
        assert_eq!(
            native_theme(&picked("Odd"), &themes, type_is("hc")),
            Some(Theme::Dark)
        );
        assert_eq!(
            native_theme(&picked("Odd"), &themes, type_is("sepia")),
            None
        );
        assert_eq!(native_theme(&picked("Odd"), &themes, |_| None), None);
        // Disabled, removed or renamed: as auto.
        assert_eq!(native_theme(&picked("Gone"), &themes, unread), None);
        let other = ThemeChoice::Theme(ThemeRef {
            extension: "another.one".into(),
            label: "Night".into(),
        });
        assert_eq!(native_theme(&other, &themes, unread), None);
    }
}
