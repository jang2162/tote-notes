//! What runs when the `tote` script starts the app binary.

use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::{parse_args, resolve, CliRequest, Parsed, USAGE};
use crate::appdata::{legacy_root_to_pin, AppPaths, LaunchState, Settings};

/// Runs the command line when the `tote` script started this binary (`TOTE_CLI=1`). Returns the
/// exit code, or `None` to start the app as usual.
pub fn run_if_cli() -> Option<i32> {
    if std::env::var_os("TOTE_CLI").as_deref() != Some(OsStr::new("1")) {
        return None;
    }
    let args: Option<Vec<String>> = std::env::args_os()
        .skip(1)
        .map(|a| a.into_string().ok())
        .collect();
    let Some(args) = args else {
        eprintln!("tote: UTF-8 이 아닌 인자는 쓸 수 없습니다\n{USAGE}");
        return Some(2);
    };
    Some(run(&args))
}

fn run(args: &[String]) -> i32 {
    let (workspace, paths, import, stdin) = match parse_args(args) {
        Ok(Parsed::Run {
            workspace,
            paths,
            import,
            stdin,
        }) => (workspace, paths, import, stdin),
        Ok(Parsed::Help) => {
            println!("{USAGE}");
            return 0;
        }
        Err(err) => {
            eprintln!("tote: {err}\n{USAGE}");
            return 2;
        }
    };
    let Some(app_paths) = AppPaths::resolve() else {
        match std::env::var_os("TOTE_DATA_DIR") {
            Some(value) => eprintln!(
                "tote: TOTE_DATA_DIR 은 절대 경로여야 합니다: {}",
                value.to_string_lossy()
            ),
            None => eprintln!("tote: 앱 데이터 폴더를 찾지 못했습니다"),
        }
        return 1;
    };
    let (settings, warning) = settings_for_cli(&app_paths.settings_file());
    if let Some(warning) = warning {
        eprintln!("{warning}");
    }
    let root = root_for_cli(&settings, &app_paths, dirs::home_dir().as_deref());
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(err) => {
            eprintln!("tote: 현재 폴더를 알 수 없습니다: {err}");
            return 1;
        }
    };
    let mut resolved = match resolve(workspace, &paths, import, &cwd, &root) {
        Ok(resolved) => resolved,
        Err(message) => {
            eprintln!("tote: {message}");
            return 1;
        }
    };
    for message in &resolved.rejected {
        eprintln!("tote: {message}");
    }
    if stdin {
        match park_stdin(&app_paths.inbox_dir()) {
            Ok(file) => resolved.request.stdin_file = Some(file),
            Err(err) => {
                eprintln!("tote: 표준 입력을 읽지 못했습니다: {err}");
                return 1;
            }
        }
    }
    if let Err(err) = launch(&resolved.request) {
        eprintln!("tote: 앱을 실행하지 못했습니다: {err}");
        if let Some(file) = &resolved.request.stdin_file {
            let _ = std::fs::remove_file(file);
        }
        return 1;
    }
    i32::from(!resolved.rejected.is_empty())
}

/// Reads `settings.json` without touching it. `Settings::load` sets a broken file aside, which a
/// short-lived command must not do to the person's settings; the app does that when it loads.
/// The second value is the warning to print when the file could not be used.
fn settings_for_cli(path: &Path) -> (Settings, Option<String>) {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return (Settings::default(), None),
        Err(err) => return (Settings::default(), Some(settings_warning(&err))),
    };
    match serde_json::from_slice(&bytes) {
        Ok(settings) => (settings, None),
        Err(err) => (Settings::default(), Some(settings_warning(&err))),
    }
}

/// The root `-w` names a workspace in. Until the app has checked for the old default root
/// (`legacyRootChecked`), that is the root it will pin when it launches — a new version not
/// launched yet would otherwise send `-w 업무` to an empty `~/.tote`. Reads only: `state.json`
/// that does not parse counts as unchecked, as it does for the app, which sets it aside.
fn root_for_cli(settings: &Settings, paths: &AppPaths, home: Option<&Path>) -> PathBuf {
    let checked = std::fs::read(paths.launch_file())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<LaunchState>(&bytes).ok())
        .is_some_and(|launch| launch.legacy_root_checked);
    let mut settings = settings.clone();
    if let Some(root) = legacy_root_to_pin(&settings, paths, home).filter(|_| !checked) {
        settings.workspace_root = Some(root);
    }
    settings.workspace_root_with_home(paths, home)
}

fn settings_warning(err: &dyn std::fmt::Display) -> String {
    format!("tote: 설정 파일을 읽지 못해 기본 워크스페이스 루트를 씁니다: {err}")
}

fn park_stdin(dir: &Path) -> io::Result<PathBuf> {
    park(&mut io::stdin().lock(), dir)
}

/// Copies `source` into a new file in `dir` as it comes, so `big-command | tote -` holds a
/// buffer of it and never the whole. Written in place, not through a temporary file: nobody
/// knows the name until this returns it, and a copy cut short is removed.
fn park(source: &mut impl Read, dir: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let file = dir.join(format!("{}.txt", uuid::Uuid::new_v4().simple()));
    let copied = File::create_new(&file).and_then(|mut parked| {
        io::copy(source, &mut parked)?;
        parked.sync_all()
    });
    if let Err(err) = copied {
        let _ = std::fs::remove_file(&file);
        return Err(err);
    }
    Ok(file)
}

