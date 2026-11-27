// One `gh search prs` for many repos, after checking search's own small rate limit (#874).

use std::future::Future;
use std::path::Path;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use serde::Deserialize;

use super::gh::{gh_json, GhActor, GhError, GhErrorCode};
use super::gh_pull_requests::SearchQualifierFlag;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhSearchRepository {
    pub name_with_owner: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAcrossEntry {
    pub number: u64,
    pub title: String,
    pub state: String,
    #[serde(default)]
    pub is_draft: bool,
    pub author: GhActor,
    pub updated_at: String,
    pub repository: GhSearchRepository,
}

const ACROSS_FIELDS: &str = "number,title,state,isDraft,author,updatedAt,repository";

#[derive(Deserialize)]
struct RateLimitResponse {
    resources: RateLimitResources,
}

#[derive(Deserialize)]
struct RateLimitResources {
    search: RateLimitBucket,
}

#[derive(Deserialize)]
struct RateLimitBucket {
    remaining: u64,
}

/// A healthy rate-limit probe is trusted this long, so a list refresh does not probe each time (#1896).
const PROBE_TTL: Duration = Duration::from_secs(60);

enum Probe {
    Healthy,
    Exhausted,
    Failed,
}

/// Remembers when the search budget last probed healthy. The lock is held across the probe, so
/// concurrent refreshes share one `gh api rate_limit` instead of racing to each run their own.
struct SearchBudgetGate {
    healthy_at: Mutex<Option<Instant>>,
}

impl SearchBudgetGate {
    const fn new() -> Self {
        Self {
            healthy_at: Mutex::const_new(None),
        }
    }

    /// Never caches an exhausted or failed probe; only a healthy one skips the next probes for the TTL.
    async fn ensure<C, P, F>(&self, clock: C, probe: P) -> Result<(), GhError>
    where
        C: Fn() -> Instant,
        P: FnOnce() -> F,
        F: Future<Output = Probe>,
    {
        let mut healthy_at = self.healthy_at.lock().await;
        let now = clock();
        if healthy_at.is_some_and(|at| now.saturating_duration_since(at) < PROBE_TTL) {
            return Ok(());
        }
        *healthy_at = None;
        match probe().await {
            Probe::Healthy => {
                *healthy_at = Some(now);
                Ok(())
            }
            Probe::Failed => Ok(()),
            Probe::Exhausted => Err(GhError::new(
                GhErrorCode::RateLimited,
                "GitHub's search rate limit is used up. Try again in a minute.",
            )),
        }
    }

    async fn invalidate(&self) {
        *self.healthy_at.lock().await = None;
    }
}

static SEARCH_BUDGET: SearchBudgetGate = SearchBudgetGate::new();

async fn probe_search_budget(cwd: &Path) -> Probe {
    match gh_json::<RateLimitResponse>(cwd, &["api", "rate_limit"]).await {
        Ok(limits) if limits.resources.search.remaining == 0 => Probe::Exhausted,
        Ok(_) => Probe::Healthy,
        Err(_) => Probe::Failed,
    }
}

/// Refuses before searching when the search budget is spent; a probe failure is not an error.
/// A healthy result is reused for 60 s.
pub async fn ensure_search_budget(cwd: &Path) -> Result<(), GhError> {
    SEARCH_BUDGET
        .ensure(Instant::now, || probe_search_budget(cwd))
        .await
}

/// Call when a search hit a rate limit, so the next search probes again instead of trusting the cache.
pub async fn note_search_rate_limited() {
    SEARCH_BUDGET.invalidate().await;
}

/// One `gh search prs` with a `--repo` per slug; free text goes after `--`.
pub async fn search_across(
    cwd: &Path,
    slugs: &[String],
    qualifier_flag: Option<SearchQualifierFlag>,
    state: Option<&str>,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<GhAcrossEntry>, GhError> {
    let limit_arg = limit.to_string();
    let mut args: Vec<&str> = vec!["search", "prs"];
    for slug in slugs {
        args.push("--repo");
        args.push(slug);
    }
    if let Some(flag) = qualifier_flag {
        args.push(flag.as_str());
        args.push("@me");
    }
    if let Some(state) = state {
        args.push("--state");
        args.push(state);
    }
    args.extend([
        "--sort",
        "updated",
        "--order",
        "desc",
        "--limit",
        &limit_arg,
        "--json",
        ACROSS_FIELDS,
    ]);
    if let Some(query) = query.filter(|q| !q.is_empty()) {
        args.push("--");
        args.push(query);
    }
    gh_json(cwd, &args).await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use super::*;

    /// A clock the test advances by hand, so no test sleeps through the TTL.
    struct FakeClock {
        base: Instant,
        elapsed_secs: AtomicU64,
    }

    impl FakeClock {
        fn new() -> Self {
            Self {
                base: Instant::now(),
                elapsed_secs: AtomicU64::new(0),
            }
        }

        fn now(&self) -> Instant {
            self.base + Duration::from_secs(self.elapsed_secs.load(Ordering::SeqCst))
        }

        fn advance(&self, secs: u64) {
            self.elapsed_secs.fetch_add(secs, Ordering::SeqCst);
        }
    }

    async fn ensure_with(
        gate: &SearchBudgetGate,
        clock: &FakeClock,
        probes: &AtomicUsize,
        outcome: fn() -> Probe,
    ) -> Result<(), GhError> {
        gate.ensure(
            || clock.now(),
            || async {
                probes.fetch_add(1, Ordering::SeqCst);
                outcome()
            },
        )
        .await
    }

    #[tokio::test]
    async fn two_calls_inside_the_ttl_probe_once() {
        let (gate, clock, probes) = (
            SearchBudgetGate::new(),
            FakeClock::new(),
            AtomicUsize::new(0),
        );
        ensure_with(&gate, &clock, &probes, || Probe::Healthy)
            .await
            .unwrap();
        clock.advance(59);
        ensure_with(&gate, &clock, &probes, || Probe::Healthy)
            .await
            .unwrap();
        assert_eq!(probes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_call_after_the_ttl_probes_again() {
        let (gate, clock, probes) = (
            SearchBudgetGate::new(),
            FakeClock::new(),
            AtomicUsize::new(0),
        );
        ensure_with(&gate, &clock, &probes, || Probe::Healthy)
            .await
            .unwrap();
        clock.advance(60);
        ensure_with(&gate, &clock, &probes, || Probe::Healthy)
            .await
            .unwrap();
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_call_after_a_rate_limit_error_probes_again_inside_the_ttl() {
        let (gate, clock, probes) = (
            SearchBudgetGate::new(),
            FakeClock::new(),
            AtomicUsize::new(0),
        );
        ensure_with(&gate, &clock, &probes, || Probe::Healthy)
            .await
            .unwrap();
        gate.invalidate().await;
        clock.advance(1);
        ensure_with(&gate, &clock, &probes, || Probe::Healthy)
            .await
            .unwrap();
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_exhausted_budget_is_refused_and_never_cached() {
        let (gate, clock, probes) = (
            SearchBudgetGate::new(),
            FakeClock::new(),
            AtomicUsize::new(0),
        );
        let err = ensure_with(&gate, &clock, &probes, || Probe::Exhausted)
            .await
            .unwrap_err();
        assert_eq!(err.code, GhErrorCode::RateLimited);
        ensure_with(&gate, &clock, &probes, || Probe::Healthy)
            .await
            .unwrap();
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_failed_probe_is_allowed_through_but_never_cached() {
        let (gate, clock, probes) = (
            SearchBudgetGate::new(),
            FakeClock::new(),
            AtomicUsize::new(0),
        );
        ensure_with(&gate, &clock, &probes, || Probe::Failed)
            .await
            .unwrap();
        ensure_with(&gate, &clock, &probes, || Probe::Failed)
            .await
            .unwrap();
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_probe() {
        let (gate, clock, probes) = (
            SearchBudgetGate::new(),
            FakeClock::new(),
            AtomicUsize::new(0),
        );
        let slow = || async {
            probes.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Probe::Healthy
        };
        let results = tokio::join!(
            gate.ensure(|| clock.now(), slow),
            gate.ensure(|| clock.now(), slow),
            gate.ensure(|| clock.now(), slow),
        );
        assert!(results.0.is_ok() && results.1.is_ok() && results.2.is_ok());
        assert_eq!(probes.load(Ordering::SeqCst), 1);
    }
}
