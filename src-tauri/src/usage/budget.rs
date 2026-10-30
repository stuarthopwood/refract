// Spec 060 (S1-13): the Budget card. The Copilot row comes from the #1238 quota fetch
// (`plan_snapshot`) plus a burn rate from our own `usage.db`; every other provider row comes from
// `omp usage --json`, run by argv (no shell) with a 10 s timeout. Results are cached for five
// minutes. A missing or failing `omp` degrades to an `unavailable` reason, never an error.

use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

use super::credits::COPILOT_PROVIDER;
use super::timeutil::{next_month_start, parse_iso_ms, DAY_MS};
use crate::github::copilot_plan::{plan_snapshot, PlanSnapshot};
use crate::process::executables::resolve_omp;

const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const OMP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const BURN_WINDOW_DAYS: i64 = 7;
/// Below this much Copilot history a burn rate would be noise.
const MIN_BURN_HISTORY_MS: i64 = DAY_MS;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotBudget {
    pub percent_used: f64,
    pub credits_used: Option<f64>,
    pub entitlement: Option<f64>,
    pub remaining: Option<f64>,
    /// Epoch ms of the next quota reset.
    pub resets_at: i64,
    pub burn_per_day: Option<f64>,
    /// Epoch ms the quota would run out at the current burn rate, when that is before the reset.
    pub cap_date: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBudget {
    pub provider: String,
    pub label: String,
    pub used: f64,
    pub limit: Option<f64>,
    pub unit: String,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub copilot: Option<CopilotBudget>,
    pub providers: Vec<ProviderBudget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<String>,
}

static CACHE: Mutex<Option<(Instant, Budget)>> = Mutex::new(None);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The Budget card data; cached for five minutes.
pub async fn budget() -> Budget {
    if let Some((at, cached)) = CACHE.lock().ok().and_then(|g| g.clone()) {
        if at.elapsed() < CACHE_TTL {
            return cached;
        }
    }
    let now = now_ms();
    let (snapshot, usage) = tokio::join!(plan_snapshot(), run_omp_usage());
    let (parsed, unavailable) = match usage {
        Ok(value) => (parse_usage(&value), None),
        Err(reason) => (ParsedUsage::default(), Some(reason)),
    };
    let copilot =
        snapshot.map(|s| copilot_row(&s, parsed.copilot_resets_at, burn_per_day(now), now));
    let result = Budget {
        copilot,
        providers: parsed.providers,
        unavailable,
    };
    if result.copilot.is_some() || result.unavailable.is_none() {
        if let Ok(mut guard) = CACHE.lock() {
            *guard = Some((Instant::now(), result.clone()));
        }
    }
    result
}

fn copilot_row(
    snapshot: &PlanSnapshot,
    resets_at: Option<i64>,
    burn_per_day: Option<f64>,
    now: i64,
) -> CopilotBudget {
    let resets_at = resets_at.unwrap_or_else(|| next_month_start(now));
    let credits_used = match (snapshot.entitlement, snapshot.remaining) {
        (Some(entitlement), Some(remaining)) => Some((entitlement - remaining).max(0.0)),
        _ => None,
    };
    CopilotBudget {
        percent_used: snapshot.percent_used,
        credits_used,
        entitlement: snapshot.entitlement,
        remaining: snapshot.remaining,
        resets_at,
        burn_per_day,
        cap_date: cap_date(now, snapshot.remaining, burn_per_day, resets_at),
    }
}

/// When `remaining` credits run out at `burn_per_day`, if that happens before the reset.
pub fn cap_date(
    now: i64,
    remaining: Option<f64>,
    burn: Option<f64>,
    resets_at: i64,
) -> Option<i64> {
    let (remaining, burn) = (remaining?, burn?);
    if burn <= 0.0 || remaining < 0.0 {
        return None;
    }
    let at = now.checked_add(((remaining / burn) * DAY_MS as f64) as i64)?;
    (at < resets_at).then_some(at)
}

/// Mean Copilot credits per day over the last seven days (or the history we have), `None` with
/// under a day of Copilot data or when `usage.db` is unavailable.
fn burn_per_day(now: i64) -> Option<f64> {
    let conn = super::open_reader().ok()?;
    let first: Option<i64> = conn
        .query_row(
            "SELECT min(ts) FROM messages WHERE provider = ?1",
            [COPILOT_PROVIDER],
            |r| r.get(0),
        )
        .ok()?;
    let since = now - BURN_WINDOW_DAYS * DAY_MS;
    let credits: f64 = conn
        .query_row(
            "SELECT coalesce(sum(credits), 0) FROM messages WHERE provider = ?1 AND ts >= ?2",
            rusqlite::params![COPILOT_PROVIDER, since],
            |r| r.get(0),
        )
        .ok()?;
    burn_rate(first?, now, credits)
}

pub fn burn_rate(first_ts: i64, now: i64, credits_in_window: f64) -> Option<f64> {
    let history = now - first_ts;
    if history < MIN_BURN_HISTORY_MS {
        return None;
    }
    let days = history.min(BURN_WINDOW_DAYS * DAY_MS) as f64 / DAY_MS as f64;
    Some(credits_in_window / days)
}

#[derive(Debug, Default)]
struct ParsedUsage {
    providers: Vec<ProviderBudget>,
    copilot_resets_at: Option<i64>,
}

/// Reads the `reports[].limits[]` of `omp usage --json`. A limit that does not parse is dropped;
/// the Copilot report only contributes its reset time (its row comes from the quota fetch).
fn parse_usage(value: &Value) -> ParsedUsage {
    let mut out = ParsedUsage::default();
    let reports = value.get("reports").and_then(Value::as_array);
    for report in reports.into_iter().flatten() {
        let Some(provider) = report.get("provider").and_then(Value::as_str) else {
            continue;
        };
        let is_copilot = provider == COPILOT_PROVIDER;
        if is_copilot {
            out.copilot_resets_at = report
                .get("metadata")
                .and_then(|m| m.get("quotaResetDate"))
                .and_then(Value::as_str)
                .and_then(parse_iso_ms);
        }
        for limit in report
            .get("limits")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let resets_at = limit
                .get("window")
                .and_then(|w| w.get("resetsAt"))
                .and_then(Value::as_f64)
                .map(|t| t as i64);
            if is_copilot {
                out.copilot_resets_at = resets_at.or(out.copilot_resets_at);
                continue;
            }
            let Some(amount) = limit.get("amount") else {
                continue;
            };
            let Some(used) = amount.get("used").and_then(Value::as_f64) else {
                continue;
            };
            out.providers.push(ProviderBudget {
                provider: provider.to_string(),
                label: limit
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or(provider)
                    .to_string(),
                used,
                limit: amount.get("limit").and_then(Value::as_f64),
                unit: amount
                    .get("unit")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                resets_at,
            });
        }
    }
    out
}

/// Runs `omp usage --json`. The error text is the user-facing `unavailable` reason.
async fn run_omp_usage() -> Result<Value, String> {
    let omp = resolve_omp().map_err(|_| "omp was not found".to_string())?;
    let mut command = Command::new(&omp);
    command
        .args(["usage", "--json"])
        .current_dir(crate::data_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW.0);
    let output = tokio::time::timeout(OMP_TIMEOUT, command.output())
        .await
        .map_err(|_| "omp usage timed out".to_string())?
        .map_err(|e| format!("omp usage could not start: {e}"))?;
    if !output.status.success() {
        return Err("omp usage failed".to_string());
    }
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return Err("omp usage output was too large".to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "omp usage output was unreadable".to_string())
}
