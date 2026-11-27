// State of the `gh-stack` extension: probe, pinned-version floor, install, and the in-memory
// per-repository "stacks unavailable" set (#1867, spec 132). Nothing here touches disk.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::gh::{gh_raw, map_gh_failure, GhError, GhErrorCode, GhRawResult};
use crate::updates::gh_stack_install::{install_gh_stack, GH_STACK_PINNED_TAG};

/// The pinned release is the floor: older (v0.1.0 reports exit 9 "stacks unavailable" falsely,
/// which would wrongly trip the per-repository fallback) is `Outdated`. A newer build stays
/// `Ready`, because the pinned install never downgrades it.
fn pinned_version() -> (u32, u32, u32) {
    parse_version(GH_STACK_PINNED_TAG).expect("GH_STACK_PINNED_TAG is a vX.Y.Z tag")
}
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Settings and the Merge dialog both ask; one probe serves them both.
const STATE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GhStackState {
    Ready,
    Missing,
    Outdated,
}

/// Extracts the first `x.y.z` (optionally `v`-prefixed) from `gh stack --version` output, which
/// reads `gh stack version 0.3.0`.
pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    text.split_whitespace().find_map(|token| {
        let mut parts = token.trim_start_matches('v').split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        parts.next().is_none().then_some((major, minor, patch))
    })
}

/// A failure that is neither "extension missing" nor "flag unknown to an old build" is returned as
/// an error so a transient problem never prompts an install.
pub fn classify_probe(result: &GhRawResult) -> Result<GhStackState, GhError> {
    if result.timed_out {
        return Err(GhError::new(
            GhErrorCode::Timeout,
            "Checking for gh-stack timed out.",
        ));
    }
    let stderr = result.stderr.to_lowercase();
    if result.code != 0 {
        if stderr.contains("unknown command") {
            return Ok(GhStackState::Missing);
        }
        // Early builds have no `--version` flag at all.
        if stderr.contains("unknown flag") {
            return Ok(GhStackState::Outdated);
        }
        return Err(map_gh_failure(&result.stderr, &result.stdout));
    }
    Ok(match parse_version(&result.stdout) {
        Some(version) if version >= pinned_version() => GhStackState::Ready,
        // An unreadable version is treated as old: behave as off and offer the upgrade.
        _ => GhStackState::Outdated,
    })
}

/// Stack rules apply only with the toggle on and `gh stack` ready; a probe error is "off".
pub fn stack_rules_enabled(setting_on: bool, state: &Result<GhStackState, GhError>) -> bool {
    setting_on && matches!(state, Ok(GhStackState::Ready))
}

/// Process-lifetime memory: the probe cache and the repositories where GitHub answered "stacks
/// unavailable". Empty at launch, so the first probe of a run is always a fresh one.
#[derive(Default)]
pub struct GhStackRuntime {
    cached: Mutex<Option<(Instant, GhStackState)>>,
    unavailable_repos: Mutex<HashSet<(String, String)>>,
}

impl GhStackRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    fn cached_state(&self, now: Instant) -> Option<GhStackState> {
        let cached = self.cached.lock().expect("gh-stack cache lock poisoned");
        cached
            .filter(|(at, _)| now.duration_since(*at) < STATE_TTL)
            .map(|(_, state)| state)
    }

    fn store_state(&self, state: GhStackState, now: Instant) {
        *self.cached.lock().expect("gh-stack cache lock poisoned") = Some((now, state));
    }

    /// Install and upgrade change the answer, so a stale `Missing` must not outlive them.
    pub fn invalidate(&self) {
        *self.cached.lock().expect("gh-stack cache lock poisoned") = None;
    }

    pub fn mark_unavailable(&self, owner: &str, repo: &str) {
        self.unavailable_repos
            .lock()
            .expect("gh-stack unavailable set lock poisoned")
            .insert(key(owner, repo));
    }

    pub fn is_unavailable(&self, owner: &str, repo: &str) -> bool {
        self.unavailable_repos
            .lock()
            .expect("gh-stack unavailable set lock poisoned")
            .contains(&key(owner, repo))
    }
}

