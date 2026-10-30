// Hides the console window in release builds only; dev builds keep stdout for logging.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must run before any `omp` child is spawned so it dies with the app.
    if let Err(err) = refract_tauri_lib::process::job_object::join_kill_on_close() {
        eprintln!("refract-tauri: failed to join kill-on-close Job Object: {err}");
    }

    refract_tauri_lib::run();
}
