// Rust process containment: ported from `src/main/process/jobObject.ts`'s own kill-on-close
// Windows Job Object. Real Windows API implementation (`windows-rs`'s
// `CreateJobObjectW`/`SetInformationJobObject`/`AssignProcessToJobObject`) is a later slice's
// responsibility (plan.md Project Structure, "process/job_object.rs"); this module currently
// only carries the compiling stub `join_kill_on_close`, so `main.rs` has a real call site to
// join before any `omp` process is ever spawned.
pub mod job_object;
