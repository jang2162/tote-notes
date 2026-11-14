//! Shortcuts heard while another app is in front, and the rules a saved one has to pass (spec
//! `docs/superpowers/specs/2026-11-14-tote-notes-global-quick-note-design.md` 「데이터·저장」). They
//! live beside the app commands' (src/shortcuts.rs) and may not take a key one of those has: a
//! global key is caught before the menu, in tote too, so the command would never run by its key.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use serde::Serialize;
use tauri_plugin_global_shortcut::{Code, Shortcut};

use crate::shortcuts::{self, FIXED};

/// A command a global shortcut runs.
#[derive(Debug, PartialEq, Eq)]
pub struct GlobalCommand {
    pub id: &'static str,
    /// What the settings screen calls it.
    pub label: &'static str,
    /// Its shortcut when nothing is saved, as a Tauri accelerator. It gives way to an app command's
    /// key (`gave_way`), as the app commands that came after saved keys do.
    pub default: &'static str,
}

pub const QUICK_NOTE: &str = "quick-note";

pub const GLOBAL_COMMANDS: &[GlobalCommand] = &[GlobalCommand {
    id: QUICK_NOTE,
    label: "빠른 메모",
    // ⌥⌘N is the app's 새 창.
    default: "Ctrl+Alt+N",
}];

/// Command id → its shortcut instead of the default, `None` for none.
pub type Overrides = BTreeMap<String, Option<String>>;

/// The keys as the global shortcut plugin reads them; `None` when it cannot. A media key is not
/// taken: `global-hotkey` hears those through an event tap, which asks for the input monitoring
/// permission, while every other key goes through Carbon's `RegisterEventHotKey`, which asks for
/// none.
pub fn hotkey(keys: &str) -> Option<Shortcut> {
    let shortcut = Shortcut::from_str(keys).ok()?;
    let media = matches!(
        shortcut.key,
        Code::MediaPlayPause
            | Code::MediaTrackNext
            | Code::MediaTrackPrevious
            | Code::MediaFastForward
            | Code::MediaRewind
    );
    (!media).then_some(shortcut)
}

/// The keys the app commands have under the app overrides `app_saved` (`shortcuts::effective`).
fn app_keys(app_saved: &Overrides) -> Vec<String> {
    shortcuts::effective(app_saved)
        .into_iter()
        .filter_map(|(_, keys)| keys)
        .collect()
}

/// Whether `keys` may be a global shortcut beside the app commands' `app`: the screen could have
/// recorded it, the plugin reads it, and no fixed shortcut or app command has it.
fn stands(keys: &str, app: &[String]) -> bool {
    shortcuts::recordable_keys(keys)
        && hotkey(keys).is_some()
        && !FIXED.iter().any(|f| shortcuts::same(keys, f.accelerator))
        && !app.iter().any(|a| shortcuts::same(keys, a))
}

/// The global overrides of `saved` that can stand beside the app overrides `app_saved`, each
/// judged on its own: an unknown id, keys the screen could not have recorded or the plugin cannot
/// read, a media key, a fixed shortcut or one an app command has is dropped and the rest kept.
pub fn sanitize(saved: &Overrides, app_saved: &Overrides) -> Overrides {
    let app = app_keys(app_saved);
    saved
        .iter()
        .filter(|(id, keys)| {
            GLOBAL_COMMANDS.iter().any(|c| c.id == id.as_str())
                && keys.as_deref().is_none_or(|keys| stands(keys, &app))
        })
        .map(|(id, keys)| (id.clone(), keys.clone()))
        .collect()
}

/// Whether `command`'s default is not in force: it has no entry of its own in `kept` and an app
/// command has the key — one saved before this build had global shortcuts stays that command's.
fn gave_way(command: &GlobalCommand, kept: &Overrides, app: &[String]) -> bool {
    !kept.contains_key(command.id) && !stands(command.default, app)
}

/// Every global command with the shortcut it has: its saved override where that stands, else its
/// default unless that gave way.
pub fn effective(
    saved: &Overrides,
    app_saved: &Overrides,
) -> Vec<(&'static GlobalCommand, Option<String>)> {
    let kept = sanitize(saved, app_saved);
    let app = app_keys(app_saved);
    GLOBAL_COMMANDS
        .iter()
        .map(|command| {
            let keys = match kept.get(command.id) {
                Some(keys) => keys.clone(),
                None if gave_way(command, &kept, &app) => None,
                None => Some(command.default.to_string()),
            };
            (command, keys)
        })
        .collect()
}

/// The global overrides and app overrides a patch leaves, refused whole when a global entry would
/// not stand: the screen never sends one, and the other way round an app command taking a saved
/// global key would leave that key on two things.
pub fn validate(saved: &Overrides, app_saved: &Overrides) -> Result<(), String> {
    let kept = sanitize(saved, app_saved);
    match saved.keys().find(|id| !kept.contains_key(*id)) {
        Some(id) => Err(format!("전역 단축키를 저장할 수 없습니다: {id}")),
        None => Ok(()),
    }
}

