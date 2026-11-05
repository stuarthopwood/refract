// Windows alarm toast (#1666): the plugin's string API cannot request the alarm scenario or a looping sound.
use tauri_winrt_notification::{LoopableSound, Scenario, Sound, Toast};

/// Builds the alarm toast: it stays up until dismissed and, when `sound` is on, loops `Looping.Alarm`.
pub fn build(app_id: &str, body: &str, sound: bool) -> Toast {
    let audio = sound.then_some(Sound::Loop(LoopableSound::Alarm));
    Toast::new(app_id)
        .title("Refract alarm")
        .text1(body)
        .scenario(Scenario::Alarm)
        .sound(audio)
}

/// Mirrors the plugin's choice: the PowerShell id for cargo-run builds, otherwise the app identifier.
pub fn app_id(identifier: &str) -> String {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.display().to_string()));
    match exe_dir {
        Some(dir) if dir.ends_with("\\target\\debug") || dir.ends_with("\\target\\release") => {
            Toast::POWERSHELL_APP_ID.to_string()
        }
        _ => identifier.to_string(),
    }
}
