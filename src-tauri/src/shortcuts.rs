//! The app commands whose shortcuts people can change, the shortcuts they cannot, and the rules a
//! saved override has to pass (spec 「단축키 설정」). The menu and the settings screen both read
//! these tables, so there is one list of commands.

use std::collections::BTreeMap;

use muda::accelerator::{Accelerator, Code, Modifiers};
use serde::Serialize;

/// An app command: a menu bar item with an id, other than 설정….
#[derive(Debug, PartialEq, Eq)]
pub struct Command {
    pub id: &'static str,
    /// The menu item's name.
    pub label: &'static str,
    /// The submenu it is in.
    pub menu: &'static str,
    /// Its shortcut when nothing is saved, as a Tauri accelerator.
    pub default: Option<&'static str>,
}

const fn command(
    id: &'static str,
    label: &'static str,
    menu: &'static str,
    default: Option<&'static str>,
) -> Command {
    Command {
        id,
        label,
        menu,
        default,
    }
}

/// In menu order. Whichever of two people's overrides comes later here is the one dropped.
pub const COMMANDS: &[Command] = &[
    command("install-cli", "셸 명령 설치…", "tote", None),
    command("new-memo", "새 메모", "파일", Some("CmdOrCtrl+N")),
    command("new-window", "새 창", "파일", Some("Alt+CmdOrCtrl+N")),
    command("open-file", "파일 열기…", "파일", Some("CmdOrCtrl+O")),
    command("save", "저장", "파일", Some("CmdOrCtrl+S")),
    command("import", "워크스페이스로 가져오기", "파일", None),
    command("rename", "이름 바꾸기…", "파일", None),
    command("versions", "이전 버전…", "파일", None),
    command("reveal-backups", "백업 폴더 열기", "파일", None),
    command("close-tab", "탭 닫기", "파일", Some("CmdOrCtrl+W")),
    command("close-window", "창 닫기", "파일", Some("CmdOrCtrl+Shift+W")),
    command(
        "open-workspace",
        "워크스페이스 열기…",
        "파일",
        Some("CmdOrCtrl+Shift+O"),
    ),
    command(
        "new-workspace",
        "새 워크스페이스…",
        "파일",
        Some("CmdOrCtrl+Shift+N"),
    ),
    command(
        "search-workspace",
        "워크스페이스 검색",
        "보기",
        Some("CmdOrCtrl+Shift+F"),
    ),
    command(
        "split-pane",
        "오른쪽으로 나누기",
        "보기",
        Some("CmdOrCtrl+\\"),
    ),
    command(
        "split-pane-down",
        "아래로 나누기",
        "보기",
        Some("CmdOrCtrl+Shift+\\"),
    ),
    command(
        "focus-pane-left",
        "왼쪽 칸으로",
        "보기",
        Some("Alt+CmdOrCtrl+Left"),
    ),
    command(
        "focus-pane-right",
        "오른쪽 칸으로",
        "보기",
        Some("Alt+CmdOrCtrl+Right"),
    ),
    command(
        "focus-pane-up",
        "위쪽 칸으로",
        "보기",
        Some("Alt+CmdOrCtrl+Up"),
    ),
    command(
        "focus-pane-down",
        "아래쪽 칸으로",
        "보기",
        Some("Alt+CmdOrCtrl+Down"),
    ),
    command("next-tab", "다음 탭", "보기", Some("CmdOrCtrl+Shift+]")),
    command("prev-tab", "이전 탭", "보기", Some("CmdOrCtrl+Shift+[")),
    command(
        "toggle-preview",
        "미리보기 전환",
        "보기",
        Some("CmdOrCtrl+Shift+V"),
    ),
    command(
        "move-tab-to-new-window",
        "탭을 새 창으로 옮기기",
        "윈도우",
        None,
    ),
];

/// A shortcut no app command may take.
#[derive(Debug, PartialEq, Eq)]
pub struct Fixed {
    pub name: &'static str,
    pub accelerator: &'static str,
}

const fn fixed(name: &'static str, accelerator: &'static str) -> Fixed {
    Fixed { name, accelerator }
}

/// 설정…'s shortcut. The menu item has one like an app command's, which recording takes off too.
pub const SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";

