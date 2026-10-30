//! Per-device session files, `.tote/sessions/<device ID>.json` (spec 「세션」): the layout of
//! every window open on the workspace, oldest-opened first. The frontend owns the layout schema
//! (`WindowSession` in src/core/session.ts); this side keeps each layout as a JSON object, gathers
//! the windows' layouts into the file, and reads a window's frame, which it needs before the
//! window — and so its frontend — exists.

pub mod drafts;

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::persist::{read_json, write_json};
use crate::workspace::TOTE_DIR;

pub const SESSION_VERSION: u64 = 2;

pub fn session_file(root: &Path, device_id: &str) -> PathBuf {
    root.join(TOTE_DIR)
        .join("sessions")
        .join(format!("{device_id}.json"))
}

/// The window layouts of the file, oldest-opened first; a version 1 file is one window. No file,
/// or one of neither shape, is no windows. An unreadable file is set aside.
pub fn read_layouts(root: &Path, device_id: &str) -> io::Result<Vec<Value>> {
    let Some(file) = read_json::<Map<String, Value>>(&session_file(root, device_id))? else {
        return Ok(Vec::new());
    };
    if let Some(Value::Array(windows)) = file.get("windows") {
        return Ok(windows.iter().filter(|w| w.is_object()).cloned().collect());
    }
    let Some(tabs @ Value::Array(_)) = file.get("tabs") else {
        return Ok(Vec::new());
    };
    // Version 1: one window, its tabs in one pane over the whole width.
    let mut pane = Map::new();
    pane.insert("tabs".into(), tabs.clone());
    if let Some(active) = file.get("activeTab") {
        pane.insert("activeTab".into(), active.clone());
    }
    pane.insert("width".into(), json!(1.0));
    let mut layout = Map::new();
    if let Some(frame) = file.get("window") {
        layout.insert("frame".into(), frame.clone());
    }
    layout.insert("panes".into(), json!([pane]));
    layout.insert("focusedPane".into(), json!(0));
    Ok(vec![Value::Object(layout)])
}

pub fn write_layouts(root: &Path, device_id: &str, layouts: &[Value]) -> io::Result<()> {
    write_json(
        &session_file(root, device_id),
        &json!({ "version": SESSION_VERSION, "windows": layouts }),
    )
}

/// Where a workspace window was, in logical pixels (outer position, inner size).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The layout's window frame when it has a usable one.
pub fn layout_frame(layout: &Value) -> Option<WindowFrame> {
    usable(serde_json::from_value(layout.get("frame")?.clone()).ok()?)
}

/// Whether the layout says the sidebar was folded away; anything but JSON `true` reads as open.
pub fn layout_sidebar_collapsed(layout: &Value) -> bool {
    layout.get("sidebarCollapsed") == Some(&Value::Bool(true))
}

/// The sidebar's width when the layout holds none it can use (`SIDEBAR_WIDTH` in
/// src/core/sidebar-width.ts).
pub const DEFAULT_SIDEBAR_WIDTH: f64 = 240.0;

/// The sidebar's width the layout says, or the default for anything but a number from 180 to 480
/// — as the page reads it (`parseSidebarWidth`).
pub fn layout_sidebar_width(layout: &Value) -> f64 {
    layout
        .get("sidebarWidth")
        .and_then(Value::as_f64)
        .filter(|width| (180.0..=480.0).contains(width))
        .unwrap_or(DEFAULT_SIDEBAR_WIDTH)
}

