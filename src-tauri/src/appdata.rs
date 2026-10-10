//! This device's own files, outside every workspace (spec 「워크스페이스와 데이터 모델」): the device
//! ID, settings, and which workspace windows to reopen. Where they live is decided here and
//! nowhere else.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::persist::{read_json, write_json};

#[derive(Clone, Debug, PartialEq)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub default_workspace_root: PathBuf,
}

impl AppPaths {
    /// `TOTE_DATA_DIR` moves everything for one run — workspaces included — so tests and smoke
    /// checks never touch real notes. Debug builds use `tote-dev` and `~/Tote-dev` so a development
    /// run never touches the notes of an installed tote. A `TOTE_DATA_DIR` that is empty or
    /// relative gives `None` instead of falling back: it would land in the working folder, or in
    /// the development folder the override exists to avoid.
    pub fn resolve() -> Option<AppPaths> {
        AppPaths::from_parts(
            std::env::var_os("TOTE_DATA_DIR").map(PathBuf::from),
            dirs::data_dir(),
            dirs::home_dir(),
            cfg!(debug_assertions),
        )
    }

    pub fn from_parts(
        override_dir: Option<PathBuf>,
        os_data_dir: Option<PathBuf>,
        home: Option<PathBuf>,
        debug: bool,
    ) -> Option<AppPaths> {
        if let Some(dir) = override_dir {
            if !dir.is_absolute() {
                return None;
            }
            return Some(AppPaths {
                default_workspace_root: dir.join("workspaces"),
                data_dir: dir,
            });
        }
        let suffix = if debug { "-dev" } else { "" };
        Some(AppPaths {
            data_dir: os_data_dir?.join(format!("tote{suffix}")),
            default_workspace_root: home?.join(format!("Tote{suffix}")),
        })
    }

    pub fn machine_file(&self) -> PathBuf {
        self.data_dir.join("machine.json")
    }

    pub fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn launch_file(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }

    pub fn buffers_dir(&self) -> PathBuf {
        self.data_dir.join("buffers")
    }

    /// Text piped into `tote -`, parked until the app turns it into a memo.
    pub fn inbox_dir(&self) -> PathBuf {
        self.data_dir.join("inbox")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub version: u32,
    pub device_id: String,
    pub device_name: String,
}

impl Machine {
    /// The device ID is made once and kept: sessions and external-file tabs are keyed by it, so a
    /// new ID makes this device forget its tabs in every workspace.
    pub fn load_or_create(
        path: &Path,
        device_name: impl FnOnce() -> String,
    ) -> io::Result<Machine> {
        if let Some(machine) = read_json::<Machine>(path)? {
            return Ok(machine);
        }
        let machine = Machine {
            version: 1,
            device_id: uuid::Uuid::new_v4().to_string(),
            device_name: device_name(),
        };
        write_json(path, &machine)?;
        Ok(machine)
    }
}

/// The name people know this Mac by (System Settings › General › Sharing), else the host name.
pub fn device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Some(name) = command_output("scutil", &["--get", "ComputerName"]) {
        return name;
    }
    command_output("hostname", &[]).unwrap_or_else(|| "unknown".into())
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// `settings.json`. Unknown fields are ignored on read, so a newer build's file still opens.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<PathBuf>,
    #[serde(default, deserialize_with = "lenient")]
    pub theme: ThemeSettings,
    #[serde(default, deserialize_with = "lenient")]
    pub extensions: ExtensionSettings,
}

