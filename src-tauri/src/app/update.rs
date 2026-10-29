//! Updates from the GitHub releases (spec 2026-10-25 「앱 안 업데이트」). Rust holds the whole of
//! it: the check, the download and the install go through `tauri-plugin-updater` here, so the
//! page needs no updater permission and its CSP stays shut to github.com. A found update shows as
//! a button in every window (`AppCore::announce_update`); the menu's check also asks in one window
//! (`AppCore::offer_update`). Nothing is downloaded until the person says so in the dialog
//! (`install_update`), and the restart writes every window first (`lifecycle::begin_restart`).

use std::future::Future;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use super::{lock, windows, AppCore, RestartBusy};

/// After launch, so the check never slows the first window down.
pub const STARTUP_DELAY: Duration = Duration::from_secs(5);
/// The plugin waits for good by default; a hung request must not keep a manual check open.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
/// A download that gets no byte for this long has stalled — a half-open connection after sleep or
/// a Wi-Fi change — and fails, so 「다시 시도」 shows where 「받는 중…」 would stay for good. It is
/// per read, not for the whole download (`Update.timeout` would be): a slow connection that keeps
/// sending is never cut, however long the ~12 MB takes. A minute rides out a network change that
/// comes back.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Fails a request that reads nothing for `after`. The updater hands its client builder to this
/// for the check and for the download of what it found.
pub fn stall_limit(client: reqwest::ClientBuilder, after: Duration) -> reqwest::ClientBuilder {
    client.read_timeout(after)
}

/// Debug builds — `pnpm app:dev`, the `tote-dev` bundle, the `perf` profile — check only when
/// asked (`TOTE_UPDATE_CHECK=1`): a smoke run must not reach github.com, and an update would
/// put a release build where the development one was.
pub fn checks_allowed(debug: bool, test_override: bool) -> bool {
    !debug || test_override
}

fn allowed() -> bool {
    checks_allowed(
        cfg!(debug_assertions),
        std::env::var("TOTE_UPDATE_CHECK").is_ok_and(|value| value == "1"),
    )
}

#[derive(Debug, PartialEq, Eq)]
pub enum StartupCheck<U> {
    /// Turned off in the settings: no request was sent.
    Off,
    Found(U),
    None,
    Failed(String),
}

/// The check at launch: waits out `delay`, then reads `wanted` — the setting as it is then, so
/// one turned off meanwhile is kept too — and only then sends `check`.
pub async fn startup_check<C, Fut, U>(
    delay: impl Future<Output = ()>,
    wanted: impl Fn() -> bool,
    check: C,
) -> StartupCheck<U>
where
    C: FnOnce() -> Fut,
    Fut: Future<Output = Result<Option<U>, String>>,
{
    delay.await;
    if !wanted() {
        return StartupCheck::Off;
    }
    match check().await {
        Ok(Some(update)) => StartupCheck::Found(update),
        Ok(None) => StartupCheck::None,
        Err(err) => StartupCheck::Failed(err),
    }
}

/// What the window that asks is told (`PendingOpen::Update`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOffer {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
    pub status: OfferStatus,
}

/// How far this run went with an update when one is offered: the window asks to download it, says
/// another window is downloading it, or asks only to restart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OfferStatus {
    Available,
    Installing,
    Installed,
}

impl UpdateOffer {
    fn of(update: &Update, status: OfferStatus) -> UpdateOffer {
        UpdateOffer {
            version: update.version.clone(),
            current: update.current_version.clone(),
            notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
            status,
        }
    }
}

/// The update found last, and how far its install went. `U` is the plugin's `Update`; the tests
/// stand in a plain value.
pub struct Updates<U = Update> {
    state: Mutex<State<U>>,
}

struct State<U> {
    found: Option<U>,
    installing: bool,
    installed: bool,
    relaunch: bool,
}

impl<U> Default for Updates<U> {
    fn default() -> Self {
        Updates {
            state: Mutex::new(State {
                found: None,
                installing: false,
                installed: false,
                relaunch: false,
            }),
        }
    }
}

impl<U> State<U> {
    fn status(&self) -> OfferStatus {
        if self.installing {
            OfferStatus::Installing
        } else if self.installed {
            OfferStatus::Installed
        } else {
            OfferStatus::Available
        }
    }
}

impl<U: Clone> Updates<U> {
    /// Keeps `update` for `install_update`, and says what to offer: the update kept and how far
    /// it is. Once one is being installed, or installed in this run, that one stays — a newer
    /// find is the restarted version's to find again — so the button and the dialog name the
    /// version this run downloads, not the newer one.
    pub fn found(&self, update: U) -> (U, OfferStatus) {
        let mut state = lock(&self.state);
        let kept = match &state.found {
            Some(kept) if state.installing || state.installed => kept.clone(),
            _ => {
                state.found = Some(update.clone());
                update
            }
        };
        (kept, state.status())
    }

