//! Per-device session files, `.tote/sessions/<device ID>.json` (spec 「세션」). The frontend owns
//! their schema (`SessionFile` in src/core/session.ts); this side only checks that they are JSON
//! objects and reads the window frame, which it needs before the window — and so its frontend —
//! exists.

pub mod drafts;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::persist::{read_json, write_json};
use crate::workspace::TOTE_DIR;

pub fn session_file(root: &Path, device_id: &str) -> PathBuf {
    root.join(TOTE_DIR)
        .join("sessions")
        .join(format!("{device_id}.json"))
}

/// The session text, or `None` when this device has none for the workspace yet. An unreadable
/// file is set aside and the window starts with no tabs.
pub fn read_session(root: &Path, device_id: &str) -> io::Result<Option<String>> {
    Ok(
        read_json::<Map<String, Value>>(&session_file(root, device_id))?
            .map(|map| Value::Object(map).to_string()),
    )
}

pub fn write_session(root: &Path, device_id: &str, json: &str) -> io::Result<()> {
    let map: Map<String, Value> = serde_json::from_str(json)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    write_json(&session_file(root, device_id), &map)
}

/// Where a workspace window was, in logical pixels (outer position, inner size).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The saved window frame when the session has a usable one.
pub fn read_window_frame(root: &Path, device_id: &str) -> Option<WindowFrame> {
    let text = fs::read_to_string(session_file(root, device_id)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let frame: WindowFrame = serde_json::from_value(value.get("window")?.clone()).ok()?;
    let finite = [frame.x, frame.y, frame.width, frame.height]
        .iter()
        .all(|v| v.is_finite());
    (finite && frame.width >= 200.0 && frame.height >= 150.0).then_some(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn corrupt_copies(dir: &std::path::Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .count()
    }

    #[test]
    fn sessions_round_trip_per_device() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(read_session(root.path(), "d1").unwrap(), None);
        write_session(root.path(), "d1", r#"{"version":1,"tabs":[]}"#).unwrap();
        let text = read_session(root.path(), "d1").unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(read_session(root.path(), "d2").unwrap(), None);
        assert!(session_file(root.path(), "d1").ends_with(".tote/sessions/d1.json"));
    }

    #[test]
    fn only_json_objects_are_written() {
        let root = tempfile::tempdir().unwrap();
        let err = write_session(root.path(), "d", "[1,2]").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn an_unreadable_session_starts_empty_and_is_set_aside() {
        let root = tempfile::tempdir().unwrap();
        let file = session_file(root.path(), "d");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "{ broken").unwrap();
        assert_eq!(read_session(root.path(), "d").unwrap(), None);
        assert!(!file.exists());
        assert_eq!(corrupt_copies(file.parent().unwrap()), 1);
    }

    #[test]
    fn the_window_frame_is_read_when_usable() {
        let root = tempfile::tempdir().unwrap();
        write_session(
            root.path(),
            "d",
            r#"{"window":{"x":10,"y":20,"width":900,"height":700}}"#,
        )
        .unwrap();
        assert_eq!(
            read_window_frame(root.path(), "d"),
            Some(WindowFrame {
                x: 10.0,
                y: 20.0,
                width: 900.0,
                height: 700.0
            })
        );
        write_session(
            root.path(),
            "d",
            r#"{"window":{"x":0,"y":0,"width":20,"height":20}}"#,
        )
        .unwrap();
        assert_eq!(read_window_frame(root.path(), "d"), None);
        write_session(root.path(), "d", r#"{"tabs":[]}"#).unwrap();
        assert_eq!(read_window_frame(root.path(), "d"), None);
    }
}
