// Rust process containment and spawn-path safety: `job_object.rs` ports
// `src/main/process/jobObject.ts`'s kill-on-close Windows Job Object (real `windows-rs`
// implementation); `executables.rs` ports the relevant parts of
// `src/main/process/executables.ts` (PATH-only `omp` resolution, the fixed `taskkill` path,
// the `NoDefaultCurrentDirectoryInExePath` spawn-path safety).
pub mod executables;
pub mod job_object;
pub mod pid_records;
