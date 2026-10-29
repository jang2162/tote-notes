//! This device's own files, outside every workspace (spec 「워크스페이스와 데이터 모델」): the device
//! ID, settings, and which workspace windows to reopen. Where they live is decided here and
//! nowhere else.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::persist::{read_json, write_json};
use crate::shortcuts;

#[derive(Clone, Debug, PartialEq)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub default_workspace_root: PathBuf,
    /// The default root until 0.1.0, as `settings.json` would name it (`~/Tote`, debug
    /// `~/Tote-dev`): `pin_legacy_root` keeps it for the person who has workspaces there. `None`
    /// under `TOTE_DATA_DIR`, whose root never moved.
    pub legacy_workspace_root: Option<PathBuf>,
}

impl AppPaths {
    /// `TOTE_DATA_DIR` moves everything for one run — workspaces included — so tests and smoke
    /// checks never touch real notes. Debug builds use `tote-dev` and `~/.tote-dev` so a
    /// development run never touches the notes of an installed tote. A `TOTE_DATA_DIR` that is empty or
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
                legacy_workspace_root: None,
            });
        }
        let suffix = if debug { "-dev" } else { "" };
        Some(AppPaths {
            data_dir: os_data_dir?.join(format!("tote{suffix}")),
            default_workspace_root: home?.join(format!(".tote{suffix}")),
            legacy_workspace_root: Some(PathBuf::from(format!("~/Tote{suffix}"))),
        })
    }

    pub fn machine_file(&self) -> PathBuf {
        self.data_dir.join("machine.json")
    }

    pub fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    /// Extensions the person installed, one folder per `<id>@<version>` (spec 「설치와 로딩」).
    pub fn extensions_dir(&self) -> PathBuf {
        self.data_dir.join("extensions")
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

    /// Workspace snapshots, one folder per workspace ID (spec 「백업」).
    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }

    /// Timing marks of a measurement run (`TOTE_PERF=1`, src/perf.rs).
    pub fn perf_log(&self) -> PathBuf {
        self.data_dir.join("perf.jsonl")
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
    #[serde(default, deserialize_with = "lenient")]
    pub editor: EditorSettings,
    #[serde(default, deserialize_with = "lenient")]
    pub updates: UpdateSettings,
    /// Command id → the shortcut it has instead of its default, `None` for none (src/shortcuts.rs).
    #[serde(
        default,
        deserialize_with = "shortcut_overrides",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub shortcuts: BTreeMap<String, Option<String>>,
}

/// A field whose value has the wrong shape (a hand-edit typo) falls back to its default instead of
/// failing the whole file, which `read_json` would set aside — taking `workspaceRoot` with it.
pub(crate) fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// The saved shortcut overrides, each entry judged on its own: one that is not a string or `null`,
/// or that `shortcuts::sanitize` drops, goes and the rest stay. Kept in memory as read, a bad
/// entry would ride along in every patch the settings screen makes and get each one refused. A
/// keypad key an older build recorded is read as its main-row twin first (`shortcuts::from_keypad`).
fn shortcut_overrides<'de, D>(deserializer: D) -> Result<BTreeMap<String, Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries: BTreeMap<String, serde_json::Value> = lenient(deserializer)?;
    let saved = entries
        .into_iter()
        .filter_map(|(id, keys)| match keys {
            serde_json::Value::Null => Some((id, None)),
            serde_json::Value::String(keys) => Some((id, Some(keys))),
            _ => None,
        })
        .collect();
    Ok(shortcuts::sanitize(&shortcuts::from_keypad(&saved)))
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorSettings {
    #[serde(deserialize_with = "lenient_on")]
    pub line_numbers: bool,
    /// Within `FONT_SIZES`, however it was written.
    #[serde(deserialize_with = "font_size")]
    pub font_size: u8,
    /// A CSS font family; empty is the bundled default.
    #[serde(deserialize_with = "lenient")]
    pub font_family: String,
}

/// The update check at launch (src/app/update.rs); off, tote sends nothing to github.com unless
/// the person picks 「업데이트 확인…」.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateSettings {
    #[serde(deserialize_with = "lenient_on")]
    pub auto_check: bool,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        UpdateSettings { auto_check: true }
    }
}

const DEFAULT_FONT_SIZE: u8 = 14;
const FONT_SIZES: std::ops::RangeInclusive<u8> = 11..=24;

impl Default for EditorSettings {
    fn default() -> Self {
        EditorSettings {
            line_numbers: true,
            font_size: DEFAULT_FONT_SIZE,
            font_family: String::new(),
        }
    }
}

/// `lenient` for a switch that is on by default.
fn lenient_on<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(serde_json::Value::deserialize(deserializer)?
        .as_bool()
        .unwrap_or(true))
}