    /// The update kept, and how far it is now — for the button pressed in a window, which may be
    /// pressed after another window began downloading it or installed it.
    pub fn current(&self) -> Option<(U, OfferStatus)> {
        let state = lock(&self.state);
        state.found.clone().map(|update| (update, state.status()))
    }

    /// The update to install now; `None` when one is installed in this run already, so nothing is
    /// downloaded again. `Err` with the code the page is told when there is none or one is being
    /// installed in another window.
    pub fn begin_install(&self) -> Result<Option<U>, &'static str> {
        let mut state = lock(&self.state);
        if state.installing {
            return Err("installing");
        }
        if state.installed {
            return Ok(None);
        }
        let update = state.found.clone().ok_or("no-update")?;
        state.installing = true;
        Ok(Some(update))
    }

    /// The install ended. A failed one keeps the update, so 「다시 시도」 tries it again.
    pub fn end_install(&self, installed: bool) {
        let mut state = lock(&self.state);
        state.installing = false;
        state.installed |= installed;
    }

    /// An update was installed in this run: the next launch is the new version.
    pub fn installed(&self) -> bool {
        lock(&self.state).installed
    }

    /// The restart round wrote every window: once tote is out, `relaunch` starts the new version.
    pub fn relaunch_on_exit(&self) {
        lock(&self.state).relaunch = true;
    }

    pub fn relaunching(&self) -> bool {
        lock(&self.state).relaunch
    }
}

/// What starts the installed version: the bundle's executable, which the update replaced in
/// place under the same name, with no arguments. tauri's own restart hands the new process this
/// launch's arguments, and a launch by the `tote` command carries its request there
/// (`--tote-request`, `cli::front`): the new version would import the file again, or say the
/// standard input it read is gone. Restarted, tote only restores its session. The environment is
/// this one's — `TOTE_DATA_DIR` included — as with tauri's.
pub fn relaunch_command(binary: &Path) -> Command {
    Command::new(binary)
}

/// Called at `RunEvent::Exit`: after the single-instance plugin removed its socket there (its
/// `on_event` runs before the app's), so the new process does not hand its launch to this one
/// and end.
pub fn relaunch(app: &AppHandle) {
    if !app.state::<Updates>().relaunching() {
        return;
    }
    let started = tauri::process::current_binary(&app.env())
        .and_then(|binary| relaunch_command(&binary).spawn());
    if let Err(err) = started {
        // The update is installed all the same: the next launch is the new version.
        eprintln!("tote: could not start the new version: {err}");
    }
}

/// The restart the page asks for after installing: only once an update is installed in this run
/// — a page's mistake must not restart tote for nothing — and only when no other round is open.
pub fn try_restart(
    installed: bool,
    begin: impl FnOnce() -> Result<(), RestartBusy>,
) -> Result<(), &'static str> {
    if !installed {
        return Err("not-installed");
    }
    begin().map_err(|RestartBusy| "busy")
}

/// Sends the check. A failure is said in words for a manual check; the one at launch keeps
/// quiet.
async fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| stall_limit(client, STALL_TIMEOUT))
        .build()
        .map_err(|err| err.to_string())?;
    updater.check().await.map_err(|err| err.to_string())
}

/// Who found an update (`AppCore::found_update`): the check at launch only puts up the button;
/// the menu's check was asked for, so it also asks — in the window it was picked in, if any.
#[derive(Clone, Copy, Debug)]
pub enum Found<'a> {
    AtLaunch,
    Asked { window: Option<&'a str> },
}

/// Keeps `update` and hands it to the windows (`AppCore::found_update`). `false` when no window is
/// open: it waits for the next one.
fn offer(app: &AppHandle, update: Update, found: Found<'_>) -> bool {
    let (kept, status) = app.state::<Updates>().found(update);
    let tell = app
        .state::<AppCore>()
        .found_update(UpdateOffer::of(&kept, status), found);
    for label in &tell {
        let _ = app.emit_to(EventTarget::webview_window(label), "tote://pending", ());
    }
    !tell.is_empty()
}

/// The update kept and how far it is now (`current_update`); `None` before one is found.
pub fn current_offer(app: &AppHandle) -> Option<UpdateOffer> {
    app.state::<Updates>()
        .current()
        .map(|(update, status)| UpdateOffer::of(&update, status))
}

