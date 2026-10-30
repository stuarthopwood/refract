// PATH-only `omp` resolution and fixed system executable paths.
// Spawns must use absolute paths: `CreateProcess` checks the cwd before `PATH` for a bare name, so a
// worktree containing `omp.exe` could run instead of the real one. `which_global` never consults the cwd.

use std::env;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex as StdMutex};

/// Resolves `omp` on `PATH` once and caches it for the process lifetime.
// `prime_omp_cache` shares this cell, so there is exactly one cache.
static OMP_CACHE: LazyLock<StdMutex<Result<PathBuf, String>>> = LazyLock::new(|| {
    StdMutex::new(which::which_global("omp").map_err(|_| {
        "Could not resolve \"omp\" on PATH. Install it and make sure it is on PATH, then relaunch Refract."
            .to_string()
    }))
});

/// Returns a user-facing message on failure; callers must not fall back to the bare name `"omp"`.
pub fn resolve_omp() -> Result<PathBuf, String> {
    OMP_CACHE
        .lock()
        .expect("resolve_omp cache mutex poisoned")
        .clone()
}

/// Overwrites the cache with a verified path after a successful omp install (#794).
// The install script's `User`-scope PATH write is not visible to this process until relaunch.
pub fn prime_omp_cache(path: PathBuf) {
    *OMP_CACHE.lock().expect("resolve_omp cache mutex poisoned") = Ok(path);
}

/// `%SystemRoot%\System32\taskkill.exe`: a fixed system path, never a PATH/cwd search.
pub fn taskkill_path() -> PathBuf {
    let system_root = env::var("SystemRoot")
        .or_else(|_| env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&system_root)
        .join("System32")
        .join("taskkill.exe")
}

/// `%SystemRoot%\explorer.exe`: a fixed system path, never a PATH/cwd search.
pub fn explorer_exe_path() -> PathBuf {
    let system_root = env::var("SystemRoot")
        .or_else(|_| env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&system_root).join("explorer.exe")
}

/// `%SystemRoot%\System32\tar.exe`: a fixed system path, never a PATH/cwd search.
// Its bsdtar extracts `.zip`, so the GitHub CLI portable zip needs no `zip` crate.
pub fn tar_exe_path() -> PathBuf {
    let system_root = env::var("SystemRoot")
        .or_else(|_| env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&system_root).join("System32").join("tar.exe")
}

/// Opts the `omp` loader out of the cwd in the exe search path.
// `run()` already sets this first; this repeats it as a guard in case that call is reordered.
pub fn ensure_no_default_cwd_in_exe_path() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Safety: runs before any child process spawns; nothing else touches this variable.
        unsafe {
            env::set_var("NoDefaultCurrentDirectoryInExePath", "1");
        }
    });
}
