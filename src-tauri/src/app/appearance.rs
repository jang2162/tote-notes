//! The app's native appearance follows the settings' theme mode (settings spec 「테마」): scroll
//! bars, window chrome, menus and dialogs, and the page's `prefers-color-scheme`.

use tauri::{AppHandle, Manager, Theme};

use crate::app::AppCore;
use crate::appdata::ThemeMode;

/// `None` leaves the appearance to the system.
pub(crate) fn native_theme(mode: ThemeMode) -> Option<Theme> {
    match mode {
        ThemeMode::Auto => None,
        ThemeMode::Light => Some(Theme::Light),
        ThemeMode::Dark => Some(Theme::Dark),
    }
}

/// Puts the saved mode on the app. On macOS a theme is app-wide (`NSApp.appearance`), and every
/// window, those opened later too, takes it from there. Reads the settings when it runs, so of two
/// saves close together the later read puts the newer mode.
pub(crate) fn follow_settings(app: &AppHandle) {
    let mode = app.state::<AppCore>().settings().theme.mode;
    app.set_theme(native_theme(mode));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_leaves_the_appearance_to_the_system_and_the_others_force_it() {
        assert_eq!(native_theme(ThemeMode::Auto), None);
        assert_eq!(native_theme(ThemeMode::Light), Some(Theme::Light));
        assert_eq!(native_theme(ThemeMode::Dark), Some(Theme::Dark));
    }
}