/// The check at launch, unless this build does not check (`checks_allowed`) or the person turned
/// it off. A found update only puts up the button: nobody asked, so no dialog opens. Call once,
/// from `setup`.
pub fn start(app: &AppHandle) {
    if !allowed() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let found = tauri::async_runtime::block_on(startup_check(
            async { std::thread::sleep(STARTUP_DELAY) },
            || app.state::<AppCore>().settings().updates.auto_check,
            || check(&app),
        ));
        match found {
            StartupCheck::Found(update) => {
                offer(&app, update, Found::AtLaunch);
            }
            StartupCheck::Failed(err) => eprintln!("tote: could not check for updates: {err}"),
            StartupCheck::Off | StartupCheck::None => {}
        }
    });
}

/// 「업데이트 확인…」: checks whatever the setting says — the person asked. A found update is
/// offered in `window`, or in a window opened for it when none is (tote in the Dock only); anything
/// else is said in a message box.
pub fn check_now(app: &AppHandle, window: Option<String>) {
    if !allowed() {
        tell(app, "개발 빌드는 업데이트를 확인하지 않습니다.".into());
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match check(&app).await {
            Ok(Some(update)) => {
                // The window opened takes the waiting offer as it registers.
                let window = window.as_deref();
                if !offer(&app, update, Found::Asked { window }) {
                    windows::open_latest(&app);
                }
            }
            Ok(None) => tell(
                &app,
                format!(
                    "Tote Notes {} 이 최신 버전입니다.",
                    app.package_info().version
                ),
            ),
            Err(err) => tell(&app, format!("업데이트를 확인하지 못했습니다: {err}")),
        }
    });
}

