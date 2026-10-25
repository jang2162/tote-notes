//! Updates from the GitHub releases (spec 2026-10-25 「앱 안 업데이트」). Rust holds the whole of
//! it: the check, the download and the install go through `tauri-plugin-updater` here, so the
//! page needs no updater permission and its CSP stays shut to github.com. A found update is
//! offered to one window (`AppCore::offer_update`); nothing is downloaded until the person says
//! so there (`install_update`), and the restart writes every window first
//! (`lifecycle::begin_restart`).

use std::future::Future;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use super::{lock, AppCore, RestartBusy};

/// After launch, so the check never slows the first window down.
pub const STARTUP_DELAY: Duration = Duration::from_secs(5);
/// The plugin waits for good by default; a hung request must not keep a manual check open.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(15);

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
}

impl UpdateOffer {
    fn of(update: &Update) -> UpdateOffer {
        UpdateOffer {
            version: update.version.clone(),
            current: update.current_version.clone(),
            notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
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

impl<U: Clone> Updates<U> {
    /// Keeps `update` for `install_update`. Not while one is being installed: that one goes on.
    pub fn found(&self, update: U) {
        let mut state = lock(&self.state);
        if !state.installing {
            state.found = Some(update);
        }
    }

    /// The update to install now; `Err` with the code the page is told when there is none or one
    /// is being installed already.
    pub fn begin_install(&self) -> Result<U, &'static str> {
        let mut state = lock(&self.state);
        if state.installing {
            return Err("busy");
        }
        let update = state.found.clone().ok_or("no-update")?;
        state.installing = true;
        Ok(update)
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
        .build()
        .map_err(|err| err.to_string())?;
    updater.check().await.map_err(|err| err.to_string())
}

/// Keeps `update` and offers it to `prefer`, or to the window a found update goes to.
fn offer(app: &AppHandle, update: Update, prefer: Option<&str>) {
    let offer = UpdateOffer::of(&update);
    app.state::<Updates>().found(update);
    if let Some(label) = app.state::<AppCore>().offer_update(offer, prefer) {
        let _ = app.emit_to(EventTarget::webview_window(&label), "tote://pending", ());
    }
}

/// The check at launch, unless this build does not check (`checks_allowed`) or the person turned
/// it off. Call once, from `setup`.
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
            StartupCheck::Found(update) => offer(&app, update, None),
            StartupCheck::Failed(err) => eprintln!("tote: could not check for updates: {err}"),
            StartupCheck::Off | StartupCheck::None => {}
        }
    });
}

/// 「업데이트 확인…」: checks whatever the setting says — the person asked. A found update is
/// offered in `window`; anything else is said in a message box.
pub fn check_now(app: &AppHandle, window: Option<String>) {
    if !allowed() {
        tell(app, "개발 빌드는 업데이트를 확인하지 않습니다.".into());
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match check(&app).await {
            Ok(Some(update)) => offer(&app, update, window.as_deref()),
            Ok(None) => tell(
                &app,
                format!("tote {} 이 최신 버전입니다.", app.package_info().version),
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
    use std::sync::atomic::{AtomicBool, Ordering};

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
        updates.found(7);
        assert_eq!(updates.begin_install(), Ok(7));
        assert_eq!(updates.begin_install(), Err("busy"));
        // A newer find does not replace the one being installed.
        updates.found(8);
        updates.end_install(false);
        assert!(!updates.installed());
        assert_eq!(updates.begin_install(), Ok(7));
        updates.end_install(true);
        assert!(updates.installed());
    }
}