/// tote 종료's shortcut, kept like 설정…'s so the way out of the app is never lost from the
/// shortcuts. Recording takes it off too.
pub const QUIT_ACCELERATOR: &str = "CmdOrCtrl+Q";

/// 실행 취소's and 실행 복귀's shortcuts. The menu items are the app's, not the system's, so that the
/// editor's own history answers them (src/app/menu.rs); their keys stay the system's.
pub const UNDO_ACCELERATOR: &str = "CmdOrCtrl+Z";
pub const REDO_ACCELERATOR: &str = "CmdOrCtrl+Shift+Z";

/// 설정… and tote 종료 stay where they are so the way back to this screen and the way out of the
/// app are never lost. The system Edit items and macOS's own window items cannot be rebound at all.
pub const FIXED: &[Fixed] = &[
    fixed("설정…", SETTINGS_ACCELERATOR),
    fixed("tote 종료", QUIT_ACCELERATOR),
    fixed("워크스페이스 1", "Ctrl+1"),
    fixed("워크스페이스 2", "Ctrl+2"),
    fixed("워크스페이스 3", "Ctrl+3"),
    fixed("워크스페이스 4", "Ctrl+4"),
    fixed("워크스페이스 5", "Ctrl+5"),
    fixed("워크스페이스 6", "Ctrl+6"),
    fixed("워크스페이스 7", "Ctrl+7"),
    fixed("워크스페이스 8", "Ctrl+8"),
    fixed("워크스페이스 9", "Ctrl+9"),
    fixed("실행 취소", UNDO_ACCELERATOR),
    fixed("실행 복귀", REDO_ACCELERATOR),
    fixed("오려두기", "CmdOrCtrl+X"),
    fixed("복사하기", "CmdOrCtrl+C"),
    fixed("붙여넣기", "CmdOrCtrl+V"),
    fixed("모두 선택", "CmdOrCtrl+A"),
    fixed("숨기기", "CmdOrCtrl+H"),
    fixed("기타 숨기기", "Alt+CmdOrCtrl+H"),
    fixed("최소화", "CmdOrCtrl+M"),
    fixed("전체 화면", "Ctrl+CmdOrCtrl+F"),
];

/// Read the way `MenuItem::set_accelerator` reads it. Tauri turns a string this fails on into no
/// shortcut without an error, so whatever is saved has to pass here first.
fn parse(accelerator: &str) -> Option<Accelerator> {
    accelerator.parse().ok()
}

/// Whether `a` and `b` are the same keys: `CmdOrCtrl`, `Cmd` and `Super` are one key on macOS.
/// A string that does not parse is the same as nothing.
pub fn same(a: &str, b: &str) -> bool {
    matches!((parse(a), parse(b)), (Some(a), Some(b)) if a == b)
}

/// `map` without the entries that say what their command has anyway: its default, or no shortcut
/// for a command that has none. The settings screen never saves such an entry, but a file edited
/// by hand may hold one, and the two maps compared by `SettingsPatch::apply` must not differ by it.
pub fn without_defaults(
    map: &BTreeMap<String, Option<String>>,
) -> BTreeMap<String, Option<String>> {
    map.iter()
        .filter(|(id, keys)| {
            let Some(command) = COMMANDS.iter().find(|c| c.id == id.as_str()) else {
                return true;
            };
            match (keys.as_deref(), command.default) {
                (None, None) => false,
                (Some(keys), Some(default)) => !same(keys, default),
                _ => true,
            }
        })
        .map(|(id, keys)| (id.clone(), keys.clone()))
        .collect()
}

