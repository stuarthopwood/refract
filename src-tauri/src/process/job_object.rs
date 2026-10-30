// Windows-only: joins this process to a kill-on-close Job Object so child `omp` processes die with it.
// The job handle is kept in a static; closing it would silently lose that guarantee.

use std::sync::LazyLock;

static RESULT: LazyLock<Result<(), String>> = LazyLock::new(imp::join);

/// Joins this process to a kill-on-close Job Object; idempotent, later calls return the cached outcome.
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

    // `HANDLE` wraps a raw pointer so is not `Send`/`Sync`; this only lets `JOB_HANDLE` be a `static`.
    // Field never read back; held only to keep the HANDLE alive for the process lifetime.
    #[allow(dead_code)]
    struct HandleHolder(HANDLE);
    // Safety: the handle is an opaque kernel id, never dereferenced, and Job Objects are thread-safe.
    unsafe impl Send for HandleHolder {}
    unsafe impl Sync for HandleHolder {}

    // Kept for the process lifetime; dropping it would lose the kill-on-close guarantee.
    static JOB_HANDLE: OnceLock<HandleHolder> = OnceLock::new();

    pub fn join() -> Result<(), String> {
        // Safety: single documented Win32 calls; `info` outlives the call borrowing it, and the
        // `HANDLE` is stored in `JOB_HANDLE` and never closed.
        unsafe {
            let job = CreateJobObjectW(None, PCWSTR::null())
                .map_err(|err| format!("CreateJobObjectW failed: {err}"))?;

            // Only the kill-on-close flag is set; every other field stays zeroed.
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

            // The enclosing `OnceLock` runs this at most once, so `set` cannot fail.
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
