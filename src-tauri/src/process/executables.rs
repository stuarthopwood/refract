// PATH-only `omp` resolution and the fixed `taskkill` path, ported from the relevant parts of
// `src/main/process/executables.ts` (research.md decision 7: `omp` has no VS Code-style
// multi-root install convention to search, so this is a plain PATH lookup, not a port of that
// file's `resolveExecutable`'s full generality or its VS Code/PowerShell resolvers -- neither is
// named by tasks.md T011 or FR-001).
//
// Every spawn in this app must use an absolute path, never a bare executable name: Windows'
// `CreateProcess` search order checks the current directory before `PATH` for a bare name, so a
// worktree that happened to contain e.g. `omp.exe` at its root could otherwise run instead of the
// real one (the same independent security finding `executables.ts`'s own file header documents).
// `which::which_global` walks `PATH` itself (honouring `PATHEXT` on Windows) rather than
// delegating to `CreateProcess`, so it never consults the cwd the way a bare name passed straight
// to `Command::new` would.

use std::env;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex as StdMutex};

/// Resolves `omp` on `PATH`, honouring `PATHEXT`, caching the first successful resolution for the
/// process lifetime (a fresh install replacing the binary mid-run is not a case Refract needs to
/// handle -- mirrors `executables.ts`'s own `cache` Map). The initial value is lazily computed
/// the first time either this or `prime_omp_cache` below touches the cell; both agree on the
/// same `LazyLock`, so there is exactly one cache, not two.
static OMP_CACHE: LazyLock<StdMutex<Result<PathBuf, String>>> = LazyLock::new(|| {
    StdMutex::new(which::which_global("omp").map_err(|_| {
        "Could not resolve \"omp\" on PATH. Install it and make sure it is on PATH, then relaunch Refract."
            .to_string()
    }))
});

/// Returns a clear, user-facing message on failure; callers must not fall back to the bare name
/// `"omp"`.
pub fn resolve_omp() -> Result<PathBuf, String> {
    OMP_CACHE
        .lock()
        .expect("resolve_omp cache mutex poisoned")
        .clone()
}

/// Lane R11b (issue #794): overwrites the cache above with a known-good path, once
/// `updates::dependency_install::install_omp`'s own vendor install script has already exited 0
/// -- this process's in-memory `PATH` does not pick up the script's own `User`-scope
/// `SetEnvironmentVariable` write, so an immediate `readiness.check()` right after a successful
/// Install action would otherwise still report `omp` missing until Refract is relaunched
/// (mirrors `executables.ts`'s own `primeExecutableCache`, ported here rather than invented
/// fresh: `resolve_omp` is this module's only PATH-cached resolver). Never used to fabricate a
/// resolution that was not itself independently verified (`std::fs::try_exists`) to exist first.
pub fn prime_omp_cache(path: PathBuf) {
    *OMP_CACHE.lock().expect("resolve_omp cache mutex poisoned") = Ok(path);
}

/// `%SystemRoot%\System32\taskkill.exe`: a fixed system path, never a PATH/cwd search. Port of
/// `executables.ts`'s `taskkillPath`.
pub fn taskkill_path() -> PathBuf {
    let system_root = env::var("SystemRoot")
        .or_else(|_| env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&system_root)
        .join("System32")
        .join("taskkill.exe")
}

/// `%SystemRoot%\explorer.exe`: a fixed system path, never a PATH/cwd search -- same reasoning
/// this file's own header gives for `resolve_omp`/`taskkill_path` (and `git::git`'s own `which`
/// doc comment): a worktree that happened to contain e.g. `explorer.exe` at its root could
/// otherwise run instead of the real one via Windows' `CreateProcess` cwd-before-PATH search
/// order for a bare name. Used by `ipc::sessions_lifecycle::sessions_reveal_worktree`.
pub fn explorer_exe_path() -> PathBuf {
    let system_root = env::var("SystemRoot")
        .or_else(|_| env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&system_root).join("explorer.exe")
}

/// `%SystemRoot%\System32\tar.exe`: a fixed system path, never a PATH/cwd search -- same
/// reasoning as `taskkill_path`/`explorer_exe_path` above. Windows 10 1803+ and Windows 11 ship
/// a real bsdtar build here that understands `.zip` as well as `.tar`/`.tar.gz`; used by
/// `updates::dependency_install::install_github_cli` to extract the GitHub CLI's official
/// portable zip (research.md decision 6: the portable zip, not the per-machine-only MSI, so the
/// Install action stays no-admin like every other dependency install) without adding a `zip`
/// crate dependency just for this one caller.
pub fn tar_exe_path() -> PathBuf {
    let system_root = env::var("SystemRoot")
        .or_else(|_| env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&system_root).join("System32").join("tar.exe")
}

/// Gate-fixes a LOW security finding: `lib.rs`'s `run()` now sets this env var process-wide as
/// its very first action, before the window, any handler, or any spawn exists -- matching the
/// Electron build's own unconditional top-of-file line (`src/main/index.ts`), so a `git` child
/// spawned before the first `omp` spawn (readiness, `repositories.add`, `sessions.create`) is
/// covered too. This call is therefore now a no-op by the time `OmpProcess::spawn` reaches it
/// (the variable is already set) -- kept, rather than removed, as a second, independent
/// belt-and-braces guard scoped to exactly the one caller (`omp::process`) that actually needs
/// the loader opt-out, in case `run()`'s own call is ever reordered or removed.
pub fn ensure_no_default_cwd_in_exe_path() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Safety: called once, before any thread in this process spawns a child process; no
        // other code path reads or writes this specific variable concurrently.
        unsafe {
            env::set_var("NoDefaultCurrentDirectoryInExePath", "1");
        }
    });
}