fn usable(frame: WindowFrame) -> Option<WindowFrame> {
    let finite = [frame.x, frame.y, frame.width, frame.height]
        .iter()
        .all(|v| v.is_finite());
    (finite && frame.width >= 200.0 && frame.height >= 150.0).then_some(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn corrupt_copies(dir: &std::path::Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .count()
    }

    fn put(root: &Path, device_id: &str, text: &str) {
        let file = session_file(root, device_id);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, text).unwrap();
    }

    #[test]
    fn a_version_1_file_reads_as_one_window() {
        let root = tempfile::tempdir().unwrap();
        let (a, b) = (
            json!({"kind": "memo", "memoId": "a"}),
            json!({"kind": "memo", "memoId": "b"}),
        );
        put(
            root.path(),
            "d",
            &json!({
                "version": 1,
                "window": {"x": 10, "y": 20, "width": 900, "height": 700},
                "activeTab": 1,
                "tabs": [a, b],
            })
            .to_string(),
        );
        assert_eq!(
            read_layouts(root.path(), "d").unwrap(),
            vec![json!({
                "frame": {"x": 10, "y": 20, "width": 900, "height": 700},
                "panes": [{"tabs": [a, b], "activeTab": 1, "width": 1.0}],
                "focusedPane": 0,
            })]
        );
    }

    #[test]
    fn layouts_round_trip_as_version_2() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            read_layouts(root.path(), "d1").unwrap(),
            Vec::<Value>::new()
        );
        let l1 = json!({"panes": [{"tabs": [], "activeTab": -1, "width": 1.0}], "focusedPane": 0});
        let l2 = json!({"frame": {"x": 1, "y": 2, "width": 800, "height": 600}, "panes": []});
        write_layouts(root.path(), "d1", &[l1.clone(), l2.clone()]).unwrap();
        let file: Value =
            serde_json::from_str(&fs::read_to_string(session_file(root.path(), "d1")).unwrap())
                .unwrap();
        assert_eq!(file["version"], 2);
        assert_eq!(read_layouts(root.path(), "d1").unwrap(), vec![l1, l2]);
        // Each device has its own file.
        assert_eq!(
            read_layouts(root.path(), "d2").unwrap(),
            Vec::<Value>::new()
        );
        assert!(session_file(root.path(), "d1").ends_with(".tote/sessions/d1.json"));
    }

    #[test]
    fn a_file_with_neither_shape_reads_as_no_windows() {
        let root = tempfile::tempdir().unwrap();
        for text in [r#"{"version":2}"#, r#"{"tabs":"x"}"#] {
            put(root.path(), "d", text);
            assert_eq!(read_layouts(root.path(), "d").unwrap(), Vec::<Value>::new());
        }
    }

    #[test]
    fn an_unreadable_session_starts_empty_and_is_set_aside() {
        let root = tempfile::tempdir().unwrap();
        let file = session_file(root.path(), "d");
        put(root.path(), "d", "{ broken");
        assert_eq!(read_layouts(root.path(), "d").unwrap(), Vec::<Value>::new());
        assert!(!file.exists());
        assert_eq!(corrupt_copies(file.parent().unwrap()), 1);
    }

    #[test]
    fn the_sidebar_is_collapsed_only_when_the_layout_says_true() {
        assert!(layout_sidebar_collapsed(&json!({"sidebarCollapsed": true})));
        for layout in [
            json!({"sidebarCollapsed": "true"}),
            json!({"sidebarCollapsed": 1}),
            json!({"sidebarCollapsed": null}),
            json!({"sidebarCollapsed": false}),
            json!({"panes": []}),
        ] {
            assert!(!layout_sidebar_collapsed(&layout), "{layout}");
        }
    }

    #[test]
    fn the_sidebar_width_is_read_only_from_180_to_480() {
        for (layout, width) in [
            (json!({"sidebarWidth": 180}), 180.0),
            (json!({"sidebarWidth": 320.5}), 320.5),
            (json!({"sidebarWidth": 480}), 480.0),
        ] {
            assert_eq!(layout_sidebar_width(&layout), width, "{layout}");
        }
        for layout in [
            json!({"sidebarWidth": 179.9}),
            json!({"sidebarWidth": 481}),
            json!({"sidebarWidth": -300}),
            json!({"sidebarWidth": "300"}),
            json!({"sidebarWidth": null}),
            json!({"sidebarWidth": true}),
            json!({"panes": []}),
        ] {
            assert_eq!(
                layout_sidebar_width(&layout),
                DEFAULT_SIDEBAR_WIDTH,
                "{layout}"
            );
        }
        assert_eq!(DEFAULT_SIDEBAR_WIDTH, 240.0);
    }

    #[test]
    fn the_window_frame_is_read_when_usable() {
        assert_eq!(
            layout_frame(&json!({"frame": {"x": 10, "y": 20, "width": 900, "height": 700}})),
            Some(WindowFrame {
                x: 10.0,
                y: 20.0,
                width: 900.0,
                height: 700.0
            })
        );
        for frame in [
            json!({"x": 0, "y": 0, "width": 20, "height": 20}),
            json!({"x": 0, "y": 0, "width": 199, "height": 700}),
            json!({"x": 0, "y": 0, "width": 900, "height": 149}),
            json!({"x": "0", "y": 0, "width": 900, "height": 700}),
        ] {
            assert_eq!(layout_frame(&json!({ "frame": frame })), None);
        }
        assert_eq!(layout_frame(&json!({"panes": []})), None);
        // JSON has no infinity; one written from a frame that had it reads back unusable.
        let infinite = WindowFrame {
            x: f64::INFINITY,
            y: 0.0,
            width: 900.0,
            height: 700.0,
        };
        assert_eq!(usable(infinite), None);
    }
}
