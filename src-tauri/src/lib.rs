pub mod app;
pub mod appdata;
pub mod cli;
pub mod persist;
pub mod session;
pub mod workspace;

use tauri::{Manager, RunEvent};

use app::{commands, menu, requests, windows, AppCore};
use cli::CliRequest;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // A smoke check run by an agent must not activate tote over the person's work.
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(!windows::background());
    let app = builder
        // The first plugin: a second launch — the `tote` command — hands its request to the
        // running app here and exits. It finds that app by identifier, which is why development
        // runs use their own (src-tauri/tauri.dev.conf.json).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            requests::handle(app, CliRequest::find_in(&argv).unwrap_or_default());
        }))
        .plugin(tauri_plugin_dialog::init())
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .on_window_event(windows::on_event)
        .setup(|app| {
            app.manage(AppCore::load()?);
            windows::restore(app.handle(), CliRequest::find_in(std::env::args()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_info,
            commands::list_memos,
            commands::create_memo,
            commands::read_memo,
            commands::write_memo,
            commands::retitle_memo,
            commands::rename_memo,
            commands::delete_memo,
            commands::import_memo,
            commands::import_file,
            commands::read_session,
            commands::write_session,
            commands::take_pending_opens,
            commands::open_external,
            commands::read_external,
            commands::read_external_draft,
            commands::keep_external_draft,
            commands::discard_external_draft,
            commands::save_external,
            commands::list_workspaces,
            commands::create_workspace,
            commands::open_workspace,
            commands::flush_done,
            commands::close_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tote");
    app.run(|app, event| match event {
        // The last window closed: stay in the Dock like other Mac apps; ⌘Q quits.
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => windows::open_latest(app),
        _ => {}
    });
}
