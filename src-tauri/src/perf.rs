//! Timing marks for the performance measurement (tests/measure/perf.md). Off unless the app was
//! started with `TOTE_PERF=1`; then every mark is one JSON line in `<data dir>/perf.jsonl`, timed
//! from the first line of `main`.

use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;

use crate::app::lock;
use crate::appdata::AppPaths;

static START: OnceLock<Instant> = OnceLock::new();
static LOG: OnceLock<Option<PerfLog>> = OnceLock::new();

/// The clock every mark is timed from. `main` calls it first, before anything else runs.
pub fn start() {
    START.get_or_init(Instant::now);
}

/// Adds the mark `name`, when marks are on.
pub fn mark(name: &str) {
    let log = LOG.get_or_init(|| {
        let path = AppPaths::resolve()?.perf_log();
        PerfLog::open(
            std::env::var_os("TOTE_PERF"),
            &path,
            *START.get_or_init(Instant::now),
        )
    });
    if let Some(log) = log {
        log.mark(name);
    }
}

pub struct PerfLog {
    file: Mutex<File>,
    start: Instant,
}

impl PerfLog {
    /// The log at `path` when `enabled` (the value of `TOTE_PERF`) is `1`. Opened for appending:
    /// the measurement script moves the file away after each run.
    pub fn open(enabled: Option<OsString>, path: &Path, start: Instant) -> Option<PerfLog> {
        if enabled.as_deref() != Some("1".as_ref()) {
            return None;
        }
        // `process-start` comes before the app makes its data folder on a first launch.
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| eprintln!("tote: perf log {}: {err}", path.display()))
            .ok()?;
        Some(PerfLog {
            file: Mutex::new(file),
            start,
        })
    }

    pub fn mark(&self, name: &str) {
        let line = serde_json::json!({
            "t": self.start.elapsed().as_secs_f64() * 1000.0,
            "name": name,
            "pid": std::process::id(),
        });
        // One write per line, so lines from two threads never interleave.
        let _ = lock(&self.file).write_all(format!("{line}\n").as_bytes());
    }
}

/// The workspace search a measurement run asks for (`TOTE_PERF_SEARCH`, with
/// `TOTE_PERF_SEARCH_REGEX=1` for a regex): the window runs it once it is ready. A plain runtime
/// switch, so the build that is measured is the one that runs it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PerfSearch {
    pub query: String,
    pub regex: bool,
}

impl PerfSearch {
    pub fn from_env() -> Option<PerfSearch> {
        PerfSearch::from_vars(
            std::env::var("TOTE_PERF_SEARCH").ok(),
            std::env::var("TOTE_PERF_SEARCH_REGEX").ok(),
        )
    }

    pub fn from_vars(query: Option<String>, regex: Option<String>) -> Option<PerfSearch> {
        let query = query.filter(|q| !q.is_empty())?;
        Some(PerfSearch {
            query,
            regex: regex.as_deref() == Some("1"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_appended_as_jsonl_only_when_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("perf.jsonl");
        let start = Instant::now();

        assert!(PerfLog::open(None, &path, start).is_none());
        assert!(PerfLog::open(Some("0".into()), &path, start).is_none());
        assert!(!path.exists());

        let log = PerfLog::open(Some("1".into()), &path, start).unwrap();
        log.mark("process-start");
        log.mark("open-start:t1");
        // Another process (or a second open) adds to the file rather than starting it over.
        PerfLog::open(Some("1".into()), &path, start)
            .unwrap()
            .mark("app-ready");

        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let names: Vec<&str> = lines.iter().map(|l| l["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["process-start", "open-start:t1", "app-ready"]);
        let times: Vec<f64> = lines.iter().map(|l| l["t"].as_f64().unwrap()).collect();
        assert!(times[0] >= 0.0 && times.windows(2).all(|w| w[0] <= w[1]));
        assert!(lines
            .iter()
            .all(|l| l["pid"].as_u64() == Some(u64::from(std::process::id()))));
    }

    #[test]
    fn a_first_launch_makes_the_data_folder_for_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-yet").join("perf.jsonl");
        PerfLog::open(Some("1".into()), &path, Instant::now())
            .unwrap()
            .mark("process-start");
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("process-start"));
    }

    #[test]
    fn a_perf_search_needs_a_query() {
        assert_eq!(PerfSearch::from_vars(None, None), None);
        assert_eq!(PerfSearch::from_vars(Some(String::new()), None), None);
        assert_eq!(
            PerfSearch::from_vars(Some("needle-\\d+5$".into()), Some("1".into())),
            Some(PerfSearch {
                query: "needle-\\d+5$".into(),
                regex: true
            })
        );
        assert_eq!(
            PerfSearch::from_vars(Some("needle-50".into()), None),
            Some(PerfSearch {
                query: "needle-50".into(),
                regex: false
            })
        );
    }
}
