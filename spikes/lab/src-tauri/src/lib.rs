use std::path::PathBuf;

use serde::Serialize;

#[derive(Serialize)]
struct LabEnv {
    auto: Option<String>,
    video: Option<String>,
    video2: Option<String>,
    image: Option<String>,
}

#[tauri::command]
fn lab_env() -> LabEnv {
    let var = |key: &str| std::env::var(key).ok();
    LabEnv {
        auto: var("TOTE_LAB_AUTO"),
        video: var("TOTE_LAB_VIDEO"),
        video2: var("TOTE_LAB_VIDEO2"),
        image: var("TOTE_LAB_IMAGE"),
    }
}

fn is_valid_result_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[tauri::command]
fn record_result(name: String, json: String) -> Result<(), String> {
    if !is_valid_result_name(&name) {
        return Err(format!("invalid result name: {name}"));
    }
    // Results land next to the lab sources no matter which directory the binary was started from.
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../results");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{name}.json")), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // focus:false only affects the window; without this macOS still activates the app on launch
    // and pulls it in front of whatever the person is working in.
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![lab_env, record_result, exit_app])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::is_valid_result_name;

    #[test]
    fn result_names_are_restricted_to_safe_characters() {
        assert!(is_valid_result_name("latency-code-10mb-javascript"));
        assert!(!is_valid_result_name(""));
        assert!(!is_valid_result_name("../escape"));
        assert!(!is_valid_result_name("Upper"));
        assert!(!is_valid_result_name("a/b"));
    }
}