/// Hands the request to the app. Inside an app bundle this goes through LaunchServices
/// (`open -n`): the new process passes the request to a running tote through single-instance and
/// exits, or becomes tote when none runs. A development binary outside a bundle is started
/// directly, in its own process group so closing the terminal does not take tote with it.
fn launch(request: &CliRequest) -> io::Result<()> {
    let exe = std::env::current_exe()?;
    if let Some(bundle) = app_bundle(&exe) {
        let status = Command::new("open")
            .arg("-n")
            .arg(&bundle)
            .arg("--args")
            .arg(request.to_arg())
            .status()?;
        return if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("open: {status}")))
        };
    }
    let mut command = Command::new(exe);
    command
        .arg(request.to_arg())
        .env_remove("TOTE_CLI")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map(|_| ())
}

/// `/Applications/tote.app` for a binary at `/Applications/tote.app/Contents/MacOS/tote`.
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    is_bundle.then(|| bundle.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_bundle_around_the_binary() {
        assert_eq!(
            app_bundle(Path::new("/Applications/tote.app/Contents/MacOS/tote")),
            Some(PathBuf::from("/Applications/tote.app"))
        );
        assert_eq!(
            app_bundle(Path::new("/repo/src-tauri/target/debug/tote")),
            None
        );
    }

    #[test]
    fn before_the_app_has_pinned_the_old_root_the_cli_looks_there_without_writing_it() {
        let home = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_parts(
            None,
            Some(home.path().join("os")),
            Some(home.path().into()),
            false,
        )
        .unwrap();
        crate::workspace::Workspace::create(&home.path().join("Tote"), "업무").unwrap();
        let root = |settings: &Settings| root_for_cli(settings, &paths, Some(home.path()));
        // The new app has not launched yet: `-w 업무` finds the workspace where it will look.
        assert_eq!(root(&Settings::default()), home.path().join("Tote"));
        assert!(!paths.settings_file().exists());
        assert!(!paths.launch_file().exists());
        // A broken state.json is started over by the app, unchecked, so the same goes here.
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(paths.launch_file(), b"{ broken").unwrap();
        assert_eq!(root(&Settings::default()), home.path().join("Tote"));
        assert_eq!(std::fs::read(paths.launch_file()).unwrap(), b"{ broken");
        // The state.json 0.1.0 wrote, without the mark: every person with an old root has one.
        std::fs::write(
            paths.launch_file(),
            "{\"openWindows\": [], \"recent\": [\"/Users/me/Tote/업무\"]}",
        )
        .unwrap();
        assert_eq!(root(&Settings::default()), home.path().join("Tote"));
        // Once the app has checked, the settings say where, even when the person cleared them.
        std::fs::write(paths.launch_file(), b"{\"legacyRootChecked\": true}").unwrap();
        assert_eq!(root(&Settings::default()), home.path().join(".tote"));
        std::fs::remove_file(paths.launch_file()).unwrap();
        let set = Settings {
            workspace_root: Some("/w".into()),
            ..Settings::default()
        };
        assert_eq!(root(&set), PathBuf::from("/w"));
    }

    /// The files in `dir` and their sizes.
    fn sizes(dir: &Path) -> Vec<u64> {
        std::fs::read_dir(dir).map_or(Vec::new(), |entries| {
            entries
                .map(|entry| entry.unwrap().metadata().unwrap().len())
                .collect()
        })
    }

    #[test]
    fn piped_text_is_parked_as_it_comes_not_held_whole() {
        /// 4 MiB of text that, once half of it is handed out, looks at how much has reached the
        /// inbox: none of it when the reader is drained before anything is written.
        struct Piped<'a> {
            left: usize,
            inbox: &'a Path,
            on_disk_halfway: Option<u64>,
        }
        const TOTAL: usize = 4 << 20;
        impl Read for Piped<'_> {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.left <= TOTAL / 2 && self.on_disk_halfway.is_none() {
                    self.on_disk_halfway = Some(sizes(self.inbox).iter().sum());
                }
                let n = buf.len().min(self.left).min(64 << 10);
                buf[..n].fill(b'a');
                self.left -= n;
                Ok(n)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("inbox");
        let mut piped = Piped {
            left: TOTAL,
            inbox: &inbox,
            on_disk_halfway: None,
        };
        let file = park(&mut piped, &inbox).unwrap();
        assert_eq!(file.parent(), Some(inbox.as_path()));
        assert_eq!(file.extension().unwrap(), "txt");
        assert_eq!(sizes(&inbox), vec![TOTAL as u64]);
        let halfway = piped.on_disk_halfway.unwrap();
        assert!(
            halfway >= (TOTAL / 4) as u64,
            "{halfway} bytes were on disk when half the text had been read"
        );
        // Text that stops coming with an error leaves no half of itself behind.
        struct Broken(bool);
        impl Read for Broken {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if std::mem::replace(&mut self.0, true) {
                    return Err(io::Error::other("the pipe broke"));
                }
                buf.fill(b'b');
                Ok(buf.len())
            }
        }
        assert!(park(&mut Broken(false), &inbox).is_err());
        assert_eq!(sizes(&inbox), vec![TOTAL as u64]);
    }

    #[test]
    fn the_cli_reads_broken_settings_without_moving_them() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        assert_eq!(settings_for_cli(&file), (Settings::default(), None));
        std::fs::write(&file, b"{\"workspaceRoot\": \"/w\"}").unwrap();
        let (settings, warning) = settings_for_cli(&file);
        assert_eq!(settings.workspace_root, Some("/w".into()));
        assert_eq!(warning, None);
        std::fs::write(&file, b"{\"workspaceRoot\": ").unwrap();
        let (settings, warning) = settings_for_cli(&file);
        assert_eq!(settings, Settings::default());
        assert!(warning.unwrap().starts_with("tote: 설정 파일을 읽지 못해"));
        assert!(file.exists());
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["settings.json"]);
    }
}
