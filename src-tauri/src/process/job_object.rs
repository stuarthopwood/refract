// Windows-only process containment: joins Refract's own process to a Job Object configured with
// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so every child `omp` process (and its own descendants,
// since Job Object membership is inherited) is force-killed by Windows itself if this process
// dies or is killed, without Refract having to track and clean up every descendant pid -- ported
// from `src/main/process/jobObject.ts`'s `joinKillOnCloseJob` (constitution III, research.md
// decision 6: `windows-rs`'s own statically-typed bindings, not a `koffi`-style dynamic loader).
//
// Idempotent: the result is cached for the process lifetime, same as the Electron port's own
// `cachedResult`. The job handle itself is kept alive in a second, never-cleared static for the
// same reason the Electron port keeps its own `jobHandle` referenced -- if it were dropped and
// the underlying HANDLE closed, the kill-on-close guarantee would be lost silently.

use std::sync::LazyLock;

static RESULT: LazyLock<Result<(), String>> = LazyLock::new(imp::join);

/// Joins this process to a kill-on-close Job Object (FR-005). Safe to call more than once, and
/// from more than one caller: only the first call does any work, every later call returns the
/// same cached outcome.
pub fn join_kill_on_close() -> Result<(), String> {
    RESULT.clone()
}

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::OnceLock;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    /// `HANDLE` wraps a raw pointer, so it is not `Send`/`Sync` by default; a Job Object handle
    /// is just an opaque kernel reference with no interior state Refract itself touches after
    /// `AssignProcessToJobObject`, so sharing the value (not the kernel object) across threads is
    /// sound. Exists only so `JOB_HANDLE` below can be a `static`.
    // Field never read back; held only to keep the HANDLE alive for the process lifetime.
    #[allow(dead_code)]
    struct HandleHolder(HANDLE);
    // Safety: `HANDLE` is a plain `Copy` kernel-object id; Refract never dereferences the
    // pointer it wraps, only passes it back to Win32 APIs, which are themselves thread-safe for
    // this handle (Job Objects support concurrent use from any thread).
    unsafe impl Send for HandleHolder {}
    unsafe impl Sync for HandleHolder {}

    // Kept alive for the process lifetime: see this module's own file header for why dropping
    // it would silently lose the kill-on-close guarantee.
    static JOB_HANDLE: OnceLock<HandleHolder> = OnceLock::new();

    pub fn join() -> Result<(), String> {
        // Safety: each call below is a single documented Win32 API with no raw pointers beyond
        // what `windows-rs` already type-checks; `info` outlives the `SetInformationJobObject`
        // call that borrows it (a local on this function's own stack), and the `HANDLE` it
        // returns is a plain `Copy` value kept alive for the process lifetime below, never
        // closed (no `CloseHandle` call exists anywhere in this module, matching the Electron
        // port's own "keep it referenced forever" design).
        unsafe {
            let job = CreateJobObjectW(None, PCWSTR::null())
                .map_err(|err| format!("CreateJobObjectW failed: {err}"))?;

            // JOBOBJECT_EXTENDED_LIMIT_INFORMATION.BasicLimitInformation.LimitFlags carries the
            // kill-on-close bit; every other field defaults to zero/unset, same as the Electron
            // port's own zero-filled 144-byte buffer with only offset 16 written.
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|err| format!("SetInformationJobObject failed: {err}"))?;

            let current_process = GetCurrentProcess();
            AssignProcessToJobObject(job, current_process)
                .map_err(|err| format!("AssignProcessToJobObject failed: {err}"))?;

            // Idempotent by construction: `join_kill_on_close`'s own `OnceLock` ensures this
            // function body runs at most once, so `set` can never observe an already-filled cell.
            let _ = JOB_HANDLE.set(HandleHolder(job));
            Ok(())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn join() -> Result<(), String> {
        Err("not windows".to_string())
    }
}