fn tell(app: &AppHandle, message: String) {
    app.dialog()
        .message(message)
        .title("업데이트 확인")
        .show(|_| {});
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;

    use super::*;

    #[test]
    fn checks_are_off_in_debug_builds_unless_asked() {
        assert!(checks_allowed(false, false));
        assert!(!checks_allowed(true, false));
        assert!(checks_allowed(true, true));
    }

    #[test]
    fn the_startup_check_reads_the_setting_when_it_runs() {
        // Turned off during the delay: the check that comes after it sends nothing.
        let on = AtomicBool::new(true);
        let calls = Cell::new(0);
        let result = tauri::async_runtime::block_on(startup_check(
            async { on.store(false, Ordering::SeqCst) },
            || on.load(Ordering::SeqCst),
            || async {
                calls.set(calls.get() + 1);
                Ok(Some(1))
            },
        ));
        assert_eq!(result, StartupCheck::Off);
        assert_eq!(calls.get(), 0);

        let check = |answer: Result<Option<u32>, String>| {
            let calls = Cell::new(0);
            let result = tauri::async_runtime::block_on(startup_check(
                async {},
                || true,
                || async {
                    calls.set(calls.get() + 1);
                    answer
                },
            ));
            assert_eq!(calls.get(), 1);
            result
        };
        assert_eq!(check(Ok(Some(7))), StartupCheck::Found(7));
        assert_eq!(check(Ok(None)), StartupCheck::None);
        assert_eq!(
            check(Err("offline".into())),
            StartupCheck::Failed("offline".into())
        );
    }

    #[test]
    fn a_restart_needs_an_installed_update() {
        let begun = Cell::new(0);
        let begin = |result: Result<(), RestartBusy>| {
            || {
                begun.set(begun.get() + 1);
                result
            }
        };
        // Not installed in this run: a page's mistake does not restart tote for nothing.
        assert_eq!(try_restart(false, begin(Ok(()))), Err("not-installed"));
        assert_eq!(begun.get(), 0);
        assert_eq!(try_restart(true, begin(Err(RestartBusy))), Err("busy"));
        assert_eq!(try_restart(true, begin(Ok(()))), Ok(()));
        assert_eq!(begun.get(), 2);
    }

    /// Serves one response of `parts`, with a pause before each, then holds the connection open.
    fn serve(parts: Vec<(Duration, &'static [u8])>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap() == 1 {
                request.push(byte[0]);
            }
            for (pause, bytes) in parts {
                std::thread::sleep(pause);
                if stream.write_all(bytes).is_err() {
                    return;
                }
            }
            std::thread::sleep(Duration::from_secs(30));
        });
        format!("http://{address}/")
    }

    fn download(url: &str, after: Duration) -> Result<Vec<u8>, reqwest::Error> {
        // What the updater does before its first request (`Updater::check`).
        let _ = rustls::crypto::ring::default_provider().install_default();
        tauri::async_runtime::block_on(async {
            let client = stall_limit(reqwest::ClientBuilder::new(), after).build()?;
            Ok(client.get(url).send().await?.bytes().await?.to_vec())
        })
    }

    const HEAD: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n";

    #[test]
    fn a_stalled_download_fails() {
        let url = serve(vec![(Duration::ZERO, HEAD), (Duration::ZERO, b"abc")]);
        let started = Instant::now();
        let err = download(&url, Duration::from_millis(300)).unwrap_err();
        assert!(err.is_timeout(), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_slow_download_that_keeps_coming_is_not_cut() {
        // Longer in all than the limit, but never that long without a byte.
        let step = Duration::from_millis(150);
        let parts = [&b"a"[..], b"b", b"c", b"d", b"e", b"f"];
        let mut body = vec![(Duration::ZERO, HEAD)];
        body.extend(parts.iter().map(|part| (step, *part)));
        let url = serve(body);
        let started = Instant::now();
        assert_eq!(
            download(&url, Duration::from_millis(500)).unwrap(),
            b"abcdef"
        );
        assert!(started.elapsed() > Duration::from_millis(500));
    }

    #[test]
    fn the_new_version_starts_with_no_request() {
        let binary = Path::new("/Applications/tote.app/Contents/MacOS/tote");
        let command = relaunch_command(binary);
        assert_eq!(command.get_program(), binary);
        // Not this launch's arguments: a `--tote-request` there would be handled twice.
        assert_eq!(command.get_args().count(), 0);
    }

    #[test]
    fn a_relaunch_is_asked_for_only_by_the_restart() {
        let updates = Updates::<u32>::default();
        assert!(!updates.relaunching());
        updates.relaunch_on_exit();
        assert!(updates.relaunching());
    }

    #[test]
    fn an_install_runs_once_and_a_failed_one_can_be_retried() {
        let updates = Updates::<u32>::default();
        assert_eq!(updates.begin_install(), Err("no-update"));
        assert_eq!(updates.found(7), (7, OfferStatus::Available));
        assert_eq!(updates.begin_install(), Ok(Some(7)));
        assert_eq!(updates.begin_install(), Err("installing"));
        // A newer find does not replace the one being installed, and is offered as downloading.
        assert_eq!(updates.found(8), (7, OfferStatus::Installing));
        updates.end_install(false);
        assert!(!updates.installed());
        assert_eq!(updates.begin_install(), Ok(Some(7)));
        updates.end_install(true);
        assert!(updates.installed());
    }

    #[test]
    fn an_installed_update_is_not_downloaded_again() {
        let updates = Updates::<u32>::default();
        updates.found(7);
        assert_eq!(updates.begin_install(), Ok(Some(7)));
        updates.end_install(true);
        // The menu's check finds it again (the running version is still the old one): it asks
        // only for the restart, and an install asked for anyway downloads nothing.
        assert_eq!(updates.found(7), (7, OfferStatus::Installed));
        assert_eq!(updates.begin_install(), Ok(None));
        assert!(updates.installed());
    }

    #[test]
    fn a_newer_find_names_the_version_this_run_downloads() {
        // The menu's check finds 8 while 7 downloads in another window, then after 7 is in: the
        // button and the dialog both name 7, which the restart starts.
        let updates = Updates::<u32>::default();
        updates.found(7);
        assert_eq!(updates.begin_install(), Ok(Some(7)));
        assert_eq!(updates.found(8), (7, OfferStatus::Installing));
        assert_eq!(updates.current(), Some((7, OfferStatus::Installing)));
        updates.end_install(true);
        assert_eq!(updates.found(8), (7, OfferStatus::Installed));
        assert_eq!(updates.current(), Some((7, OfferStatus::Installed)));
        // A failed install keeps nothing in: the newer find replaces it.
        let updates = Updates::<u32>::default();
        updates.found(7);
        assert_eq!(updates.begin_install(), Ok(Some(7)));
        updates.end_install(false);
        assert_eq!(updates.found(8), (8, OfferStatus::Available));
    }

    #[test]
    fn the_button_reads_how_far_the_update_is_when_pressed() {
        let updates = Updates::<u32>::default();
        assert_eq!(updates.current(), None);
        updates.found(7);
        assert_eq!(updates.current(), Some((7, OfferStatus::Available)));
        // Another window began downloading it after the button went up.
        assert_eq!(updates.begin_install(), Ok(Some(7)));
        assert_eq!(updates.current(), Some((7, OfferStatus::Installing)));
        updates.end_install(true);
        assert_eq!(updates.current(), Some((7, OfferStatus::Installed)));
    }
}