/// A field whose value has the wrong shape (a hand-edit typo) falls back to its default instead of
/// failing the whole file, which `read_json` would set aside — taking `workspaceRoot` with it.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// Which theme to use under each OS appearance (spec 「테마」). `None` means the bundled default.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ThemeSettings {
    #[serde(default, deserialize_with = "lenient")]
    pub light: Option<ThemeRef>,
    #[serde(default, deserialize_with = "lenient")]
    pub dark: Option<ThemeRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThemeRef {
    pub extension: String,
    pub label: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSettings {
    /// IDs of user-installed extensions switched off; bundled ones cannot be.
    #[serde(default, deserialize_with = "lenient")]
    pub disabled: Vec<String>,
    /// Which side wins when two extensions claim one file extension (spec 「설치와 로딩」).
    #[serde(default, deserialize_with = "lenient")]
    pub precedence: Precedence,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Precedence {
    #[default]
    User,
    Bundled,
}

impl Settings {
    pub fn load(path: &Path) -> io::Result<Settings> {
        Ok(read_json(path)?.unwrap_or_default())
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        write_json(path, self)
    }

    pub fn workspace_root(&self, paths: &AppPaths) -> PathBuf {
        self.workspace_root_with_home(paths, dirs::home_dir().as_deref())
    }

    /// The configured root with a leading `~` expanded (people edit this file by hand). A relative
    /// path is taken from home: the app's working folder is usually `/`, so `Notes` would
    /// otherwise become `/Notes`. Without a known home the path is returned as it is.
    pub fn workspace_root_with_home(&self, paths: &AppPaths, home: Option<&Path>) -> PathBuf {
        // An empty path would make `home.join("")` the home folder itself the workspace root.
        let Some(root) = self
            .workspace_root
            .as_ref()
            .filter(|r| !r.as_os_str().is_empty())
        else {
            return paths.default_workspace_root.clone();
        };
        match (root.strip_prefix("~"), home) {
            (Ok(rest), Some(home)) => home.join(rest),
            (Err(_), Some(home)) if root.is_relative() => home.join(root),
            _ => root.clone(),
        }
    }
}

const RECENT_LIMIT: usize = 20;

/// `state.json`: what to reopen at the next launch and which workspace was used last.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchState {
    /// Workspace windows open when tote last quit, in the order they were opened.
    #[serde(default)]
    pub open_windows: Vec<PathBuf>,
    /// Workspaces by last use, most recent first.
    #[serde(default)]
    pub recent: Vec<PathBuf>,
}

impl LaunchState {
    pub fn load(path: &Path) -> io::Result<LaunchState> {
        Ok(read_json(path)?.unwrap_or_default())
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        write_json(path, self)
    }

    pub fn touch(&mut self, workspace: &Path) {
        self.recent.retain(|p| p != workspace);
        self.recent.insert(0, workspace.to_path_buf());
        self.recent.truncate(RECENT_LIMIT);
    }

    pub fn add_open(&mut self, workspace: &Path) {
        if !self.open_windows.iter().any(|p| p == workspace) {
            self.open_windows.push(workspace.to_path_buf());
        }
    }

    pub fn remove_open(&mut self, workspace: &Path) {
        self.open_windows.retain(|p| p != workspace);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn an_override_dir_holds_everything() {
        let paths = AppPaths::from_parts(
            Some("/tmp/t".into()),
            Some("/os".into()),
            Some("/home".into()),
            false,
        )
        .unwrap();
        assert_eq!(paths.data_dir, PathBuf::from("/tmp/t"));
        assert_eq!(
            paths.default_workspace_root,
            PathBuf::from("/tmp/t/workspaces")
        );
        assert_eq!(paths.launch_file(), PathBuf::from("/tmp/t/state.json"));
        assert_eq!(paths.machine_file(), PathBuf::from("/tmp/t/machine.json"));
        assert_eq!(paths.settings_file(), PathBuf::from("/tmp/t/settings.json"));
        assert_eq!(paths.buffers_dir(), PathBuf::from("/tmp/t/buffers"));
        assert_eq!(paths.inbox_dir(), PathBuf::from("/tmp/t/inbox"));
    }

    #[test]
    fn an_override_dir_must_be_absolute() {
        for bad in ["", "rel/dir"] {
            let paths = AppPaths::from_parts(
                Some(bad.into()),
                Some("/os".into()),
                Some("/home".into()),
                false,
            );
            assert_eq!(paths, None, "{bad:?} should be refused");
        }
    }

    #[test]
    fn debug_builds_keep_their_own_folders() {
        let os = Some(PathBuf::from("/os"));
        let home = Some(PathBuf::from("/home"));
        let release = AppPaths::from_parts(None, os.clone(), home.clone(), false).unwrap();
        let debug = AppPaths::from_parts(None, os, home, true).unwrap();
        assert_eq!(release.data_dir, PathBuf::from("/os/tote"));
        assert_eq!(release.default_workspace_root, PathBuf::from("/home/Tote"));
        assert_eq!(debug.data_dir, PathBuf::from("/os/tote-dev"));
        assert_eq!(
            debug.default_workspace_root,
            PathBuf::from("/home/Tote-dev")
        );
    }

    #[test]
    fn the_device_id_is_created_once() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("machine.json");
        let first = Machine::load_or_create(&file, || "맥북".into()).unwrap();
        let second = Machine::load_or_create(&file, || "다른 이름".into()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.device_name, "맥북");
        assert!(uuid::Uuid::parse_str(&first.device_id).is_ok());
    }

    #[test]
    fn an_unreadable_machine_file_is_set_aside_and_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("machine.json");
        fs::write(&file, "{ not json").unwrap();
        let machine = Machine::load_or_create(&file, || "맥북".into()).unwrap();
        assert!(uuid::Uuid::parse_str(&machine.device_id).is_ok());
        let aside = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("machine.json.corrupt-")
            })
            .count();
        assert_eq!(aside, 1);
    }

    #[test]
    fn the_workspace_root_defaults_and_expands_home() {
        let paths = AppPaths::from_parts(Some("/data".into()), None, None, false).unwrap();
        let home = Some(Path::new("/home"));
        assert_eq!(
            Settings::default().workspace_root_with_home(&paths, home),
            PathBuf::from("/data/workspaces")
        );
        let settings = Settings {
            workspace_root: Some("~/노트".into()),
            ..Default::default()
        };
        assert_eq!(
            settings.workspace_root_with_home(&paths, home),
            PathBuf::from("/home/노트")
        );
    }

    #[test]
    fn a_relative_workspace_root_is_under_home() {
        let paths = AppPaths::from_parts(Some("/data".into()), None, None, false).unwrap();
        let settings = Settings {
            workspace_root: Some("Notes".into()),
            ..Default::default()
        };
        assert_eq!(
            settings.workspace_root_with_home(&paths, Some(Path::new("/home"))),
            PathBuf::from("/home/Notes")
        );
        assert_eq!(
            settings.workspace_root_with_home(&paths, None),
            PathBuf::from("Notes")
        );
        let empty = Settings {
            workspace_root: Some("".into()),
            ..Default::default()
        };
        assert_eq!(
            empty.workspace_root_with_home(&paths, Some(Path::new("/home"))),
            paths.default_workspace_root
        );
    }

    #[test]
    fn settings_are_read_from_camel_case_json() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        fs::write(&file, r#"{ "workspaceRoot": "/x", "unknown": "later" }"#).unwrap();
        assert_eq!(
            Settings::load(&file).unwrap().workspace_root,
            Some(PathBuf::from("/x"))
        );
    }

    #[test]
    fn settings_round_trip_theme_and_extension_fields() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let settings = Settings {
            workspace_root: None,
            theme: ThemeSettings {
                light: Some(ThemeRef {
                    extension: "tote.themes".into(),
                    label: "Light+".into(),
                }),
                dark: None,
            },
            extensions: ExtensionSettings {
                disabled: vec!["someone.ext".into()],
                precedence: Precedence::Bundled,
            },
        };
        settings.save(&file).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"precedence\": \"bundled\""));
        assert!(text.contains("\"dark\": null"));
        assert!(!text.contains("workspaceRoot"));
        assert_eq!(Settings::load(&file).unwrap(), settings);
        assert_eq!(
            Settings::load(&dir.path().join("none.json")).unwrap(),
            Settings::default()
        );
        assert_eq!(Settings::default().extensions.precedence, Precedence::User);
    }

    #[test]
    fn a_mistyped_new_field_falls_back_without_losing_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        fs::write(&file, r#"{ "workspaceRoot": "/x", "theme": "dark" }"#).unwrap();
        let settings = Settings::load(&file).unwrap();
        assert_eq!(settings.workspace_root, Some(PathBuf::from("/x")));
        assert_eq!(settings.theme, ThemeSettings::default());
        fs::write(
            &file,
            r#"{ "workspaceRoot": "/x",
                 "theme": { "light": 3, "dark": { "extension": "a", "label": "b" } },
                 "extensions": { "disabled": ["e"], "precedence": "users" } }"#,
        )
        .unwrap();
        let settings = Settings::load(&file).unwrap();
        assert_eq!(settings.workspace_root, Some(PathBuf::from("/x")));
        assert_eq!(settings.theme.light, None);
        assert_eq!(settings.theme.dark.map(|t| t.label), Some("b".to_string()));
        assert_eq!(settings.extensions.disabled, vec!["e"]);
        assert_eq!(settings.extensions.precedence, Precedence::User);
    }

    #[test]
    fn recent_moves_to_the_front_without_duplicates_and_is_capped() {
        let mut launch = LaunchState::default();
        for i in 0..25 {
            launch.touch(Path::new(&format!("/w/{i}")));
        }
        launch.touch(Path::new("/w/10"));
        assert_eq!(launch.recent.len(), 20);
        assert_eq!(launch.recent[0], PathBuf::from("/w/10"));
        assert_eq!(
            launch
                .recent
                .iter()
                .filter(|p| **p == Path::new("/w/10"))
                .count(),
            1
        );
        assert_eq!(
            launch.recent.last().map(PathBuf::as_path),
            Some(Path::new("/w/5"))
        );
    }

    #[test]
    fn launch_state_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        let mut launch = LaunchState::default();
        launch.add_open(Path::new("/w/업무"));
        launch.add_open(Path::new("/w/업무"));
        launch.add_open(Path::new("/w/개인"));
        launch.remove_open(Path::new("/w/개인"));
        launch.save(&file).unwrap();
        let loaded = LaunchState::load(&file).unwrap();
        assert_eq!(loaded.open_windows, vec![PathBuf::from("/w/업무")]);
        assert!(fs::read_to_string(&file).unwrap().contains("openWindows"));
    }
}