/// A number out of range goes to the nearer end; anything but a number is the default.
fn font_size<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(serde_json::Value::deserialize(deserializer)?
        .as_f64()
        .map_or(DEFAULT_FONT_SIZE, clamp_font_size))
}

/// A patch's size, held to the range the way a hand-edited file's is. Not a number is refused.
fn patch_font_size<'de, D>(deserializer: D) -> Result<Option<u8>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    f64::deserialize(deserializer).map(|size| Some(clamp_font_size(size)))
}

fn clamp_font_size(size: f64) -> u8 {
    let (min, max) = (*FONT_SIZES.start(), *FONT_SIZES.end());
    size.round().clamp(f64::from(min), f64::from(max)) as u8
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Precedence {
    #[default]
    User,
    Bundled,
}

/// A change to some settings fields, as one settings screen makes it. Only the fields it names
/// are written, so two windows changing different fields at once keep both changes; writing
/// whole settings would put back whatever the other window had just changed.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, deserialize_with = "double_option")]
    pub workspace_root: Option<Option<PathBuf>>,
    #[serde(default, deserialize_with = "double_option")]
    pub theme_light: Option<Option<ThemeRef>>,
    #[serde(default, deserialize_with = "double_option")]
    pub theme_dark: Option<Option<ThemeRef>>,
    #[serde(default)]
    pub precedence: Option<Precedence>,
    #[serde(default)]
    pub editor_line_numbers: Option<bool>,
    #[serde(default, deserialize_with = "patch_font_size")]
    pub editor_font_size: Option<u8>,
    #[serde(default)]
    pub editor_font_family: Option<String>,
    #[serde(default)]
    pub updates_auto_check: Option<bool>,
    /// The whole map: what is not in it goes back to its default.
    #[serde(default)]
    pub shortcuts: Option<BTreeMap<String, Option<String>>>,
    /// The saved map `shortcuts` was made from. A patch whose `shortcuts` came from a table
    /// another window has changed since is refused, whatever else it names.
    #[serde(default)]
    pub shortcuts_expected: Option<BTreeMap<String, Option<String>>>,
}

/// What `apply` says when `shortcuts_expected` is not the saved map; the settings screen tells
/// it from the other refusals by this text.
pub const SHORTCUTS_CHANGED: &str = "shortcuts changed";

/// A key that is present, `null` included, becomes `Some`; a missing key stays `None` through
/// `#[serde(default)]`. That is what tells "clear it" from "leave it".
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

impl SettingsPatch {
    /// Refuses the whole patch, changing nothing, when its shortcuts break a rule
    /// (`shortcuts::validate`) or were made from a map that is no longer the saved one.
    pub fn apply(&self, settings: &mut Settings) -> Result<(), String> {
        if let Some(expected) = &self.shortcuts_expected {
            if shortcuts::without_defaults(expected)
                != shortcuts::without_defaults(&settings.shortcuts)
            {
                return Err(SHORTCUTS_CHANGED.into());
            }
        }
        if let Some(overrides) = &self.shortcuts {
            shortcuts::validate(overrides)?;
        }
        if let Some(root) = &self.workspace_root {
            settings.workspace_root = root.clone();
        }
        if let Some(light) = &self.theme_light {
            settings.theme.light = light.clone();
        }
        if let Some(dark) = &self.theme_dark {
            settings.theme.dark = dark.clone();
        }
        if let Some(precedence) = self.precedence {
            settings.extensions.precedence = precedence;
        }
        if let Some(on) = self.editor_line_numbers {
            settings.editor.line_numbers = on;
        }
        if let Some(size) = self.editor_font_size {
            settings.editor.font_size = size.clamp(*FONT_SIZES.start(), *FONT_SIZES.end());
        }
        if let Some(family) = &self.editor_font_family {
            settings.editor.font_family = family.clone();
        }
        if let Some(on) = self.updates_auto_check {
            settings.updates.auto_check = on;
        }
        if let Some(overrides) = &self.shortcuts {
            settings.shortcuts = overrides.clone();
        }
        Ok(())
    }
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
    /// Workspace windows open when tote last quit, in the order they were opened: one entry per
    /// window, so a workspace shown in two windows is listed twice.
    #[serde(default)]
    pub open_windows: Vec<PathBuf>,
    /// Workspaces by last use, most recent first.
    #[serde(default)]
    pub recent: Vec<PathBuf>,
    /// `pin_legacy_root` has run: once, so a root the person clears afterwards stays the default.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub legacy_root_checked: bool,
}

