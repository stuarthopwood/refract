// Win32 Job Object launcher (issue #795, R12a gate-fix round 2, security review HIGH): replaces
// pid-walking process cleanup entirely. Spawns the target exe inside a kill-on-close Job Object,
// so stopping this launcher (closing its stdin, or killing it directly) atomically kills the
// whole process tree the target creates (WebView2, the fake-omp PATH shim and its own node
// child) -- no Win32_Process snapshot, no taskkill of a computed pid, no creation-time
// validation needed, because the OS itself scopes the kill to exactly this job's membership,
// which can never include an unrelated process.
//
// Built the same way as verify-tauri-omp-shim.rs: a bare `rustc --edition 2021` compile, std
// only, raw `extern "system"` declarations for the handful of Win32 Job Object APIs std does not
// expose. Node spawns this launcher directly (scripts/verify-tauri.mjs's own `launchTracked`), so
// the launcher's own pid is held open by Node's own ChildProcess handle for as long as the
// harness cares about it -- it can never be silently reused out from under the harness the way a
// pid discovered later via a process-table snapshot could.
//
// Usage: verify-tauri-launcher.exe <pid-file> <target.exe> [args...]
// Protocol: writes the target's own pid as plain text to `<pid-file>` once it is spawned and
// assigned to the job (polled by the harness -- never multiplexed onto the target's own stdout,
// which this launcher forwards unchanged so the app's own log file stays exactly what it would
// be without this wrapper). Reads its OWN stdin for the shutdown signal: when Node closes it,
// the whole job is terminated immediately. The target's own stdin is never connected to
// anything (it does not need one), so there is no single pipe read by two processes.

use std::env;
use std::ffi::c_void;
use std::fs;
use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::process::{Command, Stdio};

type Handle = *mut c_void;
type Bool = i32;
type Dword = u32;

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x00002000;
// JOBOBJECTINFOCLASS::JobObjectExtendedLimitInformation
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;

#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: Dword,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: Dword,
    affinity: usize,
    priority_class: Dword,
    scheduling_class: Dword,
}

#[repr(C)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(lp_job_attributes: *mut c_void, lp_name: *const u16) -> Handle;
    fn SetInformationJobObject(h_job: Handle, job_object_information_class: i32, lp_job_object_information: *mut c_void, cb_job_object_information_length: Dword) -> Bool;
    fn AssignProcessToJobObject(h_job: Handle, h_process: Handle) -> Bool;
    fn TerminateJobObject(h_job: Handle, u_exit_code: u32) -> Bool;
    fn CloseHandle(h_object: Handle) -> Bool;
}

/// Wraps the raw job handle so it can cross the `std::thread::spawn` boundary: a `HANDLE` is a
/// plain OS-owned integer-like value with no aliasing/lifetime hazard for the single read-only
/// `TerminateJobObject` call the watcher thread makes with it.
struct SendableHandle(Handle);
unsafe impl Send for SendableHandle {}

fn fail(message: &str) -> ! {
    eprintln!("verify-tauri-launcher: {message}");
    std::process::exit(1);
}

fn main() {
    let mut args = env::args().skip(1);
    let pid_file = args.next().unwrap_or_else(|| {
        eprintln!("verify-tauri-launcher: usage: verify-tauri-launcher.exe <pid-file> <target.exe> [args...]");
        std::process::exit(2);
    });
    let target = args.next().unwrap_or_else(|| {
        eprintln!("verify-tauri-launcher: usage: verify-tauri-launcher.exe <pid-file> <target.exe> [args...]");
        std::process::exit(2);
    });
    let rest: Vec<String> = args.collect();

    let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
    if job.is_null() {
        fail("CreateJobObjectW failed");
    }

    let mut info: JobObjectExtendedLimitInformation = unsafe { std::mem::zeroed() };
    info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<JobObjectExtendedLimitInformation>() as Dword,
        )
    };
    if configured == 0 {
        fail("SetInformationJobObject failed");
    }

    // The target's own stdin is never wired to anything: nothing this harness drives needs to
    // send it input, and sharing this launcher's own stdin handle with it would mean two
    // processes racing to read the same pipe (the launcher needs its OWN stdin exclusively, to
    // detect the shutdown signal below). stdout/stderr ARE inherited, so the app's own log
    // output reaches the harness's log file completely unchanged -- the pid protocol below goes
    // through a file, never through this same stream.
    let mut child = Command::new(&target)
        .args(&rest)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|err| fail(&format!("failed to spawn {target}: {err}")));

    // Gate-fix (security review HIGH, round 2): assigned immediately after spawn, before this
    // process does anything else, so the window in which the target could spawn a grandchild not
    // yet covered by the job is as small as physically possible. `std::process::Command::spawn`
    // already does the moral equivalent of a suspended-create-then-resume safely internally; no
    // manual `CREATE_SUSPENDED`/`CreateProcessW` plumbing is needed to get a handle
    // `AssignProcessToJobObject` can use (`AsRawHandle::as_raw_handle()`).
    let child_handle = child.as_raw_handle() as Handle;
    let assigned = unsafe { AssignProcessToJobObject(job, child_handle) };
    if assigned == 0 {
        let _ = child.kill();
        fail("AssignProcessToJobObject failed");
    }

    // Written only now (after the job assignment the harness's own ownership check depends on
    // has actually happened), to a dedicated file -- never multiplexed onto the inherited stdout
    // stream above, which must stay exactly what the app itself would write.
    if fs::write(&pid_file, child.id().to_string()).is_err() {
        let _ = child.kill();
        fail(&format!("failed to write pid file {pid_file}"));
    }

    // Reads this launcher's OWN stdin (a dedicated pipe Node holds, never shared with the
    // target): closing it is the harness's shutdown signal, terminating the whole job tree
    // immediately rather than waiting for the target to exit on its own.
    let job_for_watcher = SendableHandle(job);
    std::thread::spawn(move || {
        let job = job_for_watcher;
        let mut buf = [0u8; 1];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break, // EOF: stdin closed
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        unsafe {
            TerminateJobObject(job.0, 1);
        }
        std::process::exit(1);
    });

    let status = child.wait().unwrap_or_else(|err| fail(&format!("failed to wait for {target}: {err}")));

    unsafe {
        TerminateJobObject(job, 0);
        CloseHandle(job);
    }
    std::process::exit(status.code().unwrap_or(1));
}
