// Win32 Job Object launcher (#795): runs the target exe in a kill-on-close Job Object so closing this
// launcher's stdin (or killing it) kills the whole process tree. The OS scopes the kill to job
// membership, so unlike pid-walking it can never hit an unrelated process.
//
// Usage: verify-tauri-launcher.exe <pid-file> <target.exe> [args...]
// The target's pid goes to `<pid-file>`, never onto stdout, which is forwarded unchanged so the app log stays exact.

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

/// Lets the raw job handle cross `std::thread::spawn`; the watcher only makes one read-only `TerminateJobObject` call.
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

    // Null stdin: sharing ours would race two readers on one pipe; we need it exclusively for the shutdown signal.
    let mut child = Command::new(&target)
        .args(&rest)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|err| fail(&format!("failed to spawn {target}: {err}")));

    // Assign immediately after spawn to minimise the window for a grandchild escaping the job.
    let child_handle = child.as_raw_handle() as Handle;
    let assigned = unsafe { AssignProcessToJobObject(job, child_handle) };
    if assigned == 0 {
        let _ = child.kill();
        fail("AssignProcessToJobObject failed");
    }

    // Written only after job assignment, which the harness's ownership check depends on.
    if fs::write(&pid_file, child.id().to_string()).is_err() {
        let _ = child.kill();
        fail(&format!("failed to write pid file {pid_file}"));
    }

    // Our stdin closing is the harness's shutdown signal: terminate the whole job immediately.
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