/// `path` as a person writes it in `settings.json`: under home as `~/…`.
pub fn shown_from_home(path: &Path, home: Option<&Path>) -> String {
    match home.and_then(|home| path.strip_prefix(home).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// Until 0.1.0 an unset `workspaceRoot` meant `~/Tote`; now it means `~/.tote`. On the first launch
/// that knows this, settings that leave the root unset while the old folder holds a workspace (and
/// the new one none) get the old root written in, so the person's memos stay where tote looks.
/// Returns whether `settings` changed; `launch` is marked checked either way, and the caller keeps
/// the mark only once the settings are saved.
pub fn pin_legacy_root(
    settings: &mut Settings,
    launch: &mut LaunchState,
    paths: &AppPaths,
    home: Option<&Path>,
) -> bool {
    if launch.legacy_root_checked {
        return false;
    }
    launch.legacy_root_checked = true;
    let Some(legacy) = legacy_root_to_pin(settings, paths, home) else {
        return false;
    };
    settings.workspace_root = Some(legacy);
    true
}

/// The old root `pin_legacy_root` writes into `settings`, if any, deciding only: the `tote`
/// command, which must not write the settings, uses it to look where the app will once launched.
pub fn legacy_root_to_pin(
    settings: &Settings,
    paths: &AppPaths,
    home: Option<&Path>,
) -> Option<PathBuf> {
    let unset = settings
        .workspace_root
        .as_ref()
        .is_none_or(|root| root.as_os_str().is_empty());
    let legacy = paths.legacy_workspace_root.clone().filter(|_| unset)?;
    let old = Settings {
        workspace_root: Some(legacy.clone()),
        ..Settings::default()
    };
    let holds = |root: &Path| !crate::workspace::Workspace::list(root).is_empty();
    (may_hold_workspaces(&old.workspace_root_with_home(paths, home))
        && !holds(&paths.default_workspace_root))
    .then_some(legacy)
}

/// Whether the old root has workspaces, or is there (as a link too) but cannot be read this time
/// — a volume not yet mounted, a read the system refuses. Those cannot be ruled out, and the root
/// was the old default anyway, so writing it in only keeps what tote did before. The same goes
/// for a workspace in a root that reads.
fn may_hold_workspaces(root: &Path) -> bool {
    if std::fs::symlink_metadata(root).is_err() {
        return false;
    }
    match std::fs::read_dir(root) {
        Ok(entries) => {
            !crate::workspace::Workspace::list(root).is_empty()
                || entries
                    .filter_map(Result::ok)
                    .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
                    .any(|entry| cannot_be_read_now(&entry.path()))
        }
        Err(err) => err.kind() != io::ErrorKind::NotADirectory,
    }
}

/// An entry of a root that reads, which may be a workspace not readable this time: a link whose
/// target is gone, or one whose `workspace.json` the system will not look up. A file, or a folder
/// without one, is not.
fn cannot_be_read_now(entry: &Path) -> bool {
    if std::fs::metadata(entry).is_err() {
        return true;
    }
    let file = entry
        .join(crate::workspace::TOTE_DIR)
        .join("workspace.json");
    std::fs::metadata(file).is_err_and(|err| {
        !matches!(
            err.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
        )
    })
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

    /// A window on `workspace` opened.
    pub fn add_open(&mut self, workspace: &Path) {
        self.open_windows.push(workspace.to_path_buf());
    }

    /// A window on `workspace` closed: one entry goes, the workspace's other windows stay.
    pub fn remove_open(&mut self, workspace: &Path) {
        if let Some(at) = self.open_windows.iter().position(|p| p == workspace) {
            self.open_windows.remove(at);
        }
    }

    /// A window switched from the workspace `from` to `to`: the first entry of `from` becomes `to`
    /// where it stands, so the windows keep their order.
    pub fn switch_open(&mut self, from: &Path, to: &Path) {
        if let Some(entry) = self.open_windows.iter_mut().find(|p| *p == from) {
            *entry = to.to_path_buf();
        }
    }

    /// The workspace at `from` now lives at `to`: every mention follows it. In the recent list a
    /// `to` that is already listed keeps one entry, the earlier of the two places; the windows to
    /// reopen keep every entry, one per window.
    pub fn relocate(&mut self, from: &Path, to: &Path) {
        for path in &mut self.open_windows {
            if path == from {
                *path = to.to_path_buf();
            }
        }
        let mut seen_to = false;
        let mut moved = Vec::with_capacity(self.recent.len());
        for path in self.recent.drain(..) {
            let path = if path == from { to.to_path_buf() } else { path };
            if path == to {
                if seen_to {
                    continue;
                }
                seen_to = true;
            }
            moved.push(path);
        }
        self.recent = moved;
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
        assert_eq!(paths.extensions_dir(), PathBuf::from("/tmp/t/extensions"));
        assert_eq!(paths.inbox_dir(), PathBuf::from("/tmp/t/inbox"));
        assert_eq!(paths.backups_dir(), PathBuf::from("/tmp/t/backups"));
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
        assert_eq!(release.default_workspace_root, PathBuf::from("/home/.tote"));
        assert_eq!(debug.data_dir, PathBuf::from("/os/tote-dev"));
        assert_eq!(
            debug.default_workspace_root,
            PathBuf::from("/home/.tote-dev")
        );
        assert_eq!(release.legacy_workspace_root, Some("~/Tote".into()));
        assert_eq!(debug.legacy_workspace_root, Some("~/Tote-dev".into()));
        let overridden =
            AppPaths::from_parts(Some("/t".into()), None, Some("/home".into()), false).unwrap();
        assert_eq!(overridden.legacy_workspace_root, None);
    }

    /// The paths of a release whose home is `home`.
    fn release_under(home: &Path) -> AppPaths {
        AppPaths::from_parts(None, Some(home.join("os")), Some(home.to_path_buf()), false).unwrap()
    }

    fn workspace_in(root: &Path, name: &str) {
        crate::workspace::Workspace::create(root, name).unwrap();
    }

    #[test]
    fn a_path_under_home_is_shown_with_a_tilde() {
        let home = Some(Path::new("/Users/me"));
        assert_eq!(
            shown_from_home(Path::new("/Users/me/.tote"), home),
            "~/.tote"
        );
        assert_eq!(shown_from_home(Path::new("/Users/me"), home), "~");
        assert_eq!(
            shown_from_home(Path::new("/Users/mein/x"), home),
            "/Users/mein/x"
        );
        assert_eq!(
            shown_from_home(Path::new("/data/workspaces"), None),
            "/data/workspaces"
        );
    }

    #[test]
    fn workspaces_under_the_old_default_root_stay_where_tote_looks() {
        let home = tempfile::tempdir().unwrap();
        let paths = release_under(home.path());
        workspace_in(&home.path().join("Tote"), "메모");
        let (mut settings, mut launch) = (Settings::default(), LaunchState::default());
        assert!(pin_legacy_root(
            &mut settings,
            &mut launch,
            &paths,
            Some(home.path())
        ));
        assert_eq!(settings.workspace_root, Some("~/Tote".into()));
        assert_eq!(
            settings.workspace_root_with_home(&paths, Some(home.path())),
            home.path().join("Tote")
        );
        assert!(launch.legacy_root_checked);
        // Once: a root the person clears afterwards is the new default from then on.
        settings.workspace_root = None;
        assert!(!pin_legacy_root(
            &mut settings,
            &mut launch,
            &paths,
            Some(home.path())
        ));
        assert_eq!(settings.workspace_root, None);
    }

    #[test]
    fn the_old_root_is_left_alone_when_it_holds_no_workspace_or_a_root_is_set() {
        let home = tempfile::tempdir().unwrap();
        let paths = release_under(home.path());
        let check = |settings: &mut Settings| {
            let mut launch = LaunchState::default();
            let changed = pin_legacy_root(settings, &mut launch, &paths, Some(home.path()));
            assert!(launch.legacy_root_checked);
            changed
        };
        // No ~/Tote, or one with only other folders and files in it.
        assert!(!check(&mut Settings::default()));
        fs::create_dir_all(home.path().join("Tote/사진")).unwrap();
        fs::write(home.path().join("Tote/a.md"), "x").unwrap();
        assert!(!check(&mut Settings::default()));
        workspace_in(&home.path().join("Tote"), "메모");
        // A root the person wrote, the new default included, is theirs.
        for root in ["~/.tote", "/elsewhere"] {
            let mut settings = Settings {
                workspace_root: Some(root.into()),
                ..Default::default()
            };
            assert!(!check(&mut settings));
            assert_eq!(settings.workspace_root, Some(root.into()));
        }
        // The new default already has workspaces: it is in use, the old one is not shown over it.
        workspace_in(&home.path().join(".tote"), "메모");
        assert!(!check(&mut Settings::default()));
    }

    /// `~/Tote` is there but cannot be read this time: an unmounted volume behind a link, or a
    /// folder the system refuses. Its workspaces cannot be ruled out, so it is kept, as before.
    #[test]
    fn an_old_root_that_cannot_be_read_now_is_kept() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let home = tempfile::tempdir().unwrap();
        let paths = release_under(home.path());
        let old = home.path().join("Tote");
        symlink("/Volumes/not-mounted-now/Tote", &old).unwrap();
        let (mut settings, mut launch) = (Settings::default(), LaunchState::default());
        assert!(pin_legacy_root(
            &mut settings,
            &mut launch,
            &paths,
            Some(home.path())
        ));
        assert_eq!(settings.workspace_root, Some("~/Tote".into()));

        fs::remove_file(&old).unwrap();
        workspace_in(&old, "메모");
        fs::set_permissions(&old, fs::Permissions::from_mode(0o000)).unwrap();
        let (mut settings, mut launch) = (Settings::default(), LaunchState::default());
        let changed = pin_legacy_root(&mut settings, &mut launch, &paths, Some(home.path()));
        fs::set_permissions(&old, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(changed);
        // The root in use is the old one, so the first window's `메모` is not made under the new
        // default — which would leave the old root unpinned for good once it reads again.
        assert_eq!(
            settings.workspace_root_with_home(&paths, Some(home.path())),
            old
        );
        assert!(!paths.default_workspace_root.exists());

        // A file named `Tote` is not a root anyone used.
        fs::remove_dir_all(&old).unwrap();
        fs::write(&old, "x").unwrap();
        let (mut settings, mut launch) = (Settings::default(), LaunchState::default());
        assert!(!pin_legacy_root(
            &mut settings,
            &mut launch,
            &paths,
            Some(home.path())
        ));
    }

    /// `~/Tote` reads, but a workspace in it does not: one the system refuses, or a link to a
    /// volume not mounted. The same as the root itself not reading — it cannot be ruled out.
    #[test]
    fn an_old_root_whose_workspace_cannot_be_read_now_is_kept() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let home = tempfile::tempdir().unwrap();
        let paths = release_under(home.path());
        let old = home.path().join("Tote");
        let check = || {
            let (mut settings, mut launch) = (Settings::default(), LaunchState::default());
            pin_legacy_root(&mut settings, &mut launch, &paths, Some(home.path()))
        };
        workspace_in(&old, "메모");
        let memo = old.join("메모");
        fs::set_permissions(&memo, fs::Permissions::from_mode(0o000)).unwrap();
        let changed = check();
        fs::set_permissions(&memo, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(changed);

        fs::remove_dir_all(&memo).unwrap();
        symlink("/Volumes/not-mounted-now/업무", old.join("업무")).unwrap();
        assert!(check());

        // A folder that reads and has no `.tote` is one the person keeps there, not a workspace;
        // nor is anything dotted, which tote never lists.
        fs::remove_file(old.join("업무")).unwrap();
        symlink("/Volumes/not-mounted-now/숨김", old.join(".숨김")).unwrap();
        fs::create_dir(old.join("사진")).unwrap();
        fs::create_dir_all(old.join("문서/.tote")).unwrap();
        fs::write(old.join("a.md"), "x").unwrap();
        assert!(!check());
    }

    #[test]
    fn an_empty_root_counts_as_unset_and_the_override_root_never_moves() {
        let home = tempfile::tempdir().unwrap();
        workspace_in(&home.path().join("Tote"), "메모");
        let mut settings = Settings {
            workspace_root: Some("".into()),
            ..Default::default()
        };
        let paths = release_under(home.path());
        let mut launch = LaunchState::default();
        assert!(pin_legacy_root(
            &mut settings,
            &mut launch,
            &paths,
            Some(home.path())
        ));
        let overridden = AppPaths::from_parts(
            Some(home.path().join("t")),
            None,
            Some(home.path().into()),
            false,
        )
        .unwrap();
        let (mut settings, mut launch) = (Settings::default(), LaunchState::default());
        assert!(!pin_legacy_root(
            &mut settings,
            &mut launch,
            &overridden,
            Some(home.path())
        ));
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
            editor: EditorSettings {
                line_numbers: false,
                font_size: 16,
                font_family: "D2Coding".into(),
            },
            updates: UpdateSettings { auto_check: false },
            shortcuts: BTreeMap::from([
                ("rename".into(), Some("CmdOrCtrl+K".into())),
                ("new-memo".into(), None),
            ]),
        };
        settings.save(&file).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"precedence\": \"bundled\""));
        assert!(text.contains("\"lineNumbers\": false"));
        assert!(text.contains("\"new-memo\": null"));
        assert!(text.contains("\"dark\": null"));
        assert!(!text.contains("workspaceRoot"));
        assert_eq!(Settings::load(&file).unwrap(), settings);
        assert_eq!(
            Settings::load(&dir.path().join("none.json")).unwrap(),
            Settings::default()
        );
        assert_eq!(Settings::default().extensions.precedence, Precedence::User);
        Settings::default().save(&file).unwrap();
        assert!(!fs::read_to_string(&file).unwrap().contains("shortcuts"));
    }

    #[test]
    fn editor_settings_default_to_line_numbers_on_14_and_the_default_font() {
        let expected = EditorSettings {
            line_numbers: true,
            font_size: 14,
            font_family: String::new(),
        };
        let settings = serde_json::from_str::<Settings>("{}").unwrap();
        assert_eq!(settings.editor, expected);
        assert_eq!(settings.shortcuts, BTreeMap::new());
        let settings = serde_json::from_str::<Settings>(r#"{"editor": {}}"#).unwrap();
        assert_eq!(settings.editor, expected);
        // Each field on its own: a wrong one does not take the others with it.
        let settings = serde_json::from_str::<Settings>(
            r#"{"editor": {"lineNumbers": "no", "fontFamily": 3, "fontSize": 18}}"#,
        )
        .unwrap();
        assert_eq!(
            settings.editor,
            EditorSettings {
                font_size: 18,
                ..expected
            }
        );
    }

    #[test]
    fn a_font_size_out_of_range_is_clamped() {
        let read = |size: &str| {
            serde_json::from_str::<Settings>(&format!(
                r#"{{"workspaceRoot": "/x",
                    "theme": {{"dark": {{"extension": "a", "label": "b"}}}},
                    "editor": {{"lineNumbers": false, "fontSize": {size}}}}}"#
            ))
            .unwrap()
        };
        for (size, expected) in [
            ("40", 24),
            ("3", 11),
            ("\"big\"", 14),
            ("-5", 11),
            ("300", 24),
            ("16.6", 17),
            ("null", 14),
        ] {
            let settings = read(size);
            assert_eq!(settings.editor.font_size, expected, "{size}");
            assert!(!settings.editor.line_numbers);
            assert_eq!(settings.workspace_root, Some(PathBuf::from("/x")));
            assert_eq!(settings.theme.dark.map(|t| t.label), Some("b".to_string()));
        }
        let mut settings = Settings::default();
        for (size, expected) in [(40, 24), (3, 11), (20, 20)] {
            SettingsPatch {
                editor_font_size: Some(size),
                ..Default::default()
            }
            .apply(&mut settings)
            .unwrap();
            assert_eq!(settings.editor.font_size, expected);
        }
        let patch = serde_json::from_str::<SettingsPatch>(r#"{"editorFontSize": 300}"#).unwrap();
        assert_eq!(patch.editor_font_size, Some(24));
    }

    #[test]
    fn updates_auto_check_is_on_by_default_and_survives_a_bad_value() {
        let read = |text: &str| serde_json::from_str::<Settings>(text).unwrap();
        assert!(read("{}").updates.auto_check);
        assert!(
            !read(r#"{"updates": {"autoCheck": false}}"#)
                .updates
                .auto_check
        );
        let bad = read(r#"{"workspaceRoot": "/x", "updates": {"autoCheck": "no"}}"#);
        assert!(bad.updates.auto_check);
        assert_eq!(bad.workspace_root, Some(PathBuf::from("/x")));
        let bad = read(r#"{"workspaceRoot": "/x", "updates": 3}"#);
        assert!(bad.updates.auto_check);
        assert_eq!(bad.workspace_root, Some(PathBuf::from("/x")));

        let mut settings = Settings {
            workspace_root: Some("/x".into()),
            ..Default::default()
        };
        let patch =
            serde_json::from_str::<SettingsPatch>(r#"{"updatesAutoCheck": false}"#).unwrap();
        patch.apply(&mut settings).unwrap();
        assert!(!settings.updates.auto_check);
        assert_eq!(settings.workspace_root, Some(PathBuf::from("/x")));
        assert!(settings.editor.line_numbers);
        let written = serde_json::to_value(&settings).unwrap();
        assert_eq!(written["updates"], serde_json::json!({"autoCheck": false}));
    }

    #[test]
    fn a_bad_shortcut_entry_is_dropped_on_read_and_the_rest_kept() {
        let settings = serde_json::from_str::<Settings>(
            r#"{"workspaceRoot": "/x", "editor": {"fontSize": 18},
                "shortcuts": {"new-memo": "CmdOrCtrl+Shift+M", "nope": "CmdOrCtrl+K",
                              "save": "Cmd+++", "rename": 3, "close-tab": null}}"#,
        )
        .unwrap();
        assert_eq!(
            settings.shortcuts,
            BTreeMap::from([
                (
                    "new-memo".to_string(),
                    Some("CmdOrCtrl+Shift+M".to_string())
                ),
                ("close-tab".to_string(), None),
            ])
        );
        assert_eq!(settings.workspace_root, Some(PathBuf::from("/x")));
        assert_eq!(settings.editor.font_size, 18);
        let settings = serde_json::from_str::<Settings>(r#"{"shortcuts": ["x"]}"#).unwrap();
        assert_eq!(settings.shortcuts, BTreeMap::new());
    }

    #[test]
    fn a_saved_keypad_shortcut_is_read_as_its_main_row_twin() {
        let settings = serde_json::from_str::<Settings>(
            r#"{"shortcuts": {"rename": "CmdOrCtrl+Numpad1", "new-memo": "CmdOrCtrl+NumpadAdd"}}"#,
        )
        .unwrap();
        assert_eq!(
            settings.shortcuts,
            BTreeMap::from([("rename".to_string(), Some("CmdOrCtrl+1".to_string()))])
        );
    }

    #[test]
    fn a_patch_with_an_unparsable_shortcut_is_refused_and_nothing_changes() {
        let mut settings = Settings {
            workspace_root: Some("/x".into()),
            shortcuts: BTreeMap::from([("rename".into(), Some("CmdOrCtrl+K".into()))]),
            ..Default::default()
        };
        let before = settings.clone();
        let patch = SettingsPatch {
            workspace_root: Some(Some("/y".into())),
            editor_line_numbers: Some(false),
            shortcuts: Some(BTreeMap::from([
                ("close-tab".into(), None),
                ("save".into(), Some("Cmd+++".into())),
            ])),
            ..Default::default()
        };
        let error = patch.apply(&mut settings).unwrap_err();
        assert!(error.contains("save"), "{error}");
        assert_eq!(settings, before);
    }

    #[test]
    fn a_shortcut_patch_made_from_a_stale_map_is_refused() {
        let saved = BTreeMap::from([("save".to_string(), Some("CmdOrCtrl+Shift+S".to_string()))]);
        let mut settings = Settings {
            shortcuts: saved.clone(),
            ..Default::default()
        };
        let stale = SettingsPatch {
            editor_line_numbers: Some(false),
            shortcuts: Some(BTreeMap::from([("rename".into(), None)])),
            shortcuts_expected: Some(BTreeMap::new()),
            ..Default::default()
        };
        assert_eq!(stale.apply(&mut settings).unwrap_err(), SHORTCUTS_CHANGED);
        assert_eq!(settings.shortcuts, saved);
        assert!(
            settings.editor.line_numbers,
            "the other fields are refused with it"
        );

        let fresh = SettingsPatch {
            shortcuts: Some(BTreeMap::from([("rename".into(), None)])),
            shortcuts_expected: Some(saved),
            ..Default::default()
        };
        fresh.apply(&mut settings).unwrap();
        assert_eq!(
            settings.shortcuts,
            BTreeMap::from([("rename".to_string(), None)])
        );
    }

    #[test]
    fn an_entry_equal_to_its_default_does_not_make_the_saved_map_stale() {
        let mut settings = Settings {
            shortcuts: BTreeMap::from([
                ("save".to_string(), Some("Cmd+S".to_string())),
                ("rename".to_string(), None),
                (
                    "new-memo".to_string(),
                    Some("CmdOrCtrl+Shift+M".to_string()),
                ),
            ]),
            ..Default::default()
        };
        let patch = SettingsPatch {
            shortcuts: Some(BTreeMap::from([("close-tab".into(), None)])),
            shortcuts_expected: Some(BTreeMap::from([(
                "new-memo".to_string(),
                Some("CmdOrCtrl+Shift+M".to_string()),
            )])),
            ..Default::default()
        };
        patch.apply(&mut settings).unwrap();
        assert_eq!(
            settings.shortcuts,
            BTreeMap::from([("close-tab".to_string(), None)])
        );
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
    fn a_patch_changes_only_the_fields_it_names() {
        let night = ThemeRef {
            extension: "someone.night".into(),
            label: "Night".into(),
        };
        let day = ThemeRef {
            extension: "tote.themes".into(),
            label: "Light+".into(),
        };
        let mut settings = Settings {
            workspace_root: Some("/x".into()),
            theme: ThemeSettings {
                light: None,
                dark: Some(night.clone()),
            },
            extensions: ExtensionSettings {
                disabled: vec!["e".into()],
                precedence: Precedence::User,
            },
            editor: EditorSettings {
                line_numbers: false,
                font_size: 16,
                font_family: "D2Coding".into(),
            },
            updates: UpdateSettings { auto_check: false },
            shortcuts: BTreeMap::from([("rename".into(), Some("CmdOrCtrl+K".into()))]),
        };
        SettingsPatch {
            theme_light: Some(Some(day.clone())),
            ..Default::default()
        }
        .apply(&mut settings)
        .unwrap();
        assert_eq!(settings.theme.light, Some(day));
        assert_eq!(settings.workspace_root, Some(PathBuf::from("/x")));
        assert_eq!(settings.theme.dark, Some(night));
        assert_eq!(settings.extensions.disabled, vec!["e"]);
        assert_eq!(
            settings.editor,
            EditorSettings {
                line_numbers: false,
                font_size: 16,
                font_family: "D2Coding".into(),
            }
        );
        assert_eq!(settings.shortcuts.len(), 1);
        SettingsPatch {
            workspace_root: Some(None),
            ..Default::default()
        }
        .apply(&mut settings)
        .unwrap();
        assert_eq!(settings.workspace_root, None);

        SettingsPatch {
            editor_line_numbers: Some(true),
            ..Default::default()
        }
        .apply(&mut settings)
        .unwrap();
        assert!(settings.editor.line_numbers);
        assert_eq!(settings.editor.font_size, 16);
        assert_eq!(settings.editor.font_family, "D2Coding");
        SettingsPatch {
            editor_font_size: Some(20),
            ..Default::default()
        }
        .apply(&mut settings)
        .unwrap();
        assert_eq!(settings.editor.font_size, 20);
        assert!(settings.editor.line_numbers);
        SettingsPatch {
            editor_font_family: Some("Menlo".into()),
            ..Default::default()
        }
        .apply(&mut settings)
        .unwrap();
        assert_eq!(settings.editor.font_family, "Menlo");
        assert_eq!(settings.editor.font_size, 20);
        assert_eq!(settings.shortcuts.len(), 1);
        // The map is replaced whole: `rename` is no longer in it.
        SettingsPatch {
            shortcuts: Some(BTreeMap::from([("new-memo".into(), None)])),
            ..Default::default()
        }
        .apply(&mut settings)
        .unwrap();
        assert_eq!(
            settings.shortcuts,
            BTreeMap::from([("new-memo".to_string(), None)])
        );
        assert_eq!(settings.editor.font_family, "Menlo");
        assert_eq!(
            settings.theme.dark.as_ref().map(|t| t.label.as_str()),
            Some("Night")
        );

        let null = serde_json::from_str::<SettingsPatch>(r#"{"workspaceRoot": null}"#).unwrap();
        assert_eq!(null.workspace_root, Some(None));
        let empty = serde_json::from_str::<SettingsPatch>("{}").unwrap();
        assert_eq!(empty.workspace_root, None);
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
        assert_eq!(
            loaded.open_windows,
            vec![PathBuf::from("/w/업무"), PathBuf::from("/w/업무")]
        );
        assert!(fs::read_to_string(&file).unwrap().contains("openWindows"));
    }

    #[test]
    fn relocate_moves_every_mention_of_the_path() {
        let mut launch = LaunchState {
            recent: vec!["/w/a".into(), "/gone/옛".into(), "/w/b".into()],
            open_windows: vec!["/gone/옛".into(), "/w/b".into()],
            ..Default::default()
        };
        launch.relocate(Path::new("/gone/옛"), Path::new("/new/옛"));
        assert_eq!(
            launch.recent,
            vec![
                PathBuf::from("/w/a"),
                PathBuf::from("/new/옛"),
                PathBuf::from("/w/b")
            ]
        );
        assert_eq!(
            launch.open_windows,
            vec![PathBuf::from("/new/옛"), PathBuf::from("/w/b")]
        );
        // The target already listed: one entry stays.
        launch.recent = vec!["/new/옛".into(), "/gone/옛".into()];
        launch.relocate(Path::new("/gone/옛"), Path::new("/new/옛"));
        assert_eq!(launch.recent, vec![PathBuf::from("/new/옛")]);
        launch.recent = vec!["/gone/옛".into(), "/new/옛".into()];
        launch.relocate(Path::new("/gone/옛"), Path::new("/new/옛"));
        assert_eq!(launch.recent, vec![PathBuf::from("/new/옛")]);
    }

    #[test]
    fn open_windows_keep_a_workspace_once_per_window() {
        let mut launch = LaunchState::default();
        launch.add_open(Path::new("/w/P"));
        launch.add_open(Path::new("/w/P"));
        assert_eq!(
            launch.open_windows,
            vec![PathBuf::from("/w/P"), PathBuf::from("/w/P")]
        );
        launch.remove_open(Path::new("/w/P"));
        assert_eq!(launch.open_windows, vec![PathBuf::from("/w/P")]);
    }

    #[test]
    fn relocate_keeps_every_window_of_a_workspace() {
        let mut launch = LaunchState {
            recent: vec!["/gone/옛".into(), "/new/옛".into()],
            open_windows: vec!["/gone/옛".into(), "/w/다른".into(), "/gone/옛".into()],
            ..Default::default()
        };
        launch.relocate(Path::new("/gone/옛"), Path::new("/new/옛"));
        assert_eq!(
            launch.open_windows,
            vec![
                PathBuf::from("/new/옛"),
                PathBuf::from("/w/다른"),
                PathBuf::from("/new/옛")
            ]
        );
        assert_eq!(launch.recent, vec![PathBuf::from("/new/옛")]);
    }

    #[test]
    fn switch_open_replaces_one_entry_in_place() {
        let mut launch = LaunchState {
            recent: vec![],
            open_windows: vec!["/w/A".into(), "/w/B".into(), "/w/A".into()],
            ..Default::default()
        };
        launch.switch_open(Path::new("/w/A"), Path::new("/w/C"));
        assert_eq!(
            launch.open_windows,
            vec![
                PathBuf::from("/w/C"),
                PathBuf::from("/w/B"),
                PathBuf::from("/w/A")
            ]
        );
    }
}
