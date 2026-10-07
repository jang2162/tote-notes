mod file_scheme;

use std::path::PathBuf;

use file_scheme::TokenStore;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LabEnv {
    auto: Option<String>,
    video: Option<String>,
    video2: Option<String>,
    image: Option<String>,
    viewer_page: Option<String>,
}

#[tauri::command]
fn lab_env() -> LabEnv {
    let var = |key: &str| std::env::var(key).ok();
    LabEnv {
        auto: var("TOTE_LAB_AUTO"),
        video: var("TOTE_LAB_VIDEO"),
        video2: var("TOTE_LAB_VIDEO2"),
        image: var("TOTE_LAB_IMAGE"),
        viewer_page: var("TOTE_LAB_VIEWER_PAGE"),
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

// Probe for the viewer spike: if a sandboxed frame ever gets a command through, this line shows up.
#[tauri::command]
fn ipc_probe(source: String) {
    eprintln!("[ipc-probe] reached source={source}");
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn issue_file_token(store: State<'_, TokenStore>, path: String) -> String {
    format!("tote-file://localhost/{}", store.issue(PathBuf::from(path)))
}

/// Auto runs keep a small window on top in the primary monitor's bottom-right corner. Once the
/// window is covered, macOS throttles the WebView's content process and every timing is invalid.
fn place_auto_window(app: &tauri::App) -> tauri::Result<()> {
    use tauri::Manager;
    const MARGIN: f64 = 16.0;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window.set_always_on_top(true)?;
    // A full-screen app on the monitor shows its own Space there, which hides every other window
    // unless the window joins all Spaces and may sit beside a full-screen window.
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        // SAFETY: setup runs on the main thread, and the pointer is this window's live NSWindow.
        let ns_window = unsafe { &*window.ns_window()?.cast::<NSWindow>() };
        ns_window.setCollectionBehavior(
            ns_window.collectionBehavior()
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
    // The new size is not reflected by outer_size() yet, so the title bar is measured beforehand.
    let (outer, inner) = (window.outer_size()?, window.inner_size()?);
    let size = tauri::LogicalSize::new(480.0, 320.0);
    window.set_size(size)?;
    if let Some(monitor) = window.primary_monitor()? {
        let area = monitor.work_area();
        let size = size.to_physical::<u32>(monitor.scale_factor());
        let width = size.width + outer.width - inner.width;
        let height = size.height + outer.height - inner.height;
        let margin = (MARGIN * monitor.scale_factor()).round() as i32;
        window.set_position(tauri::PhysicalPosition::new(
            area.position.x + area.size.width as i32 - width as i32 - margin,
            area.position.y + area.size.height as i32 - height as i32 - margin,
        ))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let store = TokenStore::default();
    let scheme_store = store.clone();
    let builder = tauri::Builder::default();
    // focus:false only affects the window; without this macOS still activates the app on launch
    // and pulls it in front of whatever the person is working in.
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    // The window stays behind other apps, which is where App Nap throttles a process and skews
    // every timing the lab records. The activity is never ended, so it lasts as long as the app.
    // It covers this process only: the WebView's content process is throttled separately when the
    // window is hidden, which place_auto_window avoids.
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
        std::mem::forget(
            NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical,
                &NSString::from_str("tote lab measurements"),
            ),
        );
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .manage(store)
        .setup(|app| {
            if std::env::var_os("TOTE_LAB_AUTO").is_some() {
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                place_auto_window(app)?;
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("tote-file", move |_ctx, request, responder| {
            let store = scheme_store.clone();
            let path = request.uri().path().to_string();
            let range = request
                .headers()
                .get(tauri::http::header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            std::thread::spawn(move || {
                // Logged so the viewer spike can count how many Range requests WebKit actually sent.
                eprintln!("[tote-file] {path} range={range:?}");
                responder.respond(file_scheme::respond(&store, &path, range.as_deref()));
            });
        })
        .invoke_handler(tauri::generate_handler![
            lab_env,
            record_result,
            exit_app,
            ipc_probe,
            issue_file_token
        ])
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
