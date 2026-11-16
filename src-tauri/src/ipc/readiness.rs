// IPC handler for `readiness.check`: git, omp on PATH, and a scratch-process probe that the
// default model from `get_state` also appears in `get_available_models` (usable, not merely authed).
// No start queue or memory defer exists in this build, so only the ready-wait ceiling is bounded.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::git::git::git_raw;
use crate::omp::process::{ApprovalMode, OmpProcess, OmpProcessOptions};
use crate::updates::dependency_install::{self, Dependency, DependencyInstallProgress};
use crate::updates::gh_client::{self, GithubCliStatus};

use super::{AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("readiness.check", readiness_check);
    d.register("readiness.checkStep", readiness_check_step);
    d.register("readiness.installDependency", readiness_install_dependency);
}

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

/// The fixed hint shown whenever the sign-in probe cannot confirm OMP's default model is usable.
const SIGNED_IN_HINT: &str = "Run omp, complete /login, then Re-check.";

/// Minimum supported OMP is 18.6.3; 18.x up to the tested line passes, newer minors warn.
const OMP_MINIMUM_MAJOR: u32 = 18;
const OMP_MINIMUM_MINOR: u32 = 6;
const OMP_MINIMUM_PATCH: u32 = 3;
/// Newest OMP minor Refract has been reviewed against (#689); bump it with each review.
const OMP_TESTED_MINOR: u32 = 17;

// The scratch probe needs a shorter ready-wait bound than real Sessions (#512).
const PROBE_READY_PROMPT_AFTER_MS: u64 = 30_000;
const PROBE_READY_CEILING_MS: u64 = 60_000;
const PROBE_REQUEST_TIMEOUT_MS: u64 = 60_000;
/// Whole sign-in step (spawn plus every request): a wedged scratch omp must end the step as
/// Failed rather than leave the loading page spinning for the sum of the per-request bounds.
const SIGNED_IN_STEP_BOUND_MS: u64 = 90_000;

/// `omp --version` and `git --version` are bounded: a hung PATH-resolved binary must not hang
/// `readiness.check` or stall a loading-page step.
const OMP_VERSION_PROBE_TIMEOUT_MS: u64 = 10_000;
pub fn readiness_check(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { Ok(compute_readiness().await) })
}

/// The launch checks in the order the loading page runs them; keys match `Readiness` fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Git,
    Omp,
    OmpSignedIn,
}

impl Step {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "git" => Some(Self::Git),
            "omp" => Some(Self::Omp),
            "ompSignedIn" => Some(Self::OmpSignedIn),
            _ => None,
        }
    }
}

/// Reads the single step-key argument of `readiness.checkStep`.
fn step_from_args(args: &[Value]) -> Result<Step, IpcError> {
    args.first()
        .and_then(Value::as_str)
        .and_then(Step::parse)
        .ok_or_else(|| {
            IpcError::new(
                "invalid-argument",
                "readiness.checkStep expects one of 'git' | 'omp' | 'ompSignedIn'",
            )
        })
}

/// Runs one check so the loading page can show the three steps one at a time and stop at the
/// first failure; resolves to a bare `Check` (same shape as a `readiness.check` field).
fn readiness_check_step(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let step = step_from_args(&args)?;
        let check = match step {
            Step::Git => check_git().await,
            Step::Omp => check_omp().await,
            Step::OmpSignedIn => check_omp_signed_in().await,
        };
        Ok(serde_json::json!(check))
    })
}

/// Shared by the `readiness.check` handler and the post-install re-check.
async fn compute_readiness() -> Value {
    let (git, omp, omp_signed_in, github) = tokio::join!(
        check_git(),
        check_omp(),
        check_omp_signed_in(),
        check_github_cli()
    );
    serde_json::json!({ "git": git, "omp": omp, "ompSignedIn": omp_signed_in, "github": github })
}

async fn check_git() -> Check {
    let result = git_raw(
        &std::env::temp_dir(),
        &["--version"],
        Some(Duration::from_millis(OMP_VERSION_PROBE_TIMEOUT_MS)),
    )
    .await;
    if result.code != 0 {
        return Check {
            ok: false,
            hint: Some(
                "Git not found on PATH. Install Git for Windows and relaunch Refract.".to_string(),
            ),
            ..Default::default()
        };
    }
    Check {
        ok: true,
        found: Some(result.stdout.trim().to_string()),
        ..Default::default()
    }
}

/// Extracts the first `\d+\.\d+\.\d+` run from `stdout` by manual scan (no `regex` dependency).
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
                if let (Ok(major), Ok(minor), Ok(patch)) =
                    (parts[0].parse(), parts[1].parse(), parts[2].parse())
                {
                    return Some((found.to_string(), major, minor, patch));
                }
            }
        }
        i += 1;
    }
    None
}

