//! The `tote` shell command (spec 「`tote` CLI」). The script in the app bundle runs the app binary
//! with `TOTE_CLI=1`; that process checks the arguments, prints problems to stderr, hands a
//! `CliRequest` to the app (starting it when needed) and exits — the shell never waits for tote.

pub mod front;
pub mod install;

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::workspace::names::is_valid_file_name;
use crate::workspace::Workspace;

/// A request travels as one argument, `--tote-request=<json>`: in the app's own argv on a fresh
/// launch, or in the argv single-instance forwards to a running app.
pub const REQUEST_FLAG: &str = "--tote-request=";

pub const USAGE: &str = "사용법: tote [-w 워크스페이스] [--import] [파일…] [-]
  tote                 앱을 앞으로 가져온다
  tote a.sh b.md       가장 최근 창에 외부 탭으로 연다
  tote -w 업무 a.sh    그 워크스페이스에 연다
  tote --import a.sh   워크스페이스로 복사해 메모로 연다
  echo 내용 | tote -   표준 입력으로 새 메모를 만든다";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRequest {
    /// Folder name under the workspace root (`-w`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// Absolute paths; folders were already turned away.
    #[serde(default)]
    pub files: Vec<PathBuf>,
    #[serde(default)]
    pub import: bool,
    /// Text read from stdin (`tote -`), parked in a file under the app data folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin_file: Option<PathBuf>,
}

impl CliRequest {
    pub fn to_arg(&self) -> String {
        let json = serde_json::to_string(self).expect("plain data always serialises");
        format!("{REQUEST_FLAG}{json}")
    }

