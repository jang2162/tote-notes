//! What runs when the `tote` script starts the app binary.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::{parse_args, resolve, CliRequest, Parsed, USAGE};
use crate::appdata::{AppPaths, Settings};
use crate::persist::atomic_write;

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
    let settings = Settings::load(&app_paths.settings_file()).unwrap_or_else(|err| {
        eprintln!("tote: 설정 파일을 읽지 못해 기본 워크스페이스 루트를 씁니다: {err}");
        Settings::default()
    });
    let root = settings.workspace_root(&app_paths);
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

fn park_stdin(dir: &Path) -> io::Result<PathBuf> {
    let mut text = Vec::new();
    io::stdin().read_to_end(&mut text)?;
    std::fs::create_dir_all(dir)?;
    let file = dir.join(format!("{}.txt", uuid::Uuid::new_v4().simple()));
    atomic_write(&file, &text)?;
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
}
