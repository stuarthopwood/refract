// The token is never logged or stored, and non-github.com accounts are refused first.
// Concurrent callers share one request (`FETCH_LOCK`).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};
use serde_json::Value;

use super::cli::{auth_status, auth_token};
use super::profile::{collect_bounded, describe_request_error, HTTP_CLIENT};

const API_URL: &str = "https://api.github.com/copilot_internal/user";
const SUPPORTED_AUTH_HOST: &str = "github.com";
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const FAILURE_CACHE_TTL: Duration = Duration::from_secs(30);

struct CacheEntry {
    login: String,
    fetched_at: Instant,
    outcome: Outcome,
}

/// Only `Failed` is retried on the short TTL; an unmetered account is a stable answer.
#[derive(Clone, Copy)]
enum Outcome {
    Figure(PlanSnapshot),
    Unmetered,
    Failed,
}

impl Outcome {
    fn snapshot(self) -> Option<PlanSnapshot> {
        match self {
            Outcome::Figure(s) => Some(s),
            Outcome::Unmetered | Outcome::Failed => None,
        }
    }
}

/// Figures of the same cached response; entitlement and remaining are in AI-credit units.
/// Either is `None` when the response omits it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanSnapshot {
    pub percent_used: f64,
    pub entitlement: Option<f64>,
    pub remaining: Option<f64>,
}

/// Percent used plus the entitlement and remaining figures; `None` exactly when
/// `parse_percent_used` is.
pub fn parse_snapshot(body: &Value) -> Option<PlanSnapshot> {
    let percent_used = parse_percent_used(body)?;
    let snapshot = body.get("quota_snapshots")?.get("premium_interactions")?;
    let figure = |key: &str| {
        snapshot
            .get(key)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
    };
    Some(PlanSnapshot {
        percent_used,
        entitlement: figure("entitlement"),
        remaining: figure("quota_remaining"),
    })
}

static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);
static FETCH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Percent of the premium allowance used (0-100), or `None` when unmetered or unreadable.
/// Prefers `1 - quota_remaining / entitlement`, else `100 - percent_remaining`.
pub fn parse_percent_used(body: &Value) -> Option<f64> {
    let snapshot = body.get("quota_snapshots")?.get("premium_interactions")?;
    if snapshot.get("unlimited").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let entitlement = snapshot.get("entitlement").and_then(Value::as_f64);
    let remaining = snapshot.get("quota_remaining").and_then(Value::as_f64);
    let percent = match (entitlement, remaining) {
        (Some(e), Some(r)) if e > 0.0 => (1.0 - r / e) * 100.0,
        _ => 100.0 - snapshot.get("percent_remaining").and_then(Value::as_f64)?,
    };
    percent.is_finite().then_some(percent.clamp(0.0, 100.0))
}

/// The active github.com account's plan usage, cached; `None` = unavailable.
pub async fn plan_percent_used() -> Option<f64> {
    plan_snapshot().await.map(|s| s.percent_used)
}

/// Same cache and single request as `plan_percent_used`, plus entitlement and remaining.
pub async fn plan_snapshot() -> Option<PlanSnapshot> {
    let login = auth_status()
        .await
        .ok()?
        .into_iter()
        .find(|e| e.active && e.host == SUPPORTED_AUTH_HOST && e.problem.is_none())?
        .login;
    if let Some(cached) = cached(&login) {
        return cached;
    }
    let _single_flight = FETCH_LOCK.lock().await;
    if let Some(cached) = cached(&login) {
        return cached;
    }
    let fetched = fetch(&login).await;
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(CacheEntry {
        login,
        fetched_at: Instant::now(),
        outcome: fetched,
    });
    fetched.snapshot()
}

fn cached(login: &str) -> Option<Option<PlanSnapshot>> {
    let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .filter(|e| {
            let ttl = match e.outcome {
                Outcome::Failed => FAILURE_CACHE_TTL,
                Outcome::Figure(_) | Outcome::Unmetered => CACHE_TTL,
            };
            e.login == login && e.fetched_at.elapsed() < ttl
        })
        .map(|e| e.outcome.snapshot())
}

async fn fetch(login: &str) -> Outcome {
    match fetch_body(login).await {
        None => Outcome::Failed,
        Some(body) => parse_snapshot(&body).map_or(Outcome::Unmetered, Outcome::Figure),
    }
}

async fn fetch_body(login: &str) -> Option<Value> {
    let token = auth_token(SUPPORTED_AUTH_HOST, login).await.ok()?;
    let mut auth_header =
        reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")).ok()?;
    auth_header.set_sensitive(true);
    let response = HTTP_CLIENT
        .get(API_URL)
        .header(AUTHORIZATION, auth_header)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, "Refract")
        .send()
        .await
        .map_err(|err| log::debug!("{}", describe_request_error(&err, "Copilot plan usage")))
        .ok()?;
    if response.status().as_u16() != 200 {
        log::debug!(
            "copilot plan usage: status {}, treated as unavailable",
            response.status().as_u16()
        );
        return None;
    }
    let body = collect_bounded(response, MAX_RESPONSE_BYTES).await.ok()?;
    serde_json::from_slice::<Value>(&body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(extra: Value) -> Value {
        let mut premium = json!({ "unlimited": false });
        premium
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({ "quota_snapshots": { "premium_interactions": premium } })
    }

    #[test]
    fn prefers_the_precise_remaining_over_entitlement() {
        let body = snapshot(
            json!({ "entitlement": 2_000_000.0, "quota_remaining": 1_981_588.9, "percent_remaining": 99 }),
        );
        let used = parse_percent_used(&body).unwrap();
        assert!((used - 0.92).abs() < 0.01);
    }

    #[test]
    fn falls_back_to_percent_remaining() {
        let body = snapshot(json!({ "percent_remaining": 40 }));
        assert_eq!(parse_percent_used(&body), Some(60.0));
    }

    #[test]
    fn unlimited_and_missing_are_unavailable() {
        assert_eq!(
            parse_percent_used(
                &json!({ "quota_snapshots": { "premium_interactions": { "unlimited": true, "percent_remaining": 100 } } })
            ),
            None
        );
        assert_eq!(parse_percent_used(&json!({ "quota_snapshots": {} })), None);
        assert_eq!(parse_percent_used(&json!({})), None);
    }

    #[test]
    fn clamps_to_the_zero_to_one_hundred_range() {
        let body = snapshot(json!({ "entitlement": 100.0, "quota_remaining": -50.0 }));
        assert_eq!(parse_percent_used(&body), Some(100.0));
    }
}