/// GitHub owner and repository names are case-insensitive.
fn key(owner: &str, repo: &str) -> (String, String) {
    (owner.to_lowercase(), repo.to_lowercase())
}

static RUNTIME: LazyLock<GhStackRuntime> = LazyLock::new(GhStackRuntime::new);

pub fn runtime() -> &'static GhStackRuntime {
    &RUNTIME
}

/// Neutral `cwd`: the probe and install are not repository-scoped.
fn neutral_cwd() -> PathBuf {
    std::env::temp_dir()
}

async fn probe() -> Result<GhStackState, GhError> {
    let result = gh_raw(&neutral_cwd(), &["stack", "--version"], None, PROBE_TIMEOUT).await?;
    classify_probe(&result)
}

/// The current state, from the short-lived cache when fresh. `gh` itself missing stays
/// `GhUnavailable`, distinct from the extension being missing.
pub async fn state(runtime: &GhStackRuntime) -> Result<GhStackState, GhError> {
    if let Some(state) = runtime.cached_state(Instant::now()) {
        return Ok(state);
    }
    let state = probe().await?;
    runtime.store_state(state, Instant::now());
    Ok(state)
}

/// Installs (`Missing`) or replaces (`Outdated`) gh-stack at the pinned tag through the same
/// path as the installer, then re-probes. A failure leaves the state as it was.
pub async fn install(runtime: &GhStackRuntime) -> Result<GhStackState, GhError> {
    runtime.invalidate();
    if probe().await? != GhStackState::Ready {
        install_gh_stack(|_| {})
            .await
            .map_err(|detail| GhError::new(GhErrorCode::GhFailed, detail))?;
    }
    let state = probe().await?;
    runtime.store_state(state, Instant::now());
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(code: i32, stdout: &str, stderr: &str) -> GhRawResult {
        GhRawResult {
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            code,
            timed_out: false,
        }
    }

    fn version(text: &str) -> GhRawResult {
        run(0, &format!("gh stack version {text}\n"), "")
    }

    #[test]
    fn parse_version_reads_the_real_output_and_a_v_prefix() {
        assert_eq!(parse_version("gh stack version 0.3.0\n"), Some((0, 3, 0)));
        assert_eq!(parse_version("v1.12.4"), Some((1, 12, 4)));
        assert_eq!(parse_version("no digits here"), None);
        assert_eq!(parse_version("0.3"), None);
        assert_eq!(parse_version("0.3.0.1"), None);
    }

    #[test]
    fn version_floor_is_inclusive_and_numeric() {
        assert_eq!(
            classify_probe(&version("0.1.0")).unwrap(),
            GhStackState::Outdated
        );
        assert_eq!(
            classify_probe(&version("0.2.9")).unwrap(),
            GhStackState::Outdated
        );
        assert_eq!(
            classify_probe(&version("0.3.0")).unwrap(),
            GhStackState::Ready
        );
        // 0.10.0 sorts before 0.3.0 as text; it must compare as a number.
        assert_eq!(
            classify_probe(&version("0.10.0")).unwrap(),
            GhStackState::Ready
        );
        assert_eq!(
            classify_probe(&version("1.0.0")).unwrap(),
            GhStackState::Ready
        );
    }

    #[test]
    fn an_unreadable_version_is_outdated() {
        let result = run(0, "gh stack\n", "");
        assert_eq!(classify_probe(&result).unwrap(), GhStackState::Outdated);
    }

    #[test]
    fn unknown_command_means_the_extension_is_missing() {
        let result = run(1, "", "unknown command \"stack\" for \"gh\"\n");
        assert_eq!(classify_probe(&result).unwrap(), GhStackState::Missing);
    }

    #[test]
    fn a_build_without_the_version_flag_is_outdated() {
        let result = run(1, "", "unknown flag: --version\n");
        assert_eq!(classify_probe(&result).unwrap(), GhStackState::Outdated);
    }

    #[test]
    fn an_unrelated_failure_is_an_error_not_a_prompt() {
        let result = run(1, "", "error connecting to api.github.com\n");
        assert!(classify_probe(&result).is_err());
    }

    #[test]
    fn a_timed_out_probe_is_a_timeout_error() {
        let mut result = run(1, "", "");
        result.timed_out = true;
        let err = classify_probe(&result).unwrap_err();
        assert_eq!(err.code, GhErrorCode::Timeout);
    }

    #[test]
    fn the_floor_is_the_pinned_tag_and_newer_builds_stay_ready() {
        let pinned = pinned_version();
        assert_eq!(
            classify_probe(&version(&format!("{}.{}.{}", pinned.0, pinned.1, pinned.2))).unwrap(),
            GhStackState::Ready
        );
        assert_eq!(
            classify_probe(&version(&format!(
                "{}.{}.{}",
                pinned.0,
                pinned.1 + 1,
                pinned.2
            )))
            .unwrap(),
            GhStackState::Ready
        );
        assert_eq!(
            classify_probe(&version(&format!(
                "{}.{}.{}",
                pinned.0,
                pinned.1,
                pinned.2 + 1
            )))
            .unwrap(),
            GhStackState::Ready
        );
    }

    #[test]
    fn a_build_below_the_pinned_tag_is_outdated() {
        let pinned = pinned_version();
        assert!(
            pinned.2 > 0 || pinned.1 > 0,
            "the pin must have a lower neighbour"
        );
        let below = if pinned.2 > 0 {
            (pinned.0, pinned.1, pinned.2 - 1)
        } else {
            (pinned.0, pinned.1 - 1, 99)
        };
        assert_eq!(
            classify_probe(&version(&format!("{}.{}.{}", below.0, below.1, below.2))).unwrap(),
            GhStackState::Outdated
        );
    }
    #[test]
    fn stack_rules_need_the_toggle_and_a_ready_probe() {
        let err = || Err(GhError::new(GhErrorCode::Timeout, "t"));
        assert!(stack_rules_enabled(true, &Ok(GhStackState::Ready)));
        assert!(!stack_rules_enabled(false, &Ok(GhStackState::Ready)));
        assert!(!stack_rules_enabled(true, &Ok(GhStackState::Missing)));
        assert!(!stack_rules_enabled(true, &Ok(GhStackState::Outdated)));
        assert!(!stack_rules_enabled(true, &err()));
    }

    #[test]
    fn a_fresh_runtime_has_no_unavailable_repositories() {
        let runtime = GhStackRuntime::new();
        assert!(!runtime.is_unavailable("octo", "widgets"));
    }

    #[test]
    fn unavailable_is_per_repository_and_ignores_case() {
        let runtime = GhStackRuntime::new();
        runtime.mark_unavailable("Octo", "Widgets");
        assert!(runtime.is_unavailable("octo", "widgets"));
        assert!(!runtime.is_unavailable("octo", "gadgets"));
        assert!(!runtime.is_unavailable("other", "widgets"));
    }

    #[test]
    fn the_cached_state_expires_and_invalidate_clears_it() {
        let runtime = GhStackRuntime::new();
        let start = Instant::now();
        assert_eq!(runtime.cached_state(start), None);

        runtime.store_state(GhStackState::Missing, start);
        assert_eq!(
            runtime.cached_state(start + Duration::from_secs(1)),
            Some(GhStackState::Missing)
        );
        assert_eq!(runtime.cached_state(start + STATE_TTL), None);

        runtime.invalidate();
        assert_eq!(runtime.cached_state(start), None);
    }

    #[test]
    fn state_serialises_lowercase() {
        assert_eq!(
            serde_json::to_value(GhStackState::Outdated).unwrap(),
            "outdated"
        );
    }
}
