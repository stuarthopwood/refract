// Process containment (kill-on-close Windows Job Object) and spawn-path safety (PATH-only `omp`
// resolution, fixed `taskkill` path, `NoDefaultCurrentDirectoryInExePath`).
pub mod executables;
pub mod job_object;
pub mod pid_records;