async fn check_omp() -> Check {
    let omp_path = match which::which_global("omp") {
        Ok(path) => path,
        Err(_) => {
            return Check {
                ok: false,
                hint: Some("omp not found on PATH. Install omp and relaunch Refract.".to_string()),
                ..Default::default()
            }
        }
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = tokio::process::Command::new(&omp_path);
    command.arg("--version").creation_flags(CREATE_NO_WINDOW);
    // A timed-out probe is dropped, not awaited; `kill_on_drop` stops it running on as an orphan.
    command.kill_on_drop(true);
    let output = match tokio::time::timeout(
        Duration::from_millis(OMP_VERSION_PROBE_TIMEOUT_MS),
        command.output(),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            return Check {
                ok: false,
                hint: Some("omp --version timed out.".to_string()),
                ..Default::default()
            }
        }
    };
    let stdout = match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
        Ok(output) => {
            return Check {
                ok: false,
                hint: Some(format!(
                    "omp --version failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )),
                ..Default::default()
            }
        }
        Err(err) => {
            return Check {
                ok: false,
                hint: Some(format!("omp --version failed: {err}")),
                ..Default::default()
            }
        }
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

    let below_minimum =
        minor < OMP_MINIMUM_MINOR || (minor == OMP_MINIMUM_MINOR && patch < OMP_MINIMUM_PATCH);
    if below_minimum {
        return Check {
            ok: false,
            found: Some(found.clone()),
            hint: Some(format!("omp {found} is below the minimum supported version, 18.6.3. Install omp 18.6.3 or newer and relaunch Refract.")),
            ..Default::default()
        };
    }

    if minor <= OMP_TESTED_MINOR {
        return Check {
            ok: true,
            found: Some(found),
            ..Default::default()
        };
    }

    Check {
        ok: true,
        found: Some(found.clone()),
        warning: Some(true),
        hint: Some(format!(
            "omp {found} is newer than 18.{OMP_TESTED_MINOR}.x, the newest version Refract has been checked against. It is expected to keep working."
        )),
    }
}

/// Spins up a scratch, non-Session `OmpProcess` to confirm the default model is available.
/// Never panics: every probe failure resolves to a `Check`.
async fn check_omp_signed_in() -> Check {
    let scratch_dir = std::env::temp_dir().join(format!(
        "refract-readiness-probe-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    if tokio::fs::create_dir_all(&scratch_dir).await.is_err() {
        return Check {
            ok: false,
            hint: Some(SIGNED_IN_HINT.to_string()),
            ..Default::default()
        };
    }

    let opts = OmpProcessOptions {
        cwd: scratch_dir.clone(),
        approval_mode: ApprovalMode::Ask,
        omp_path: None,
        no_session: true,
        plan_mode: None,
        extra_config: None,
        stacked_prs: false,
        ready_prompt_after_ms: PROBE_READY_PROMPT_AFTER_MS,
        ready_ceiling_ms: PROBE_READY_CEILING_MS,
    };

    let deadline = tokio::time::Instant::now() + Duration::from_millis(SIGNED_IN_STEP_BOUND_MS);
    let result = match OmpProcess::spawn(opts).await {
        Ok(proc) => {
            let outcome = match tokio::time::timeout_at(deadline, probe_signed_in(&proc)).await {
                Ok(outcome) => outcome,
                Err(_) => Check {
                    ok: false,
                    hint: Some(format!("The sign-in check timed out. {SIGNED_IN_HINT}")),
                    ..Default::default()
                },
            };
            proc.stop().await;
            outcome
        }
        Err(_) => Check {
            ok: false,
            hint: Some(SIGNED_IN_HINT.to_string()),
            ..Default::default()
        },
    };

    let _ = tokio::fs::remove_dir_all(&scratch_dir).await;
    result
}

/// The `get_state`/`get_available_models` round trip itself, once the scratch process is up.
async fn probe_signed_in(proc: &OmpProcess) -> Check {
    let state_res = match proc
        .request(
            serde_json::json!({ "type": "get_state" }),
            PROBE_REQUEST_TIMEOUT_MS,
        )
        .await
    {
        Ok(res) => res,
        Err(_) => {
            return Check {
                ok: false,
                hint: Some(signed_in_failure_hint(proc).await),
                ..Default::default()
            }
        }
    };
    if state_res.get("success").and_then(Value::as_bool) != Some(true) {
        return Check {
            ok: false,
            hint: Some(signed_in_failure_hint(proc).await),
            ..Default::default()
        };
    }

    let model = state_res.get("data").and_then(|d| d.get("model")).cloned();
    let provider = model
        .as_ref()
        .and_then(|m| m.get("provider"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let id = model
        .as_ref()
        .and_then(|m| m.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let (Some(provider), Some(id)) = (provider, id) else {
        return Check {
            ok: false,
            hint: Some(signed_in_failure_hint(proc).await),
            ..Default::default()
        };
    };

    let models_res = match proc
        .request(
            serde_json::json!({ "type": "get_available_models" }),
            PROBE_REQUEST_TIMEOUT_MS,
        )
        .await
    {
        Ok(res) => res,
        Err(_) => {
            return Check {
                ok: false,
                hint: Some(signed_in_failure_hint(proc).await),
                ..Default::default()
            }
        }
    };
    if models_res.get("success").and_then(Value::as_bool) != Some(true) {
        return Check {
            ok: false,
            hint: Some(signed_in_failure_hint(proc).await),
            ..Default::default()
        };
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
        Check {
            ok: true,
            ..Default::default()
        }
    } else {
        Check {
            ok: false,
            hint: Some(signed_in_failure_hint(proc).await),
            ..Default::default()
        }
    }
}

/// Enriches `SIGNED_IN_HINT` with up to 3 unauthenticated provider ids, reusing the probe
/// process. Failures are swallowed: the base hint is already correct.
async fn signed_in_failure_hint(proc: &OmpProcess) -> String {
    let Ok(res) = proc
        .request(
            serde_json::json!({ "type": "get_login_providers" }),
            PROBE_REQUEST_TIMEOUT_MS,
        )
        .await
    else {
        return SIGNED_IN_HINT.to_string();
    };
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        return SIGNED_IN_HINT.to_string();
    }
    let Some(providers) = res
        .get("data")
        .and_then(|d| d.get("providers"))
        .and_then(Value::as_array)
    else {
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
    format!(
        "Not signed in: {}. {}",
        unauthenticated.join(", "),
        SIGNED_IN_HINT
    )
}

/// `gh --version` resolves on PATH and `gh auth status` is signed in; never required for `allPass`
/// (a missing `gh` only blocks updates and pull-request access).
async fn check_github_cli() -> Check {
    match gh_client::github_cli_status(&std::env::temp_dir()).await {
        GithubCliStatus::Ok => Check {
            ok: true,
            ..Default::default()
        },
        GithubCliStatus::NotInstalled => Check {
            ok: false,
            hint: Some(
                "The GitHub CLI (gh) is not installed. Use Install, or install it yourself and choose Re-check. Optional -- only needed for updates and pull request access."
                    .to_string(),
            ),
            ..Default::default()
        },
        GithubCliStatus::NotSignedIn => Check {
            ok: false,
            // A portable-zip-installed `gh` may not be on the user's terminal PATH; point at
            // Refract's own sign-in flow, which drives this exact binary.
            hint: Some(
                "gh is installed but not signed in. Sign in via Manage accounts, then Re-check."
                    .to_string(),
            ),
            ..Default::default()
        },
        GithubCliStatus::Offline => Check {
            ok: false,
            hint: Some("gh could not reach GitHub. Check your network connection, then Re-check.".to_string()),
            ..Default::default()
        },
    }
}

/// Runs `dependency`'s vendor installer and resolves when done (progress on
/// `readiness:install-progress`), then re-runs the check and emits `readiness:changed`.
/// Always resolves, reporting `dependency-install-failed` on failure.
fn readiness_install_dependency(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(raw) = args.first().and_then(Value::as_str) else {
            return Err(IpcError::new(
                "invalid-argument",
                "readiness.installDependency expects one of 'git' | 'omp' | 'github-cli'",
            ));
        };
        let dependency = match raw {
            "git" => Dependency::Git,
            "omp" => Dependency::Omp,
            "github-cli" => Dependency::GithubCli,
            _ => {
                return Err(IpcError::new(
                    "invalid-argument",
                    "readiness.installDependency expects one of 'git' | 'omp' | 'github-cli'",
                ))
            }
        };

        // A second call for a dependency already installing returns a busy error rather than
        // starting a concurrent install and download.
        static IN_FLIGHT: LazyLock<StdMutex<HashSet<String>>> =
            LazyLock::new(|| StdMutex::new(HashSet::new()));
        let key = raw.to_string();
        {
            let mut in_flight = IN_FLIGHT.lock().expect("in-flight set mutex poisoned");
            if !in_flight.insert(key.clone()) {
                return Err(IpcError::new(
                    "not-idle",
                    format!("An install for '{raw}' is already running."),
                ));
            }
        }

        let session_manager = state.session_manager.clone();
        let on_progress = move |progress: DependencyInstallProgress| {
            let value = serde_json::to_value(progress)
                .expect("DependencyInstallProgress is always JSON-serialisable");
            session_manager.emit_readiness_install_progress(&value);
        };

        let result = match dependency {
            Dependency::Git => dependency_install::install_git(on_progress).await,
            Dependency::Omp => dependency_install::install_omp(on_progress).await,
            Dependency::GithubCli => dependency_install::install_github_cli(on_progress).await,
        };

        IN_FLIGHT
            .lock()
            .expect("in-flight set mutex poisoned")
            .remove(&key);

        if let Err(message) = result {
            return Err(IpcError::new("dependency-install-failed", message));
        }

        let readiness = compute_readiness().await;
        state.session_manager.emit_readiness_changed(&readiness);
        Ok(Value::Null)
    })
}

#[cfg(test)]
mod tests;