/// Whether the settings screen could have recorded it (spec 「화면」): ⌘, ⌃ or ⌥ with a key, or
/// F1–F12 with no modifier at all. A letter alone, or with only ⇧, would be taken from typing.
fn recordable(accelerator: &Accelerator) -> bool {
    // muda has no macOS menu key for IntlBackslash: the item would show no shortcut.
    if accelerator.key() == Code::IntlBackslash {
        return false;
    }
    // AppKit leaves the keypad flag out when it matches a key equivalent, so a keypad key's item
    // fires on a main-row key too (settings smoke B-8). The settings screen records such a key as
    // its main-row twin and never records ＋ and × (`KEYPAD_TWINS`, src/shortcuts/keys.ts); only
    // the keypad's Enter is a key of its own.
    if accelerator.key().to_string().starts_with("Numpad") && accelerator.key() != Code::NumpadEnter
    {
        return false;
    }
    let mods = accelerator.modifiers();
    // The parser reads `Cmd`, `Super` and `CmdOrCtrl` (on macOS) all as META.
    mods.intersects(Modifiers::META | Modifiers::CONTROL | Modifiers::ALT)
        || (mods.is_empty()
            && matches!(
                accelerator.key(),
                Code::F1
                    | Code::F2
                    | Code::F3
                    | Code::F4
                    | Code::F5
                    | Code::F6
                    | Code::F7
                    | Code::F8
                    | Code::F9
                    | Code::F10
                    | Code::F11
                    | Code::F12
            ))
}

/// The overrides of `saved` that can stand, each judged on its own: an unknown command, a string
/// that does not parse, one the settings screen could not have recorded (it records ⌘, ⌃ or ⌥
/// with a key, or F1–F12 alone), a fixed shortcut, or one another command ends up with is dropped
/// and the rest kept. Between a default and an override the override goes; between two overrides,
/// the one later in `COMMANDS`.
pub fn sanitize(saved: &BTreeMap<String, Option<String>>) -> BTreeMap<String, Option<String>> {
    let mut kept: BTreeMap<String, Option<String>> = saved
        .iter()
        .filter(|(id, keys)| {
            COMMANDS.iter().any(|command| command.id == id.as_str())
                && keys.as_deref().is_none_or(|keys| {
                    parse(keys).is_some_and(|keys| recordable(&keys))
                        && !FIXED.iter().any(|f| same(keys, f.accelerator))
                })
        })
        .map(|(id, keys)| (id.clone(), keys.clone()))
        .collect();
    // A dropped override gives its command the default back, which may clash with an override
    // kept so far: drop one at a time until nothing clashes.
    while let Some(id) = clashing(&kept) {
        kept.remove(id);
    }
    kept
}

/// The first override in `kept` that another command's shortcut takes precedence over: a default,
/// or an override earlier in `COMMANDS`.
fn clashing(kept: &BTreeMap<String, Option<String>>) -> Option<&'static str> {
    let shortcuts = resolve(kept);
    shortcuts.iter().enumerate().find_map(|(at, (command, _))| {
        let keys = kept.get(command.id)?.as_deref()?;
        let beaten = shortcuts
            .iter()
            .enumerate()
            .any(|(other_at, (other, other_keys))| {
                other_at != at
                    && other_keys.as_deref().is_some_and(|o| same(o, keys))
                    && (other_at < at || !kept.contains_key(other.id))
            });
        beaten.then_some(command.id)
    })
}

fn resolve(kept: &BTreeMap<String, Option<String>>) -> Vec<(&'static Command, Option<String>)> {
    COMMANDS
        .iter()
        .map(|command| {
            let keys = match kept.get(command.id) {
                Some(keys) => keys.clone(),
                None => command.default.map(str::to_string),
            };
            (command, keys)
        })
        .collect()
}

/// Every command with the shortcut it has: its saved override where that stands, else its default.
pub fn effective(
    saved: &BTreeMap<String, Option<String>>,
) -> Vec<(&'static Command, Option<String>)> {
    resolve(&sanitize(saved))
}