    pub fn find_in<I, S>(args: I) -> Option<CliRequest>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        args.into_iter().find_map(|arg| {
            let json = arg.as_ref().strip_prefix(REQUEST_FLAG)?;
            serde_json::from_str(json).ok()
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum Parsed {
    Help,
    Run {
        workspace: Option<String>,
        paths: Vec<String>,
        import: bool,
        stdin: bool,
    },
}

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum UsageError {
    #[error("알 수 없는 옵션: {0}")]
    UnknownOption(String),
    #[error("-w 뒤에 워크스페이스 이름이 필요합니다")]
    MissingWorkspace,
}

pub fn parse_args(args: &[String]) -> Result<Parsed, UsageError> {
    let mut workspace = None;
    let mut paths = Vec::new();
    let (mut import, mut stdin, mut only_paths) = (false, false, false);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if only_paths {
            paths.push(arg.clone());
            continue;
        }
        match arg.as_str() {
            "-h" | "--help" => return Ok(Parsed::Help),
            "-w" | "--workspace" => {
                workspace = Some(args.next().ok_or(UsageError::MissingWorkspace)?.clone())
            }
            "--import" => import = true,
            "-" => stdin = true,
            "--" => only_paths = true,
            option if option.starts_with('-') => {
                return Err(UsageError::UnknownOption(option.to_string()))
            }
            _ => paths.push(arg.clone()),
        }
    }
    Ok(Parsed::Run {
        workspace,
        paths,
        import,
        stdin,
    })
}

/// `cwd.join(path)` with `.` and `..` folded away without touching the disk: the path may not
/// exist yet (`tote new.txt` creates it on ⌘S), and links stay as the person typed them.
pub fn absolute(cwd: &Path, path: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in cwd.join(path).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub struct Resolved {
    pub request: CliRequest,
    /// Lines for stderr; any of them makes the exit code 1.
    pub rejected: Vec<String>,
}

/// Checks the arguments before the app sees them, because only this process can still answer the
/// shell. An unknown `-w` workspace stops everything; folders are turned away one by one.
pub fn resolve(
    workspace: Option<String>,
    paths: &[String],
    import: bool,
    cwd: &Path,
    workspace_root: &Path,
) -> Result<Resolved, String> {
    if let Some(name) = &workspace {
        if !is_valid_file_name(name) || !Workspace::is_workspace(&workspace_root.join(name)) {
            return Err(format!("워크스페이스가 없습니다: {name}"));
        }
    }
    let mut files = Vec::new();
    let mut rejected = Vec::new();
    for path in paths {
        let path = absolute(cwd, path);
        if path.is_dir() {
            rejected.push(format!("폴더는 열 수 없습니다: {}", path.display()));
        } else if import && !path.is_file() {
            rejected.push(format!("가져올 파일이 없습니다: {}", path.display()));
        } else {
            files.push(path);
        }
    }
    Ok(Resolved {
        request: CliRequest {
            workspace,
            files,
            import,
            stdin_file: None,
        },
        rejected,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn options_and_paths() {
        assert_eq!(
            parse_args(&args(&[
                "-w", "업무", "--import", "a.sh", "-", "--", "-x.txt"
            ]))
            .unwrap(),
            Parsed::Run {
                workspace: Some("업무".into()),
                paths: args(&["a.sh", "-x.txt"]),
                import: true,
                stdin: true
            }
        );
        assert_eq!(
            parse_args(&[]).unwrap(),
            Parsed::Run {
                workspace: None,
                paths: vec![],
                import: false,
                stdin: false
            }
        );
        assert_eq!(parse_args(&args(&["--help"])).unwrap(), Parsed::Help);
        assert_eq!(
            parse_args(&args(&["-w"])),
            Err(UsageError::MissingWorkspace)
        );
        assert_eq!(
            parse_args(&args(&["--wait"])),
            Err(UsageError::UnknownOption("--wait".into()))
        );
    }

    #[test]
    fn relative_paths_resolve_against_the_calling_folder() {
        let cwd = Path::new("/Users/me/작업");
        assert_eq!(absolute(cwd, "a.sh"), PathBuf::from("/Users/me/작업/a.sh"));
        assert_eq!(
            absolute(cwd, "../b/./c.md"),
            PathBuf::from("/Users/me/b/c.md")
        );
        assert_eq!(absolute(cwd, "/etc/hosts"), PathBuf::from("/etc/hosts"));
        assert_eq!(absolute(Path::new("/"), "../../x"), PathBuf::from("/x"));
    }

    #[test]
    fn folders_are_rejected_one_by_one() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("폴더")).unwrap();
        fs::write(dir.path().join("a.sh"), "").unwrap();
        let resolved = resolve(
            None,
            &args(&["a.sh", "폴더", "없는.txt"]),
            false,
            dir.path(),
            dir.path(),
        )
        .unwrap();
        assert_eq!(
            resolved.request.files,
            vec![dir.path().join("a.sh"), dir.path().join("없는.txt")]
        );
        assert_eq!(resolved.rejected.len(), 1);
        assert!(resolved.rejected[0].contains("폴더는 열 수 없습니다"));
    }

    #[test]
    fn importing_needs_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = resolve(None, &args(&["없음.txt"]), true, dir.path(), dir.path()).unwrap();
        assert!(resolved.request.files.is_empty());
        assert_eq!(resolved.rejected.len(), 1);
    }

    #[test]
    fn an_unknown_workspace_stops_everything() {
        let root = tempfile::tempdir().unwrap();
        crate::workspace::Workspace::create(root.path(), "업무").unwrap();
        assert!(resolve(Some("업무".into()), &[], false, root.path(), root.path()).is_ok());
        assert!(resolve(Some("없는곳".into()), &[], false, root.path(), root.path()).is_err());
        assert!(resolve(Some("../업무".into()), &[], false, root.path(), root.path()).is_err());
    }

    #[test]
    fn requests_survive_the_trip_through_argv() {
        let request = CliRequest {
            workspace: Some("업무".into()),
            files: vec!["/a b/파일.sh".into()],
            import: true,
            stdin_file: None,
        };
        let argv = vec![
            "/Applications/tote.app/Contents/MacOS/tote".to_string(),
            request.to_arg(),
        ];
        assert_eq!(CliRequest::find_in(&argv), Some(request));
        assert_eq!(CliRequest::find_in(["tote"]), None);
    }
}