/// What the settings screen's 「전역」 group shows (`global_shortcut_table`).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutTable {
    pub commands: Vec<GlobalCommandRow>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalCommandRow {
    pub id: &'static str,
    pub label: &'static str,
    pub default: &'static str,
    pub current: Option<String>,
    /// Set when its default is not in force because an app command has the key (`gave_way`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub yielded: bool,
    /// Why its shortcut is not registered with macOS; left out when it is (or it has none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// The table for the overrides `saved` and `app_saved`, with `failed` the commands whose shortcut
/// macOS refused.
pub fn table(
    saved: &Overrides,
    app_saved: &Overrides,
    failed: &BTreeSet<String>,
) -> GlobalShortcutTable {
    let kept = sanitize(saved, app_saved);
    let app = app_keys(app_saved);
    GlobalShortcutTable {
        commands: effective(saved, app_saved)
            .into_iter()
            .map(|(command, current)| GlobalCommandRow {
                id: command.id,
                label: command.label,
                default: command.default,
                problem: (current.is_some() && failed.contains(command.id))
                    .then(|| REGISTER_FAILED.to_string()),
                current,
                yielded: gave_way(command, &kept, &app),
            })
            .collect(),
    }
}

/// What a row says when macOS would not take its shortcut: `RegisterEventHotKey` fails when another
/// app holds the keys for itself.
pub const REGISTER_FAILED: &str = "다른 앱이 쓰고 있어 등록하지 못했습니다";

#[cfg(test)]
mod tests {
    use super::*;

    fn overrides(entries: &[(&str, Option<&str>)]) -> Overrides {
        entries
            .iter()
            .map(|(id, keys)| (id.to_string(), keys.map(str::to_string)))
            .collect()
    }

    fn quick_note(saved: &Overrides, app_saved: &Overrides) -> Option<String> {
        effective(saved, app_saved)
            .into_iter()
            .find(|(command, _)| command.id == QUICK_NOTE)
            .and_then(|(_, keys)| keys)
    }

    #[test]
    fn quick_note_is_ctrl_alt_n_when_nothing_is_saved() {
        let none = Overrides::new();
        assert_eq!(quick_note(&none, &none), Some("Ctrl+Alt+N".into()));
        let row = &table(&none, &none, &BTreeSet::new()).commands[0];
        assert_eq!(row.id, "quick-note");
        assert_eq!(row.label, "빠른 메모");
        assert_eq!(row.default, "Ctrl+Alt+N");
        assert!(!row.yielded);
        assert_eq!(row.problem, None);
    }

    #[test]
    fn the_default_is_no_app_or_fixed_key() {
        for command in GLOBAL_COMMANDS {
            assert!(
                shortcuts::recordable_keys(command.default),
                "{}",
                command.id
            );
            assert!(hotkey(command.default).is_some(), "{}", command.id);
            for (app, keys) in shortcuts::effective(&Overrides::new()) {
                if let Some(keys) = keys {
                    assert!(!shortcuts::same(command.default, &keys), "{}", app.id);
                }
            }
            for fixed in FIXED {
                assert!(!shortcuts::same(command.default, fixed.accelerator));
            }
        }
    }

    #[test]
    fn a_cleared_shortcut_is_none_and_stands() {
        let saved = overrides(&[("quick-note", None)]);
        assert_eq!(sanitize(&saved, &Overrides::new()), saved);
        assert_eq!(validate(&saved, &Overrides::new()), Ok(()));
        assert_eq!(quick_note(&saved, &Overrides::new()), None);
        assert!(!table(&saved, &Overrides::new(), &BTreeSet::new()).commands[0].yielded);
    }

    #[test]
    fn a_saved_shortcut_is_kept() {
        let saved = overrides(&[("quick-note", Some("Ctrl+Alt+Shift+N"))]);
        assert_eq!(sanitize(&saved, &Overrides::new()), saved);
        assert_eq!(
            quick_note(&saved, &Overrides::new()),
            Some("Ctrl+Alt+Shift+N".into())
        );
    }

    #[test]
    fn one_bad_entry_is_dropped_and_the_command_has_its_default() {
        for keys in [
            "Cmd+++",
            "N",
            "Shift+N",
            "CmdOrCtrl+Q",
            "Ctrl+1",
            "CmdOrCtrl+N",
            "CmdOrCtrl+IntlBackslash",
            "CmdOrCtrl+Numpad1",
            "Ctrl+MediaPlayPause",
        ] {
            let saved = overrides(&[("quick-note", Some(keys)), ("nope", Some("Ctrl+Alt+K"))]);
            assert_eq!(
                sanitize(&saved, &Overrides::new()),
                Overrides::new(),
                "{keys}"
            );
            assert_eq!(
                quick_note(&saved, &Overrides::new()),
                Some("Ctrl+Alt+N".into()),
                "{keys}"
            );
            assert!(
                validate(&overrides(&[("quick-note", Some(keys))]), &Overrides::new())
                    .unwrap_err()
                    .contains("quick-note"),
                "{keys}"
            );
        }
        let error = validate(&overrides(&[("nope", None)]), &Overrides::new()).unwrap_err();
        assert!(error.contains("nope"), "{error}");
    }

    #[test]
    fn a_key_an_app_command_has_is_refused_whether_default_or_saved() {
        // ⌘S is 저장's default.
        let saved = overrides(&[("quick-note", Some("CmdOrCtrl+S"))]);
        assert!(validate(&saved, &Overrides::new()).is_err());
        // Saved for 이름 바꾸기….
        let app = overrides(&[("rename", Some("Ctrl+Alt+K"))]);
        let saved = overrides(&[("quick-note", Some("Ctrl+Alt+K"))]);
        assert_eq!(sanitize(&saved, &app), Overrides::new());
        assert!(validate(&saved, &app).unwrap_err().contains("quick-note"));
        // Once 저장 gives ⌘S up, it may be the global one.
        let app = overrides(&[("save", None)]);
        let saved = overrides(&[("quick-note", Some("CmdOrCtrl+S"))]);
        assert_eq!(validate(&saved, &app), Ok(()));
    }

    /// An app patch taking the key a global entry has is refused too: `SettingsPatch::apply` checks
    /// the pair the patch leaves.
    #[test]
    fn an_app_command_taking_a_saved_global_key_is_refused() {
        let saved = overrides(&[("quick-note", Some("Ctrl+Alt+Shift+N"))]);
        let app = overrides(&[("rename", Some("Ctrl+Alt+Shift+N"))]);
        assert!(validate(&saved, &app).unwrap_err().contains("quick-note"));
    }

    #[test]
    fn the_default_gives_way_to_an_app_command_that_has_it() {
        let app = overrides(&[("rename", Some("Ctrl+Alt+N"))]);
        assert_eq!(quick_note(&Overrides::new(), &app), None);
        assert_eq!(validate(&Overrides::new(), &app), Ok(()));
        let row = &table(&Overrides::new(), &app, &BTreeSet::new()).commands[0];
        assert!(row.yielded);
        assert_eq!(row.current, None);
        // An entry of its own is not giving way.
        let saved = overrides(&[("quick-note", Some("Ctrl+Alt+M"))]);
        let row = &table(&saved, &app, &BTreeSet::new()).commands[0];
        assert!(!row.yielded);
        assert_eq!(row.current, Some("Ctrl+Alt+M".into()));
    }

    #[test]
    fn the_table_says_a_refused_registration_only_while_there_is_a_key() {
        let failed = BTreeSet::from(["quick-note".to_string()]);
        let row = &table(&Overrides::new(), &Overrides::new(), &failed).commands[0];
        assert_eq!(row.problem.as_deref(), Some(REGISTER_FAILED));
        let json =
            serde_json::to_value(table(&Overrides::new(), &Overrides::new(), &failed)).unwrap();
        assert_eq!(json["commands"][0]["problem"], REGISTER_FAILED);
        let cleared = overrides(&[("quick-note", None)]);
        assert_eq!(
            table(&cleared, &Overrides::new(), &failed).commands[0].problem,
            None
        );
        let json = serde_json::to_value(table(
            &Overrides::new(),
            &Overrides::new(),
            &BTreeSet::new(),
        ))
        .unwrap();
        assert!(json["commands"][0].get("problem").is_none());
        assert!(json["commands"][0].get("yielded").is_none());
    }

    /// The keys the screen writes, read by the plugin as they are.
    #[test]
    fn the_plugin_reads_what_the_screen_records() {
        for keys in [
            "Ctrl+Alt+N",
            "Alt+CmdOrCtrl+N",
            "CmdOrCtrl+Shift+\\",
            "Ctrl+Alt+Up",
            "Alt+F5",
            "F12",
            "Ctrl+Alt+Space",
            "Ctrl+Alt+Enter",
            "Ctrl+Alt+[",
            "Ctrl+Alt+1",
        ] {
            assert!(hotkey(keys).is_some(), "{keys}");
            assert!(shortcuts::recordable_keys(keys), "{keys}");
        }
    }

    #[test]
    fn a_media_key_is_not_a_global_shortcut() {
        assert!(Shortcut::from_str("Ctrl+MediaPlayPause").is_ok());
        assert!(hotkey("Ctrl+MediaPlayPause").is_none());
    }
}