/// What the settings screen shows (`shortcut_table`): every command with its default and the
/// shortcut it has now, and the shortcuts no command may take.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutTable {
    pub commands: Vec<CommandRow>,
    pub fixed: Vec<FixedRow>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRow {
    pub id: &'static str,
    pub label: &'static str,
    pub menu: &'static str,
    pub default: Option<&'static str>,
    pub current: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedRow {
    pub name: &'static str,
    pub accelerator: &'static str,
}

/// The table for the overrides `saved`.
pub fn table(saved: &BTreeMap<String, Option<String>>) -> ShortcutTable {
    ShortcutTable {
        commands: effective(saved)
            .into_iter()
            .map(|(command, current)| CommandRow {
                id: command.id,
                label: command.label,
                menu: command.menu,
                default: command.default,
                current,
            })
            .collect(),
        fixed: FIXED
            .iter()
            .map(|f| FixedRow {
                name: f.name,
                accelerator: f.accelerator,
            })
            .collect(),
    }
}

/// A patch's overrides, refused whole when any one of them breaks a rule `sanitize` drops for.
pub fn validate(map: &BTreeMap<String, Option<String>>) -> Result<(), String> {
    let kept = sanitize(map);
    match map.keys().find(|id| !kept.contains_key(*id)) {
        Some(id) => Err(format!("단축키를 저장할 수 없습니다: {id}")),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overrides(entries: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
        entries
            .iter()
            .map(|(id, keys)| (id.to_string(), keys.map(str::to_string)))
            .collect()
    }

    fn shortcut_of(saved: &BTreeMap<String, Option<String>>, id: &str) -> Option<String> {
        effective(saved)
            .into_iter()
            .find(|(command, _)| command.id == id)
            .and_then(|(_, keys)| keys)
    }

    #[test]
    fn the_same_keys_written_differently_are_the_same() {
        assert!(same("CmdOrCtrl+Shift+N", "Shift+Cmd+N"));
        assert!(same("CmdOrCtrl+N", "Super+N"));
        assert!(same("Command+N", "cmdorctrl+n"));
        assert!(!same("CmdOrCtrl+N", "CmdOrCtrl+Shift+N"));
        // Off macOS `CmdOrCtrl` is Ctrl.
        #[cfg(target_os = "macos")]
        assert!(!same("Ctrl+N", "CmdOrCtrl+N"));
        assert!(!same("Cmd+++", "Cmd+++"));
    }

    #[test]
    fn one_bad_shortcut_entry_is_dropped_and_the_rest_kept() {
        let saved = BTreeMap::from([
            ("new-memo".into(), Some("CmdOrCtrl+Shift+M".into())),
            ("nope".into(), Some("CmdOrCtrl+K".into())),
            ("save".into(), Some("Cmd+++".into())),
            ("rename".into(), Some("CmdOrCtrl+C".into())),
            ("open-file".into(), Some("CmdOrCtrl+Shift+M".into())),
            ("close-tab".into(), None),
        ]);
        assert_eq!(
            sanitize(&saved),
            overrides(&[("new-memo", Some("CmdOrCtrl+Shift+M")), ("close-tab", None)])
        );
    }

    #[test]
    fn a_shortcut_typing_would_hit_is_dropped() {
        for keys in [
            "K", "Shift+K", "Shift+F5", "Enter", "Space", "Left", "Shift+Up", "1",
        ] {
            let saved = overrides(&[("rename", Some(keys))]);
            assert_eq!(sanitize(&saved), BTreeMap::new(), "{keys}");
            assert!(validate(&saved).unwrap_err().contains("rename"), "{keys}");
        }
        for keys in ["F5", "F12", "Alt+K", "Ctrl+Shift+K", "Cmd+Enter", "Alt+F5"] {
            let saved = overrides(&[("rename", Some(keys))]);
            assert_eq!(sanitize(&saved), saved, "{keys}");
            assert_eq!(validate(&saved), Ok(()), "{keys}");
        }
    }

    #[test]
    fn a_saved_shortcut_that_takes_another_commands_default_is_dropped() {
        let saved = overrides(&[("rename", Some("CmdOrCtrl+N"))]);
        assert_eq!(sanitize(&saved), BTreeMap::new());
        assert_eq!(shortcut_of(&saved, "new-memo"), Some("CmdOrCtrl+N".into()));
        assert_eq!(shortcut_of(&saved, "rename"), None);
        assert!(validate(&saved).unwrap_err().contains("rename"));
        // The default's command comes later in the menu: the default still wins.
        let saved = overrides(&[("close-window", Some("CmdOrCtrl+Shift+V"))]);
        assert_eq!(sanitize(&saved), BTreeMap::new());
        assert_eq!(
            shortcut_of(&saved, "toggle-preview"),
            Some("CmdOrCtrl+Shift+V".into())
        );
        assert_eq!(
            shortcut_of(&saved, "close-window"),
            Some("CmdOrCtrl+Shift+W".into())
        );
    }

    #[test]
    fn a_default_given_up_by_its_command_can_be_taken() {
        let saved = overrides(&[("new-memo", None), ("rename", Some("Cmd+N"))]);
        assert_eq!(sanitize(&saved), saved);
        assert_eq!(validate(&saved), Ok(()));
        assert_eq!(shortcut_of(&saved, "rename"), Some("Cmd+N".into()));
        assert_eq!(shortcut_of(&saved, "new-memo"), None);
    }

    #[test]
    fn a_dropped_override_gives_its_default_back_first() {
        // `save` cannot have ⌘C, so it keeps ⌘S — which `rename` then cannot have.
        let saved = overrides(&[
            ("save", Some("CmdOrCtrl+C")),
            ("rename", Some("CmdOrCtrl+S")),
        ]);
        assert_eq!(sanitize(&saved), BTreeMap::new());
        assert_eq!(shortcut_of(&saved, "save"), Some("CmdOrCtrl+S".into()));
    }

    #[test]
    fn the_settings_command_cannot_be_rebound() {
        let saved = overrides(&[("settings", Some("CmdOrCtrl+K"))]);
        assert_eq!(sanitize(&saved), BTreeMap::new());
        assert!(validate(&saved).unwrap_err().contains("settings"));
    }

    #[test]
    fn intl_backslash_is_not_recordable() {
        assert!(parse("CmdOrCtrl+IntlBackslash").is_some());
        assert!(!parse("CmdOrCtrl+IntlBackslash").is_some_and(|keys| recordable(&keys)));
        let saved = overrides(&[("rename", Some("CmdOrCtrl+IntlBackslash"))]);
        assert_eq!(sanitize(&saved), BTreeMap::new());
        assert!(validate(&saved).unwrap_err().contains("rename"));
    }

    /// Only the parse is held here: muda's macOS key function (`key_equivalent`) is crate-private.
    /// That the menu really takes them is for a check on screen.
    #[test]
    fn the_keypad_enter_insert_and_help_shortcuts_parse_and_are_recordable() {
        for keys in ["CmdOrCtrl+NumpadEnter", "Alt+Insert", "CmdOrCtrl+Help"] {
            assert!(parse(keys).is_some_and(|keys| recordable(&keys)), "{keys}");
            let saved = overrides(&[("rename", Some(keys))]);
            assert_eq!(validate(&saved), Ok(()), "{keys}");
            assert_eq!(sanitize(&saved), saved, "{keys}");
        }
    }

    /// A macOS menu fires their item on a main-row key too; the settings screen records the
    /// main-row key instead, or nothing. One in a settings.json (written by hand, or by the build
    /// that recorded them) is dropped.
    #[test]
    fn the_other_keypad_keys_are_not_recordable() {
        for keys in [
            "CmdOrCtrl+Numpad1",
            "Alt+Numpad0",
            "CmdOrCtrl+NumpadAdd",
            "CmdOrCtrl+NumpadSubtract",
            "CmdOrCtrl+NumpadMultiply",
            "CmdOrCtrl+NumpadDivide",
            "CmdOrCtrl+NumpadDecimal",
            "CmdOrCtrl+NumpadEqual",
        ] {
            assert!(parse(keys).is_some(), "{keys}");
            assert!(!parse(keys).is_some_and(|keys| recordable(&keys)), "{keys}");
            let saved = overrides(&[("rename", Some(keys))]);
            assert_eq!(sanitize(&saved), BTreeMap::new(), "{keys}");
            assert!(validate(&saved).unwrap_err().contains("rename"), "{keys}");
        }
        // The main-row twin the screen records instead.
        let saved = overrides(&[("rename", Some("CmdOrCtrl+1"))]);
        assert_eq!(validate(&saved), Ok(()));
    }

    #[test]
    fn quit_is_fixed_and_cannot_be_rebound() {
        assert!(FIXED
            .iter()
            .any(|f| f.name == "tote 종료" && f.accelerator == "CmdOrCtrl+Q"));
        assert_eq!(QUIT_ACCELERATOR, "CmdOrCtrl+Q");
        assert!(COMMANDS.iter().all(|c| c.id != "quit"));
        // A settings.json from before: the entry is dropped as an unknown id.
        let saved = overrides(&[("quit", Some("CmdOrCtrl+Shift+Q"))]);
        assert_eq!(sanitize(&saved), BTreeMap::new());
        assert!(validate(&saved).unwrap_err().contains("quit"));
        // ⌘Q is not for another command to take.
        let saved = overrides(&[("rename", Some("CmdOrCtrl+Q"))]);
        assert_eq!(sanitize(&saved), BTreeMap::new());
        assert_eq!(shortcut_of(&saved, "rename"), None);
        assert!(validate(&saved).unwrap_err().contains("rename"));
    }

    #[test]
    fn a_patch_with_any_bad_entry_is_refused_naming_it() {
        assert_eq!(validate(&BTreeMap::new()), Ok(()));
        assert_eq!(
            validate(&overrides(&[
                ("rename", Some("CmdOrCtrl+K")),
                ("close-tab", None)
            ])),
            Ok(())
        );
        for (id, keys) in [
            ("save", Some("Cmd+++")),
            ("rename", Some("Ctrl+3")),
            ("nope", None),
        ] {
            let error = validate(&overrides(&[("close-tab", None), (id, keys)])).unwrap_err();
            assert!(error.contains(id), "{error}");
        }
    }

    #[test]
    fn effective_matches_todays_menu() {
        let expected: &[(&str, Option<&str>)] = &[
            ("install-cli", None),
            ("new-memo", Some("CmdOrCtrl+N")),
            ("new-window", Some("Alt+CmdOrCtrl+N")),
            ("open-file", Some("CmdOrCtrl+O")),
            ("save", Some("CmdOrCtrl+S")),
            ("import", None),
            ("rename", None),
            ("versions", None),
            ("reveal-backups", None),
            ("close-tab", Some("CmdOrCtrl+W")),
            ("close-window", Some("CmdOrCtrl+Shift+W")),
            ("open-workspace", Some("CmdOrCtrl+Shift+O")),
            ("new-workspace", Some("CmdOrCtrl+Shift+N")),
            ("search-workspace", Some("CmdOrCtrl+Shift+F")),
            ("split-pane", Some("CmdOrCtrl+\\")),
            ("split-pane-down", Some("CmdOrCtrl+Shift+\\")),
            ("focus-pane-left", Some("Alt+CmdOrCtrl+Left")),
            ("focus-pane-right", Some("Alt+CmdOrCtrl+Right")),
            ("focus-pane-up", Some("Alt+CmdOrCtrl+Up")),
            ("focus-pane-down", Some("Alt+CmdOrCtrl+Down")),
            ("next-tab", Some("CmdOrCtrl+Shift+]")),
            ("prev-tab", Some("CmdOrCtrl+Shift+[")),
            ("toggle-preview", Some("CmdOrCtrl+Shift+V")),
            ("move-tab-to-new-window", None),
        ];
        let actual: Vec<(&str, Option<String>)> = effective(&BTreeMap::new())
            .into_iter()
            .map(|(command, keys)| (command.id, keys))
            .collect();
        let expected: Vec<(&str, Option<String>)> = expected
            .iter()
            .map(|(id, keys)| (*id, keys.map(str::to_string)))
            .collect();
        assert_eq!(actual, expected);
    }

    /// `src/backend/fake-shortcuts.test.ts` holds the fake backend's table against this file.
    /// `UPDATE_FIXTURES=1 cargo test` writes it anew.
    #[test]
    fn the_shortcut_table_fixture_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/shortcut-table.json");
        let current = serde_json::to_string_pretty(&table(&BTreeMap::new())).unwrap() + "\n";
        if std::env::var_os("UPDATE_FIXTURES").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &current).unwrap();
        }
        let saved = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            saved == current,
            "{} is stale: run `UPDATE_FIXTURES=1 cargo test` in src-tauri",
            path.display()
        );
    }

    #[test]
    fn every_built_in_shortcut_parses_is_recordable_and_none_is_taken_twice() {
        let all: Vec<&str> = COMMANDS
            .iter()
            .filter_map(|c| c.default)
            .chain(FIXED.iter().map(|f| f.accelerator))
            .collect();
        for (i, a) in all.iter().enumerate() {
            assert!(parse(a).is_some_and(|a| recordable(&a)), "{a}");
            for b in &all[i + 1..] {
                assert!(!same(a, b), "{a} and {b}");
            }
        }
        assert!(COMMANDS.iter().all(|c| c.id != "settings"));
    }
}
