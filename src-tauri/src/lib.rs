pub mod app;
pub mod appdata;
pub mod backup;
pub mod cli;
pub mod extensions;
pub mod files;
pub mod perf;
pub mod persist;
pub mod search;
pub mod session;
pub mod shortcuts;
pub mod watch;
pub mod workspace;

use std::collections::HashSet;
use std::io;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Emitter, EventTarget, Manager, RunEvent};

use app::{commands, menu, requests, windows, AppCore, PendingOpen};
use backup::notices::FailureNotices;
use backup::SnapshotName;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(<app::update::Updates>::default())
        .manage(requests::EarlyOpens::default())
        .register_asynchronous_uri_scheme_protocol("tote-file", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let method = request.method().clone();
            let path = request.uri().path().to_string();
            let range = request
                .headers()
                .get(tauri::http::header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            // Off the main thread: a 206 for a video seek reads from disk.
            files::pool::spawn(move || {
                let core = app.state::<AppCore>();
                responder.respond(files::range::respond(
                    &core.files,
                    &method,
                    &path,
                    range.as_deref(),
                ));
            });
        })
        .register_uri_scheme_protocol("tote-ext", |ctx, request| {
            let registry = ctx.app_handle().state::<AppCore>().registry();
            extensions::serve::respond(&registry, request.uri().path())
        })
        .manage(menu::TabMenu::default())
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .on_window_event(windows::on_event)
        .on_page_load(windows::on_page_load)
        .setup(|app| {
            app.manage(AppCore::load(
                app.path().resource_dir()?.join("extensions"),
            )?);
            // The menu was built before the settings were read, with the default shortcuts. On
            // the main thread this runs at once, before any window opens.
            menu::follow_settings(app.handle());
            perf::mark("core-loaded");
            #[cfg(target_os = "macos")]
            app::lifecycle::hook_system_quit(app.handle());
            start_watching(app.handle().clone());
            windows::restore(app.handle(), CliRequest::find_in(std::env::args()));
            requests::opened_after_setup(app.handle());
            start_backups(app.handle().clone());
            app::update::start(app.handle());
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
            commands::set_memo_language,
            commands::delete_memo,
            commands::import_memo,
            commands::import_file,
            commands::read_window_layout,
            commands::write_window_layout,
            commands::claim_tabs,
            commands::release_tab,
            commands::tear_off_tab,
            commands::show_tab_menu,
            commands::take_pending_opens,
            commands::open_external,
            commands::read_external,
            commands::read_external_draft,
            commands::keep_external_draft,
            commands::discard_external_draft,
            commands::save_external,
            commands::watch_external,
            commands::unwatch_external,
            commands::list_workspaces,
            commands::create_workspace,
            commands::switch_workspace,
            commands::relocate_workspace,
            commands::open_workspace,
            commands::flush_done,
            commands::current_update,
            commands::install_update,
            commands::restart_for_update,
            commands::close_window,
            commands::extension_registry,
            commands::read_extension_file,
            commands::install_extension,
            commands::remove_extension,
            commands::set_extension_enabled,
            commands::get_settings,
            commands::workspace_roots,
            commands::patch_settings,
            commands::shortcut_table,
            commands::suspend_shortcuts,
            commands::run_menu_command,
            commands::issue_file_token,
            commands::revoke_file_tokens,
            commands::resolve_relative,
            commands::scan_text,
            commands::search_text,
            commands::cancel_text_search,
            commands::search_workspace,
            commands::cancel_workspace_search,
            commands::list_versions,
            commands::read_version,
            commands::reveal_backups,
            commands::perf_mark,
            commands::perf_config,
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
        // Finder's 「다음으로 열기」, tote as a file's default app, `open -a`: launched by the
        // file or already running, macOS hands the files over here, not in argv.
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => requests::opened(app, urls),
        RunEvent::Exit => app::update::relaunch(app),
        _ => {}
    });
}

/// Outside changes go to the windows they concern as `tote://outside`: a workspace's to every
/// window showing it. Before any window opens, so every workspace is watched; without a watcher
/// tote still works, it only misses those changes.
fn start_watching(app: AppHandle) {
    let handle = app.clone();
    let watching = app.state::<AppCore>().start_watching(move |target, batch| {
        let core = handle.state::<AppCore>();
        // How long a batch keeps the workspace locked, which a save waits out (tests/measure/perf.md).
        perf::mark("watch-batch-start");
        let outside = core.on_batch(target, batch);
        perf::mark("watch-batch-done");
        for (label, change) in outside {
            let _ = handle.emit_to(
                EventTarget::webview_window(&label),
                "tote://outside",
                change,
            );
        }
    });
    if let Err(err) = watching {
        eprintln!("tote: cannot watch for outside changes: {err}");
    }
}

/// Backup rounds on a thread of their own (spec 「백업」): one right away, for the workspaces the
/// start-up restore has already opened, then one every interval, and one for a workspace as its
/// first window opens (`AppCore::request_backup`). None at quit, which must stay quick. A
/// workspace is snapshotted once however many windows show it; a failure is told to each of them.
///
/// One thread takes every snapshot, in turn: `remove_leftovers` would delete the `.tmp-*` of a
/// snapshot another thread is still building.
fn start_backups(app: AppHandle) {
    let interval = backup_interval();
    let (waker, woken) = mpsc::channel();
    app.state::<AppCore>().set_backup_waker(waker);
    std::thread::spawn(move || {
        // A failing window is told once, then again a day later if it keeps failing; every round
        // retries quietly meanwhile.
        let mut notices = FailureNotices::new();
        let mut deadline = Instant::now();
        loop {
            let periodic = Instant::now() >= deadline;
            let only = if periodic {
                None
            } else {
                match woken.recv_timeout(deadline - Instant::now()) {
                    Ok(label) => {
                        let mut labels = HashSet::from([label]);
                        labels.extend(woken.try_iter());
                        Some(labels)
                    }
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            };
            let core = app.state::<AppCore>();
            notices.retain_open(&core.window_labels());
            // A window opened since the last round is new even if its label was open before.
            for label in only.iter().flatten() {
                notices.opened(label);
            }
            for (labels, result) in core.backup_tick(SnapshotName::now(), only.as_ref()) {
                match result {
                    Ok(_) => labels.iter().for_each(|label| notices.succeeded(label)),
                    // The same name again (the same second, or a repeated daylight-saving hour):
                    // the next round takes it under a new one.
                    Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(err) => {
                        eprintln!("tote: backup of {} failed: {err}", labels.join(", "));
                        let now = SystemTime::now();
                        for label in labels.iter().filter(|label| notices.failed(label, now)) {
                            core.push_pending(
                                label,
                                PendingOpen::Notice {
                                    message: format!("백업하지 못했습니다: {err}"),
                                },
                            );
                            let _ = app.emit_to(
                                EventTarget::webview_window(label),
                                "tote://pending",
                                (),
                            );
                        }
                    }
                }
            }
            if periodic {
                // After a long round, count one interval from now.
                deadline = Instant::now() + interval;
            }
        }
    });
}

/// `backup::INTERVAL`; debug builds take `TOTE_BACKUP_INTERVAL_SECS` instead, so an agent's smoke
/// check need not wait ten minutes.
fn backup_interval() -> Duration {
    let secs = std::env::var("TOTE_BACKUP_INTERVAL_SECS")
        .ok()
        .and_then(|secs| secs.parse::<u64>().ok())
        .filter(|&secs| cfg!(debug_assertions) && secs > 0);
    secs.map_or(backup::INTERVAL, Duration::from_secs)
}
