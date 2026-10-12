// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The clock of the performance marks (src/perf.rs) starts here, before anything else runs.
    tote_lib::perf::start();
    // The `tote` script runs this binary with TOTE_CLI=1: check the arguments, hand them to the
    // app and exit, instead of starting a second app.
    if let Some(code) = tote_lib::cli::front::run_if_cli() {
        std::process::exit(code);
    }
    tote_lib::perf::mark("process-start");
    tote_lib::run()
}
