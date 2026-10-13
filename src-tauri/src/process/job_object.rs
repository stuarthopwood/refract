// Windows-only process containment: joins Refract's own process to a Job Object configured with
// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so every child `omp` process (and its own descendants,
// since Job Object membership is inherited) is force-killed by Windows itself if this process
// dies or is killed, without Refract having to track and clean up every descendant pid --
// ported from `src/main/process/jobObject.ts`'s `joinKillOnCloseJob` (constitution III).
//
// Scaffold stub (plan.md Project Structure): always succeeds without touching the Job Object
// API. A later slice replaces this body with the real `windows-rs` sequence
// (`CreateJobObjectW` -> `SetInformationJobObject` -> `AssignProcessToJobObject`), guarded the
// same way the Electron version is (`cfg!(windows)` / `#[cfg(target_os = "windows")]`), using
// the struct layout and offsets already verified live at `docs/spike/job-object-probe.mjs`.

/// Joins this process to a kill-on-close Job Object. Idempotent once implemented for real (the
/// Electron port caches its result the same way); the scaffold stub has nothing to cache, so it
/// can simply be called once at startup (`main.rs`) before any `omp` child process is spawned.
pub fn join_kill_on_close() -> Result<(), String> {
    Ok(())
}
