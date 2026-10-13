// IPC handler for `readiness.check` (contracts/ipc.md "Readiness", tasks.md T017/T020 scope
// note). Ports `src/main/readiness.ts`'s `checkGit`/`checkOmp` faithfully (neither needs a live
// agent: `checkGit` is one `git --version` call, `checkOmp` resolves `omp` on PATH and runs
// `omp --version`). `checkOmpSignedIn` is NOT ported here -- per this slice's own assignment
// ("mirror what it does without a live agent") -- it requires a live, framed `omp` RPC process
// (`OmpProcess`'s `get_state`/`get_available_models` round trip) to confirm the default model
// actually works, which is `omp::process`'s own domain (Phase 2(a), a concurrent sibling slice)
// and not yet wired to a Session-independent scratch probe at all (that wiring is `SessionAgent`/
// `session::manager` territory, Phase 3). Until that lands, `ompSignedIn` always reports
// `{ ok: false, hint: SIGNED_IN_HINT }` -- the same fixed hint the TS probe falls back to when it
// cannot confirm sign-in, never a fabricated `ok: true`.

use serde::Serialize;
use serde_json::Value;

use crate::git::git::git_raw;

use super::{AppState, HandlerFuture};

#[derive(Debug, Serialize, Default)]
struct Check {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    found: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<bool>,
}

/// contracts/ipc.md "Readiness": the fixed hint shown whenever the sign-in probe cannot confirm
/// that OMP's default model is actually usable, whatever the underlying reason.
const SIGNED_IN_HINT: &str = "Run omp, complete /login, then Re-check.";

/// contracts/omp-usage.md's version rule (amended 2026-10-11, spec 014): the minimum supported
/// OMP version is 18.6.3. Only `omp` 18.8.x was directly probed live; any `18.6.3` or later
/// `18.x.y` still passes, but surfaces a warning unless its minor is the specifically re-probed
/// one (18.8.x).
const OMP_MINIMUM_MAJOR: u32 = 18;
const OMP_MINIMUM_MINOR: u32 = 6;
const OMP_MINIMUM_PATCH: u32 = 3;

pub fn readiness_check(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (git, omp) = tokio::join!(check_git(), check_omp());
        let omp_signed_in = Check { ok: false, hint: Some(SIGNED_IN_HINT.to_string()), ..Default::default() };
        let readiness = serde_json::json!({ "git": git, "omp": omp, "ompSignedIn": omp_signed_in });
        Ok(readiness)
    })
}

async fn check_git() -> Check {
    let result = git_raw(&std::env::temp_dir(), &["--version"], None).await;
    if result.code != 0 {
        return Check { ok: false, hint: Some("Git not found on PATH. Install Git for Windows and relaunch Refract.".to_string()), ..Default::default() };
    }
    Check { ok: true, found: Some(result.stdout.trim().to_string()), ..Default::default() }
}

/// Extracts the first `\d+\.\d+\.\d+` run from `stdout` without a `regex` crate dependency (not
/// in this build's `Cargo.toml`): a manual scan for three dot-separated ASCII-digit runs.
fn find_version(stdout: &str) -> Option<(String, u32, u32, u32)> {
    let bytes = stdout.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            let mut parts: Vec<&str> = Vec::new();
            let mut j = i;
            loop {
                let digit_start = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j == digit_start {
                    break;
                }
                parts.push(&stdout[digit_start..j]);
                if parts.len() == 3 || j >= bytes.len() || bytes[j] != b'.' {
                    break;
                }
                j += 1; // skip '.'
            }
            if parts.len() == 3 {
                let found = &stdout[start..j];
                if let (Ok(major), Ok(minor), Ok(patch)) = (parts[0].parse(), parts[1].parse(), parts[2].parse()) {
                    return Some((found.to_string(), major, minor, patch));
                }
            }
        }
        i += 1;
    }
    None
}

async fn check_omp() -> Check {
    let omp_path = match which::which("omp") {
        Ok(path) => path,
        Err(_) => return Check { ok: false, hint: Some("omp not found on PATH. Install omp and relaunch Refract.".to_string()), ..Default::default() },
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = tokio::process::Command::new(&omp_path).arg("--version").creation_flags(CREATE_NO_WINDOW).output().await;
    let stdout = match output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout).into_owned(),
        Ok(output) => {
            return Check {
                ok: false,
                hint: Some(format!("omp --version failed: {}", String::from_utf8_lossy(&output.stderr).trim())),
                ..Default::default()
            }
        }
        Err(err) => return Check { ok: false, hint: Some(format!("omp --version failed: {err}")), ..Default::default() },
    };

    let Some((found, major, minor, patch)) = find_version(&stdout) else {
        let found = stdout.trim().to_string();
        return Check {
            ok: false,
            found: Some(found.clone()),
            hint: Some(format!("Expected omp 18.x, found {found}. Install a supported version and relaunch Refract.")),
            ..Default::default()
        };
    };

    if major != OMP_MINIMUM_MAJOR {
        return Check {
            ok: false,
            found: Some(found.clone()),
            hint: Some(format!("Expected omp 18.x, found {found}. Install a supported version and relaunch Refract.")),
            ..Default::default()
        };
    }

    let below_minimum = minor < OMP_MINIMUM_MINOR || (minor == OMP_MINIMUM_MINOR && patch < OMP_MINIMUM_PATCH);
    if below_minimum {
        return Check {
            ok: false,
            found: Some(found.clone()),
            hint: Some(format!("omp {found} is below the minimum supported version, 18.6.3. Install omp 18.6.3 or newer and relaunch Refract.")),
            ..Default::default()
        };
    }

    if minor == 8 {
        return Check { ok: true, found: Some(found), ..Default::default() };
    }

    Check {
        ok: true,
        found: Some(found.clone()),
        warning: Some(true),
        hint: Some(format!(
            "omp {found} is at or above the minimum supported version (18.6.3) but outside the specifically re-probed 18.8.x range; Refract has not been checked against it individually but is expected to keep working."
        )),
    }
}
