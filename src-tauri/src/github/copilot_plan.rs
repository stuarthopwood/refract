// Issue #1238 (spec 004 FR-051): the user's INDIVIDUAL Copilot plan usage, one read-only
// `GET https://api.github.com/copilot_internal/user` with the ACTIVE github.com `gh` account's
// token (`cli::auth_token`), mirroring `profile::fetch_profile`'s discipline: the token lives only
// in this function's local scope for that one request (header marked sensitive), is never logged,
// stored or sent to the renderer; a non-github.com account is refused before its token is read;
// redirects are never followed (`profile::HTTP_CLIENT`), the body is size-capped and the request
// times out at 10 s. Any failure reads as "unavailable" (`None`), never an error the UI shows.
//
// The result is cached (per login) so a chip re-mounting or a busy Session never re-calls GitHub
// more than once per window: `CACHE_TTL` after a figure, the shorter `FAILURE_CACHE_TTL` after an
// unavailable result so a flaky network recovers soon without hammering GitHub. Concurrent callers
// share one request (`FETCH_LOCK`).

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
    percent_used: Option<f64>,
}

static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);
static FETCH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Percent of the individual premium allowance used (0-100), or `None` when the account has no
/// metered allowance (unlimited, missing snapshot, or unreadable figures). Prefers the precise
/// `1 - quota_remaining / entitlement`; falls back to `100 - percent_remaining`.
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
        percent_used: fetched,
    });
    fetched
}

fn cached(login: &str) -> Option<Option<f64>> {
    let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .filter(|e| {
            let ttl = if e.percent_used.is_some() { CACHE_TTL } else { FAILURE_CACHE_TTL };
            e.login == login && e.fetched_at.elapsed() < ttl
        })
        .map(|e| e.percent_used)
}

async fn fetch(login: &str) -> Option<f64> {
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
    parse_percent_used(&serde_json::from_slice::<Value>(&body).ok()?)
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
