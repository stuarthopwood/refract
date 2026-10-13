// IPC handler for `readiness.check` (contracts/ipc.md "Readiness", tasks.md T017/T020 scope
// note). Ports `src/main/readiness.ts`'s `checkGit`/`checkOmp`/`checkOmpSignedIn` faithfully:
// `checkGit` is one `git --version` call, `checkOmp` resolves `omp` on PATH and runs
// `omp --version`, and `checkOmpSignedIn` spins up a scratch, non-Session `OmpProcess` (temp-dir
// cwd, `--no-session`) purely to confirm the default model from `get_state` also appears in
// `get_available_models` (docs/spike/signed-in-probe.mjs, FINDINGS item 15; contracts/ipc.md
// "ompSignedIn is ok when get_state's current model also appears in get_available_models" -- that
// checks the default model can actually run, not merely that some credential is authenticated).
// Wired here (tasks.md T030 live verification) once `omp::process` (Phase 2(a)) landed: the
// Electron port's own gate-fix comments (issue #512: shared start-queue/memory-defer starvation)
// do not apply -- this build has no start queue or memory defer to starve behind in the first
// place (`omp::process`'s own module header), so only the ready-wait ceiling itself is ported.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::git::git::git_raw;
use crate::omp::process::{ApprovalMode, OmpProcess, OmpProcessOptions};

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

// Gate-fixes Medium finding (issue #512, ported from `readiness.ts`/`loginProviders.ts`): this
// scratch probe used to share the Electron build's process-wide start queue with real Sessions;
// this build has neither a start queue nor a memory defer (`omp::process`'s own module header),
// so only the ready-wait ceiling itself needs a shorter-than-Session bound.
const PROBE_READY_PROMPT_AFTER_MS: u64 = 30_000;
const PROBE_READY_CEILING_MS: u64 = 60_000;
const PROBE_REQUEST_TIMEOUT_MS: u64 = 60_000;

pub fn readiness_check(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (git, omp, omp_signed_in) = tokio::join!(check_git(), check_omp(), check_omp_signed_in());
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

/// Port of `readiness.ts`'s own `checkOmpSignedIn`: spins up a scratch, non-Session `OmpProcess`
/// (temp-dir cwd, `--no-session`) purely to confirm the default model from `get_state` also
/// appears in `get_available_models` (docs/spike/signed-in-probe.mjs, FINDINGS item 15). Never
/// panics on a probe failure: every branch below resolves to a `Check` instead, same as the TS
/// port's own blanket `try`/`catch`.
async fn check_omp_signed_in() -> Check {
    let scratch_dir = std::env::temp_dir().join(format!(
        "refract-readiness-probe-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    ));
    if tokio::fs::create_dir_all(&scratch_dir).await.is_err() {
        return Check { ok: false, hint: Some(SIGNED_IN_HINT.to_string()), ..Default::default() };
    }

    let opts = OmpProcessOptions {
        cwd: scratch_dir.clone(),
        approval_mode: ApprovalMode::Ask,
        omp_path: None,
        no_session: true,
        ready_prompt_after_ms: PROBE_READY_PROMPT_AFTER_MS,
        ready_ceiling_ms: PROBE_READY_CEILING_MS,
    };

    let result = match OmpProcess::spawn(opts).await {
        Ok(proc) => {
            let outcome = probe_signed_in(&proc).await;
            proc.stop().await;
            outcome
        }
        Err(_) => Check { ok: false, hint: Some(SIGNED_IN_HINT.to_string()), ..Default::default() },
    };

    let _ = tokio::fs::remove_dir_all(&scratch_dir).await;
    result
}

/// The `get_state`/`get_available_models` round trip itself, once the scratch process is up.
async fn probe_signed_in(proc: &OmpProcess) -> Check {
    let state_res = match proc.request(serde_json::json!({ "type": "get_state" }), PROBE_REQUEST_TIMEOUT_MS).await {
        Ok(res) => res,
        Err(_) => return Check { ok: false, hint: Some(signed_in_failure_hint(proc).await), ..Default::default() },
    };
    if state_res.get("success").and_then(Value::as_bool) != Some(true) {
        return Check { ok: false, hint: Some(signed_in_failure_hint(proc).await), ..Default::default() };
    }

    let model = state_res.get("data").and_then(|d| d.get("model")).cloned();
    let provider = model.as_ref().and_then(|m| m.get("provider")).and_then(Value::as_str).map(str::to_string);
    let id = model.as_ref().and_then(|m| m.get("id")).and_then(Value::as_str).map(str::to_string);
    let (Some(provider), Some(id)) = (provider, id) else {
        return Check { ok: false, hint: Some(signed_in_failure_hint(proc).await), ..Default::default() };
    };

    let models_res = match proc.request(serde_json::json!({ "type": "get_available_models" }), PROBE_REQUEST_TIMEOUT_MS).await {
        Ok(res) => res,
        Err(_) => return Check { ok: false, hint: Some(signed_in_failure_hint(proc).await), ..Default::default() },
    };
    if models_res.get("success").and_then(Value::as_bool) != Some(true) {
        return Check { ok: false, hint: Some(signed_in_failure_hint(proc).await), ..Default::default() };
    }

    let models_match = models_res
        .get("data")
        .and_then(|d| d.get("models"))
        .and_then(Value::as_array)
        .map(|models| {
            models.iter().any(|m| {
                m.get("provider").and_then(Value::as_str) == Some(provider.as_str())
                    && m.get("id").and_then(Value::as_str) == Some(id.as_str())
            })
        })
        .unwrap_or(false);

    if models_match {
        Check { ok: true, ..Default::default() }
    } else {
        Check { ok: false, hint: Some(signed_in_failure_hint(proc).await), ..Default::default() }
    }
}

/// Port of `readiness.ts`'s own `signedInFailureHint`/`loginProviders.ts`'s own
/// `requestLoginProviders`: enriches `SIGNED_IN_HINT` with up to 3 unauthenticated provider ids,
/// when available, reusing the still-running probe process rather than spinning up a second
/// scratch `omp`. Failures are swallowed since the base hint is already correct without this
/// enrichment.
async fn signed_in_failure_hint(proc: &OmpProcess) -> String {
    let Ok(res) = proc.request(serde_json::json!({ "type": "get_login_providers" }), PROBE_REQUEST_TIMEOUT_MS).await else {
        return SIGNED_IN_HINT.to_string();
    };
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        return SIGNED_IN_HINT.to_string();
    }
    let Some(providers) = res.get("data").and_then(|d| d.get("providers")).and_then(Value::as_array) else {
        return SIGNED_IN_HINT.to_string();
    };
    let unauthenticated: Vec<&str> = providers
        .iter()
        .filter(|p| p.get("authenticated").and_then(Value::as_bool) != Some(true))
        .filter_map(|p| p.get("id").and_then(Value::as_str))
        .take(3)
        .collect();
    if unauthenticated.is_empty() {
        return SIGNED_IN_HINT.to_string();
    }
    format!("Not signed in: {}. {}", unauthenticated.join(", "), SIGNED_IN_HINT)
}
